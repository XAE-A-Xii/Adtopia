import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasHookJudge, judge, JUDGE_TIMEOUT_MS, pickCaption } from "@/lib/hookjudge";
import { createBrand, startCampaign } from "@/lib/pipeline";
import { insertCreative } from "@/lib/production";
import { save, store } from "@/lib/db";
import { useStore } from "@/lib/store";
import { sqliteConnection, sqliteStore } from "@/lib/store/sqlite";
import type { Concept } from "@/lib/strategy";

function freshSqlite() {
  const db = sqliteConnection();
  for (const table of ["events", "posts", "creatives", "monid_runs", "campaigns", "brands", "settings"]) {
    db.prepare(`delete from ${table}`).run();
  }
  return sqliteStore();
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function configureJudgeEnv() {
  vi.stubEnv("HOOK_JUDGE_URL", "https://judge.modal.test/score");
  vi.stubEnv("HOOK_JUDGE_KEY", "wk-test-key");
  vi.stubEnv("HOOK_JUDGE_SECRET", "ws-test-secret");
}

function makeConcept(overrides: Partial<Concept> = {}): Concept {
  return {
    title: "Dog toy hook",
    format: "talking head broll",
    angle: "contrarian",
    platforms: ["tiktok"],
    hook: "Stop buying squeaky toys",
    creator: "pet owner",
    setting: "living room",
    shots: [],
    reference_images: [],
    caption: "Baseline caption from director",
    hashtags: ["#dogs", "#pettok"],
    cta: "Link in bio",
    inspired_by: [],
    why: "high outlier",
    ...overrides,
  };
}

beforeEach(() => {
  useStore(freshSqlite());
});

afterEach(() => {
  useStore(undefined);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("hookjudge client", () => {
  it("reports unconfigured when settings are missing and falls back to candidate 0", async () => {
    vi.stubEnv("HOOK_JUDGE_URL", "");
    vi.stubEnv("HOOK_JUDGE_KEY", "");
    vi.stubEnv("HOOK_JUDGE_SECRET", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(hasHookJudge()).toBe(false);
    const result = await pickCaption("dog toy", ["baseline", "challenger 1", "challenger 2"]);
    expect(result.caption).toBe("baseline");
    expect(result.index).toBe(0);
    expect(result.calls).toBe(0);
    expect(result.reason).toMatch(/not configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends prompt-independent { query, a, b } JSON with Modal-Key and Modal-Secret headers", async () => {
    configureJudgeEnv();
    expect(hasHookJudge()).toBe(true);

    let captured: { url: string; method: string; headers: Record<string, string>; body: string; hasSignal: boolean } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        captured = {
          url: String(url),
          method: init?.method ?? "GET",
          headers: init?.headers as Record<string, string>,
          body: String(init?.body ?? ""),
          hasSignal: Boolean(init?.signal),
        };
        return jsonResponse({ answer: "B" });
      }),
    );

    const answer = await judge("I tried dog toy", "First caption", "Second caption");
    expect(answer).toBe("B");
    expect(JUDGE_TIMEOUT_MS).toBe(20_000);
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://judge.modal.test/score");
    expect(captured!.method).toBe("POST");
    expect(captured!.headers["Modal-Key"]).toBe("wk-test-key");
    expect(captured!.headers["Modal-Secret"]).toBe("ws-test-secret");
    expect(captured!.headers["content-type"]).toBe("application/json");
    expect(captured!.hasSignal).toBe(true);
    expect(JSON.parse(captured!.body)).toEqual({ query: "I tried dog toy", a: "First caption", b: "Second caption" });
    expect(captured!.body).not.toContain("follower count");
  });

  it("requires a challenger to win in both A/B orders to beat the baseline", async () => {
    configureJudgeEnv();
    const pairs: Array<{ a: string; b: string }> = [];
    // Challenger 1 splits (position bias: judge always says "A"). Challenger 2 wins both ("B", then "A").
    const answers = ["A", "A", "B", "A"];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const parsed = JSON.parse(String(init?.body ?? "{}")) as { a: string; b: string };
        pairs.push({ a: parsed.a, b: parsed.b });
        return jsonResponse({ answer: answers.shift() });
      }),
    );

    const picked = await pickCaption("dog toy", ["c0", "c1", "c2"]);
    expect(pairs).toEqual([
      { a: "c0", b: "c1" },
      { a: "c1", b: "c0" },
      { a: "c0", b: "c2" },
      { a: "c2", b: "c0" },
    ]);
    expect(picked).toMatchObject({ caption: "c2", index: 2, calls: 4 });
  });

  it("keeps baseline when challengers only win one order", async () => {
    configureJudgeEnv();
    // Always returns "B" regardless of order -> position bias, neither challenger wins both orders.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ answer: "B" })),
    );

    const picked = await pickCaption("dog toy", ["c0", "c1", "c2"]);
    expect(picked.caption).toBe("c0");
    expect(picked.index).toBe(0);
    expect(picked.calls).toBe(4);
    expect(picked.reason).toMatch(/baseline kept/i);
  });

  it("falls back to candidate 0 on HTTP errors or timeouts", async () => {
    configureJudgeEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "gpu busy" }, 503)),
    );
    const httpFallback = await pickCaption("dog toy", ["c0", "c1", "c2"]);
    expect(httpFallback.caption).toBe("c0");
    expect(httpFallback.index).toBe(0);
    expect(httpFallback.calls).toBe(1);
    expect(httpFallback.reason).toMatch(/503/);

    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("TimeoutError")));
          }),
      ),
    );
    const timeoutFallback = await pickCaption("dog toy", ["c0", "c1"], { timeoutMs: 15 });
    expect(timeoutFallback.caption).toBe("c0");
    expect(timeoutFallback.index).toBe(0);
    expect(timeoutFallback.calls).toBe(1);
    expect(timeoutFallback.reason).toMatch(/fallback/i);
  });
});

describe("insertCreative caption judge wiring", () => {
  it("keeps single-caption behaviour unchanged when the judge is not configured", async () => {
    vi.stubEnv("HOOK_JUDGE_URL", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const brandId = await createBrand("notconfigured.example");
    const campaignId = await startCampaign(brandId);
    const id = await insertCreative(campaignId, 0, makeConcept());

    const [row] = await store().find<{ caption: string }>("creatives", { id }, { limit: 1 });
    expect(row.caption).toBe("Baseline caption from director\n\n#dogs #pettok");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks Claude for 3 candidates, judges with the reference search query, and logs the pick", async () => {
    configureJudgeEnv();
    vi.stubEnv("ANTHROPIC_API_KEY", `test-anthropic-${Math.random()}`);

    const brandId = await createBrand("dogtoys.example");
    const campaignId = await startCampaign(brandId);
    const refUrl = "https://www.tiktok.com/@creator/video/123";
    await save("campaigns", campaignId, {
      plan_json: JSON.stringify({ content_queries: ["fallback main keyword"] }),
      research_json: JSON.stringify({
        videos: [{ url: refUrl, source: "tiktok_1" }],
        seo: { keywords: [{ keyword: "seo fallback" }] },
      }),
    });
    await store().insert("monid_runs", {
      id: "run_ref",
      campaign_id: campaignId,
      key: "tiktok_1",
      phase: "C",
      provider: "anyapi",
      endpoint: "/tiktok.search_keyword",
      input_json: JSON.stringify({ body: { query: "indestructible dog toy" } }),
      status: "done",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const judgeCalls: Array<{ query: string; a: string; b: string }> = [];
    // Candidate 1 loses; candidate 2 beats candidate 0 in both orders ("B", then "A").
    const judgeAnswers = ["A", "B", "B", "A"];
    let claudeCalls = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        if (target.includes("api.anthropic.com")) {
          claudeCalls += 1;
          return jsonResponse({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-haiku-5-5",
            content: [
              {
                type: "tool_use",
                id: "tool_1",
                name: "caption_candidates",
                input: {
                  captions: [
                    "Caption zero draft",
                    "Caption one challenger",
                    "Why my dog ignores every other toy now",
                  ],
                },
              },
            ],
            stop_reason: "tool_use",
            stop_details: null,
            usage: { input_tokens: 100, output_tokens: 50 },
          });
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; a: string; b: string };
        judgeCalls.push(body);
        return jsonResponse({ answer: judgeAnswers.shift() });
      }),
    );

    const id = await insertCreative(
      campaignId,
      0,
      makeConcept({
        reference: { id: "ref_1", url: refUrl, author: "creator", views: 10000, followers: 500, outlier: 20, format: "talking head", hook_mechanic: "contrarian" },
      }),
    );

    expect(claudeCalls).toBe(1);
    expect(judgeCalls).toHaveLength(4);
    expect(judgeCalls.every((c) => c.query === "indestructible dog toy")).toBe(true);

    const [row] = await store().find<{ caption: string }>("creatives", { id }, { limit: 1 });
    expect(row.caption).toBe("Why my dog ignores every other toy now\n\n#dogs #pettok");

    const events = await store().find<{ message: string }>("events", { campaign_id: campaignId });
    expect(events.some((e) => e.message.includes('query "indestructible dog toy"') && e.message.includes("candidate 3/3") && e.message.includes("4 calls"))).toBe(true);
  });

  it("falls back to the campaign main research keyword when the creative has no reference", async () => {
    configureJudgeEnv();
    vi.stubEnv("ANTHROPIC_API_KEY", `test-anthropic-${Math.random()}`);

    const brandId = await createBrand("nokeyword.example");
    const campaignId = await startCampaign(brandId);
    await save("campaigns", campaignId, {
      plan_json: JSON.stringify({ content_queries: ["gut health soda"] }),
      research_json: JSON.stringify({ videos: [], seo: { keywords: [{ keyword: "prebiotic soda" }] } }),
    });

    const queries: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes("api.anthropic.com")) {
          return jsonResponse({
            id: "msg_2",
            type: "message",
            role: "assistant",
            model: "claude-haiku-5-5",
            content: [
              {
                type: "tool_use",
                id: "tool_2",
                name: "caption_candidates",
                input: { captions: ["First", "Second", "Third"] },
              },
            ],
            stop_reason: "tool_use",
            stop_details: null,
            usage: { input_tokens: 50, output_tokens: 30 },
          });
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as { query: string };
        queries.push(body.query);
        return jsonResponse({ answer: "A" });
      }),
    );

    const id = await insertCreative(campaignId, 0, makeConcept({ hashtags: [] }));
    expect(queries).toHaveLength(4);
    expect(queries.every((q) => q === "gut health soda")).toBe(true);
    const [row] = await store().find<{ caption: string }>("creatives", { id }, { limit: 1 });
    expect(row.caption).toBe("First");
  });
});
