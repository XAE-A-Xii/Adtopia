import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as campaignPost } from "@/app/api/campaigns/[id]/route";
import { now, store } from "@/lib/db";
import { advanceLoop, DEFAULT_LOOP, saveLoop } from "@/lib/loop";
import { advanceCampaign, getCampaign } from "@/lib/pipeline";
import type { PostizIntegration } from "@/lib/postiz";
import { advancePosts, type PostRow, postStats, publishCampaign } from "@/lib/publish";
import { useStore } from "@/lib/store";
import { sqliteConnection, sqliteStore } from "@/lib/store/sqlite";
import type { Files } from "@/lib/store/types";

// Everything after "a video is ready": queueing, uploading the cut, posting/scheduling through
// Postiz, and the autopilot's next campaign. Real code throughout; only Postiz's HTTP is mocked.

const BRAND = "brd_post";
const CAMPAIGN = "cmp_post";
const POSTIZ_BASE = "https://postiz.test/public/v1";
const T0 = Date.parse("2026-11-08T05:00:00.000Z");
const M = 1_000_000;
const CUT = Buffer.from("a finished cut, as bytes");

let root = "";

type FakeCall = { method: string; path: string; auth: string | null; body: unknown };

function fakePostiz() {
  const state = {
    integrations: [{ id: "int_tt", name: "acme.agents", identifier: "tiktok" }] as PostizIntegration[],
    busy: { upload: 0, createPost: 0 },
    rejectCreate: null as string | null,
    calls: [] as FakeCall[],
    seq: 0,
  };

  const fetchStub: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.startsWith(POSTIZ_BASE) ? url.slice(POSTIZ_BASE.length) : url;
    const headers = new Headers(init?.headers);
    const auth = headers.get("Authorization");
    let body: unknown = null;
    if (init?.body instanceof FormData) {
      const file = init.body.get("file") as File | null;
      body = file ? { filename: file.name, type: file.type, size: file.size } : null;
    } else if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    state.calls.push({ method, path, auth, body });

    if (method === "GET" && path === "/integrations") {
      return new Response(JSON.stringify(state.integrations), { status: 200 });
    }
    if (method === "POST" && path === "/upload") {
      if (state.busy.upload > 0) {
        state.busy.upload -= 1;
        return new Response(JSON.stringify({ code: "rate_limited", message: "at capacity" }), { status: 429 });
      }
      const id = `med_${++state.seq}`;
      return new Response(JSON.stringify({ id, path: `https://uploads.postiz.com/${id}.mp4` }), { status: 201 });
    }
    if (method === "POST" && path === "/posts") {
      if (state.busy.createPost > 0) {
        state.busy.createPost -= 1;
        return new Response(JSON.stringify({ code: "rate_limited", message: "too many posts" }), { status: 429 });
      }
      if (state.rejectCreate) {
        return new Response(state.rejectCreate, { status: 400 });
      }
      const payload = body as { posts?: Array<{ integration?: { id?: string } }> };
      const results = (payload.posts ?? []).map((p) => ({
        postId: `pz_${++state.seq}`,
        integration: p.integration?.id ?? "unknown",
      }));
      return new Response(JSON.stringify(results), { status: 201 });
    }
    return new Response("not found", { status: 404 });
  };

  return {
    state,
    fetchStub,
    calls: (pattern: RegExp, method?: string) => state.calls.filter((c) => pattern.test(c.path) && (!method || c.method === method)),
  };
}

let fake: ReturnType<typeof fakePostiz>;

/** The store's files in a temp folder, the way production keeps the cut ("crv_…/final.mp4"). */
function tempFiles(dir: string): Files {
  const at = (key: string) => join(dir, key);
  return {
    async putFile(key, path) {
      await mkdir(dirname(at(key)), { recursive: true });
      await copyFile(path, at(key));
    },
    async saveUrl() {
      throw new Error("no downloads in this test");
    },
    async exists(key) {
      return existsSync(at(key));
    },
    async localPath(key) {
      return at(key);
    },
    async url(key) {
      return existsSync(at(key)) ? `/api/media/${key}` : null;
    },
  };
}

async function storeCut(creativeId: string) {
  const path = join(root, `${creativeId}-cut.mp4`);
  await writeFile(path, CUT);
  await store().files.putFile(`${creativeId}/final.mp4`, path, "video/mp4");
  return `${creativeId}/final.mp4`;
}

async function setCampaign(fields: Record<string, unknown>) {
  await store().update("campaigns", { id: CAMPAIGN }, fields);
}

let idx = 0;
type CreativeFields = { id?: string; status?: string; approved?: number; final_file_id?: string | null; final_key?: string | null; final_external_url?: string | null; platforms?: string[]; concept?: Record<string, unknown>; campaign?: string };
async function addCreative(fields: CreativeFields = {}) {
  const id = fields.id ?? `crv_${++idx}`;
  await store().insert("creatives", {
    id,
    campaign_id: fields.campaign ?? CAMPAIGN,
    idx: idx,
    generation: 1,
    concept_json: JSON.stringify(fields.concept ?? { title: "Deploy a company in 3 steps", format: "talking_head_broll", hook: "I gave an agent $3 and one skill file" }),
    shots_json: "[]",
    status: fields.status ?? "ready",
    caption: "Three steps to a running company.",
    platforms_json: JSON.stringify(fields.platforms ?? ["tiktok"]),
    approved: fields.approved ?? 1,
    rejected: 0,
    final_file_id: fields.final_file_id ?? null,
    final_key: fields.final_key ?? null,
    final_external_url: fields.final_external_url ?? null,
    created_at: now(),
    updated_at: now(),
  });
  return id;
}

const posts = () => store().find<PostRow>("posts", {}, { order: [["created_at", "asc"]] });
const creative = async (id: string) => (await store().find<{ final_file_id: string | null; final_external_url: string | null }>("creatives", { id }, { limit: 1 }))[0];
const messages = async () => (await store().events({ brand_id: BRAND, limit: 100 })).map((e) => e.message);
const creates = () => fake.calls(/^\/posts$/, "POST");

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "nomen-publish-"));
});
afterAll(async () => {
  useStore(undefined);
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  const db = sqliteConnection();
  for (const table of ["events", "posts", "creatives", "monid_runs", "campaigns", "brand_loops", "brands", "settings"]) db.prepare(`delete from ${table}`).run();
  useStore({ ...sqliteStore(), files: tempFiles(join(root, `files-${Math.random().toString(36).slice(2)}`)) });
  vi.stubEnv("POSTIZ_API_KEY", "pz_test_publish");
  vi.stubEnv("POSTIZ_BASE_URL", POSTIZ_BASE);
  fake = fakePostiz();
  vi.stubGlobal("fetch", fake.fetchStub);
  await store().insert("brands", { id: BRAND, name: "Acme", domain: "acme.ai", url: "https://acme.ai", created_at: now(), updated_at: now() });
  await store().insert("campaigns", {
    id: CAMPAIGN,
    brand_id: BRAND,
    status: "review",
    stage: "review",
    options_json: JSON.stringify({ concepts: 2, shotsPerConcept: 2, secondsPerShot: 8, videoModel: "google/veo-3.1", learnStyle: false }),
    created_at: now(),
    updated_at: now(),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("publishCampaign", () => {
  it("queues an approved video from its stored cut", async () => {
    const id = await addCreative({ final_key: await storeCut("crv_cut") });
    expect(await publishCampaign(CAMPAIGN, "now")).toEqual({ queued: 1, skipped: [] });
    expect(await posts()).toMatchObject([{ creative_id: id, status: "pending", platforms_json: '["tiktok"]', scheduled_at: null }]);
  });

  it("never queues an internal remake, even approved, and says why", async () => {
    await addCreative({ final_external_url: "https://cdn.test/a.mp4", concept: { title: "Remake", internal: true } });
    await expect(publishCampaign(CAMPAIGN, "now")).rejects.toThrow("internal remakes");
    expect(await posts()).toEqual([]);

    // A remake brief without the flag is held too; a regular video next to them goes out alone.
    await addCreative({ final_external_url: "https://cdn.test/b.mp4", concept: { title: "Remake 2", brief: { format: "remake" } } });
    const regular = await addCreative({ final_external_url: "https://cdn.test/c.mp4" });
    expect(await publishCampaign(CAMPAIGN, "now")).toMatchObject({ queued: 1 });
    expect((await posts()).map((p) => p.creative_id)).toEqual([regular]);
    expect(await messages()).toContainEqual(expect.stringContaining("Held back 2 internal remakes"));
  });

  it("posts an internal remake once a named person cleared it", async () => {
    const id = await addCreative({ final_external_url: "https://cdn.test/a.mp4", concept: { title: "Remake", internal: true, cleared: { at: now(), by: "Reviewer", note: "licensed from the creator" } } });
    expect(await publishCampaign(CAMPAIGN, "now")).toMatchObject({ queued: 1 });
    expect((await posts())[0].creative_id).toBe(id);
  });

  it("leaves a campaign running while its other videos are still being made", async () => {
    await setCampaign({ status: "running", stage: "production" });
    await addCreative({ final_external_url: "https://cdn.test/a.mp4" });
    await addCreative({ status: "producing", approved: 0 });
    await publishCampaign(CAMPAIGN, "now");
    expect((await getCampaign(CAMPAIGN))!.status).toBe("running");
  });

  it("moves a reviewed campaign to publishing", async () => {
    await addCreative({ final_external_url: "https://cdn.test/a.mp4" });
    await publishCampaign(CAMPAIGN, "now");
    expect((await getCampaign(CAMPAIGN))!.status).toBe("publishing");
  });

  it("posts only the chosen video to the chosen network, privately when asked, with #AIgenerated fallback", async () => {
    fake.state.integrations = [
      { id: "int_tt", name: "acme.agents", identifier: "tiktok" },
      { id: "int_yt", name: "Acme", identifier: "youtube" },
    ];
    const chosen = await addCreative({ final_external_url: "https://cdn.test/a.mp4", platforms: ["tiktok", "youtube"] });
    await addCreative({ final_external_url: "https://cdn.test/b.mp4" });
    expect(await publishCampaign(CAMPAIGN, "now", { creativeIds: [chosen], platforms: ["youtube"], visibility: "private" })).toEqual({ queued: 1, skipped: [] });
    await advancePosts();
    expect(creates()).toHaveLength(1);
    expect(creates()[0].body).toMatchObject({
      type: "now",
      posts: [
        {
          integration: { id: "int_yt" },
          value: [{ content: "Three steps to a running company.\n\n#AIgenerated", image: [{ path: "https://cdn.test/a.mp4" }] }],
          settings: { __type: "youtube", title: "Deploy a company in 3 steps", type: "private" },
        },
      ],
    });
  });

  it("refuses a private post on a network that only posts publicly", async () => {
    await addCreative({ final_external_url: "https://cdn.test/a.mp4" });
    await expect(publishCampaign(CAMPAIGN, "now", { platforms: ["tiktok"], visibility: "private" })).rejects.toThrow(/YouTube/);
    expect(await posts()).toEqual([]);
  });

  it("refuses a network the brand has not connected", async () => {
    await addCreative({ final_external_url: "https://cdn.test/a.mp4" });
    await expect(publishCampaign(CAMPAIGN, "now", { platforms: ["youtube"] })).rejects.toThrow(/YouTube/);
  });
});

describe("the publish action", () => {
  const publish = (payload: unknown) => campaignPost(new Request(`http://localhost/api/campaigns/${CAMPAIGN}`, { method: "POST", body: JSON.stringify(payload) }), { params: Promise.resolve({ id: CAMPAIGN }) });

  it("passes the chosen video, network and visibility through", async () => {
    fake.state.integrations = [
      { id: "int_tt", name: "acme.agents", identifier: "tiktok" },
      { id: "int_yt", name: "Acme", identifier: "youtube" },
    ];
    const chosen = await addCreative({ final_external_url: "https://cdn.test/a.mp4" });
    await addCreative({ final_external_url: "https://cdn.test/b.mp4" });
    const response = await publish({ action: "publish", mode: "now", creativeIds: [chosen], platforms: ["youtube"], visibility: "private" });
    expect(await response.json()).toEqual({ queued: 1, skipped: [] });
    expect(await posts()).toMatchObject([{ creative_id: chosen, platforms_json: '["youtube"]', result_json: '{"request":{"visibility":"private"}}' }]);
  });

  it("refuses a visibility it does not know", async () => {
    await addCreative({ final_external_url: "https://cdn.test/a.mp4" });
    const response = await publish({ action: "publish", mode: "now", visibility: "secret" });
    expect(response.status).toBe(400);
    expect(await posts()).toEqual([]);
  });
});

describe("advancePosts", () => {
  it("uploads the stored cut first and posts that media to TikTok with video_made_with_ai", async () => {
    const id = await addCreative({ final_key: await storeCut("crv_cut") });
    await publishCampaign(CAMPAIGN, "now");
    await advancePosts();
    expect(fake.calls(/^\/upload$/, "POST")).toHaveLength(1);
    expect(creates()).toHaveLength(1);
    expect(creates()[0].auth).toBe("pz_test_publish");
    expect(creates()[0].body).toMatchObject({
      type: "now",
      shortLink: false,
      tags: [],
      posts: [
        {
          integration: { id: "int_tt" },
          value: [{ content: "Three steps to a running company.", image: [{ id: "med_1", path: "https://uploads.postiz.com/med_1.mp4" }] }],
          settings: { __type: "tiktok", video_made_with_ai: true },
        },
      ],
    });
    expect((await creative(id))).toMatchObject({ final_file_id: "med_1", final_external_url: "https://uploads.postiz.com/med_1.mp4" });
    expect((await posts())[0]).toMatchObject({ status: "posted", error: null });
    expect((await getCampaign(CAMPAIGN))!.status).toBe("live");
    expect(await messages()).toContainEqual("Posted to TikTok");
  });

  it("waits out Postiz rate limits on upload, then posts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    await addCreative({ final_key: await storeCut("crv_cut") });
    await publishCampaign(CAMPAIGN, "now");
    fake.state.busy.upload = 1;

    await advancePosts();
    expect((await posts())[0]).toMatchObject({ status: "pending", error: expect.stringContaining("Waiting for Postiz") });
    expect(creates()).toHaveLength(0);

    vi.setSystemTime(T0 + 5_000);
    await advancePosts();
    expect(fake.calls(/^\/upload$/, "POST")).toHaveLength(1);

    vi.setSystemTime(T0 + 61_000);
    await advancePosts();
    expect(fake.calls(/^\/upload$/, "POST")).toHaveLength(2);
    expect((await posts())[0]).toMatchObject({ status: "posted", error: null });
  });

  it("retries a post when Postiz returns 429", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    await addCreative({ final_external_url: "https://cdn.test/a.mp4" });
    await publishCampaign(CAMPAIGN, "now");
    fake.state.busy.createPost = 1;
    await advancePosts();
    expect((await posts())[0].status).toBe("pending");
    vi.setSystemTime(T0 + 61_000);
    await advancePosts();
    expect(creates()).toHaveLength(2);
    expect((await posts())[0]).toMatchObject({ status: "posted", error: null });
  });

  it("leaves a scheduled post as scheduled until it is due, then marks it posted", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0); // 05:00 UTC: the day's slot is 16:00
    await addCreative({ final_external_url: "https://cdn.test/a.mp4" });
    await publishCampaign(CAMPAIGN, "daily");
    await advancePosts();
    expect((await posts())[0].status).toBe("scheduled");
    expect(creates()[0].body).toMatchObject({ type: "schedule", date: "2026-11-08T16:00:00.000Z" });

    vi.setSystemTime(Date.parse("2026-11-08T12:00:00.000Z"));
    await advancePosts();
    expect((await posts())[0].status).toBe("scheduled");

    vi.setSystemTime(Date.parse("2026-11-08T16:01:00.000Z"));
    await advancePosts();
    expect((await posts())[0].status).toBe("posted");
  });

  it("stops a queued internal remake before it reaches Postiz", async () => {
    const id = await addCreative({ final_external_url: "https://cdn.test/a.mp4", concept: { title: "Remake", brief: { format: "remake" } } });
    await store().insert("posts", { id: "pst_old", creative_id: id, brand_id: BRAND, idem: "pst_old-publish", platforms_json: '["tiktok"]', status: "pending", created_at: now(), updated_at: now() });
    await advancePosts();
    expect(creates()).toHaveLength(0);
    expect((await posts())[0]).toMatchObject({ status: "failed", error: expect.stringContaining("internal remake") });
  });

  it("marks a post failed when Postiz rejects it with a 4xx error", async () => {
    await addCreative({ final_external_url: "https://cdn.test/a.mp4" });
    await publishCampaign(CAMPAIGN, "now");
    fake.state.rejectCreate = JSON.stringify({ code: "bad_request", message: "video too short" });
    await advancePosts();
    expect((await posts())[0]).toMatchObject({ status: "failed", error: expect.stringContaining("video too short") });
  });
});

describe("postStats", () => {
  it("adds up each network's numbers from provider-shaped analytics", () => {
    const analytics = { data: { tiktok: { analytics: { videoViews: 1000, likeCount: 30, commentsCount: 2, shareCount: 1 } }, youtube: { analytics: { views: 200, likes: 10, comments: 1 } } } };
    expect(postStats({ analytics_json: JSON.stringify(analytics), result_json: null })).toEqual({ url: null, views: 1200, likes: 40, comments: 3, shares: 1 });
  });

  it("takes a total over the breakdown under it, so nothing is counted twice", () => {
    const analytics = { data: { views: 500, likes: 9, daily: [{ views: 200, likes: 4 }, { views: 300, likes: 5 }] } };
    expect(postStats({ analytics_json: JSON.stringify(analytics), result_json: null })).toEqual({ url: null, views: 500, likes: 9 });
  });

  it("takes the latest snapshot of each network's running totals", () => {
    const snap = (profilePostId: string, createdAt: string, views: number, likes: number) => ({ id: `${profilePostId}-${createdAt}`, profilePostId, impressions: views * 2, impressionsUnique: views, views, viewsUnique: views, likes, dislikes: 0, comments: 1, shares: 0, saves: 0, raw: { like_count: likes }, forced: false, createdAt });
    const analytics = {
      data: {
        tiktok: { post: { id: "p1", status: "POSTED" }, items: [snap("pp_tt", "2026-11-08T17:00:00Z", 100, 5), snap("pp_tt", "2026-11-09T17:00:00Z", 340, 12)] },
        youtube: { post: { id: "p1", status: "POSTED" }, items: [snap("pp_yt", "2026-11-09T17:00:00Z", 60, 2), snap("pp_yt", "2026-11-08T17:00:00Z", 20, 1)] },
      },
    };
    expect(postStats({ analytics_json: JSON.stringify(analytics), result_json: null })).toEqual({ url: null, views: 400, likes: 14, comments: 2, shares: 0, saves: 0 });
  });

  it("falls back to the post's own metrics and link", () => {
    const post = { id: "spo_1", status: "posted", url: "https://youtu.be/x", metrics: { views: 12, likes: 1, comments: 0 } };
    expect(postStats({ analytics_json: null, result_json: JSON.stringify(post) })).toEqual({ url: "https://youtu.be/x", views: 12, likes: 1, comments: 0 });
  });
});

describe("autopilot, one full cycle", () => {
  it("schedules a finished campaign via Postiz and starts the next campaign once the slot passes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    await saveLoop(BRAND, { ...DEFAULT_LOOP, enabled: true, weekly_budget_micro: 300 * M, cadence_days: 1, autopost: true });
    await setCampaign({ status: "running", stage: "production", created_at: new Date(T0 - 2 * 86_400_000).toISOString(), strategy_json: JSON.stringify({ brand: {}, campaign: { concepts: [] } }) });
    await addCreative({ approved: 0, final_key: await storeCut("crv_done"), concept: { title: "We gave an agent $3", format: "talking_head_broll", hook: "I gave an AI agent $3 and one skill file" } });

    await advanceCampaign(CAMPAIGN);
    expect((await posts())[0]).toMatchObject({ status: "pending", scheduled_at: "2026-11-08T16:00:00.000Z" });
    await advancePosts();
    expect(creates()[0].body).toMatchObject({
      type: "schedule",
      date: "2026-11-08T16:00:00.000Z",
      posts: [{ integration: { id: "int_tt" }, settings: { __type: "tiktok", video_made_with_ai: true } }],
    });
    await advanceLoop(new Date());
    expect((await store().find("campaigns", { brand_id: BRAND })).length).toBe(1);
    expect(await messages()).toContainEqual(expect.stringContaining("Waiting for the last scheduled post (2026-11-08 16:00 UTC)"));

    vi.setSystemTime(Date.parse("2026-11-08T16:05:00.000Z"));
    await advancePosts();
    expect((await posts())[0].status).toBe("posted");

    vi.setSystemTime(Date.parse("2026-11-09T16:10:00.000Z"));
    await advanceLoop(new Date());
    const next = (await store().find<{ id: string; status: string }>("campaigns", { brand_id: BRAND }, { order: [["created_at", "asc"]] }))[1];
    expect(next).toMatchObject({ status: "running" });
    expect(await messages()).toContainEqual(expect.stringMatching(/^Autopilot started campaign 2\..*fits the \$300\.00 weekly budget/));
  });
});
