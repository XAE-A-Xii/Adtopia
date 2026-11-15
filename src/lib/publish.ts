import { readFile } from "node:fs/promises";
import { logEvent, newId, now, parse, save, store } from "./db";
import { ApiError } from "./http";
import { getBrand, getCampaign, listCreatives } from "./pipeline";
import { hasPostiz, integrations, type PostizIntegration, type PostizMedia, type PostizPostResult, schedule, upload } from "./postiz";
import type { CreativeRow } from "./production";
import { slug } from "./production";
import type { Concept } from "./strategy";

// Publishing to the brand's own accounts through Postiz. TikTok receives Postiz's native
// `video_made_with_ai` disclosure setting; other platforms lack a native AI-content flag in the
// Postiz public API schema, so `#AIgenerated` is appended to their caption instead.

export type PostRow = {
  id: string;
  creative_id: string;
  brand_id: string;
  idem: string;
  platforms_json: string;
  scheduled_at: string | null;
  status: "pending" | "scheduled" | "processing" | "posted" | "failed" | "deleted";
  /** Postiz submission results once submitted. Before that, request options ({ request: { visibility } }). */
  result_json: string | null;
  analytics_json: string | null;
  analytics_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type SocialAccount = { platform: string; name: string; id: string };

/** Networks Postiz can publish a video to here (Pinterest and Reddit need per-post board/subreddit fields). */
const VIDEO_PLATFORMS = new Set(["tiktok", "instagram", "youtube", "x", "facebook", "linkedin", "threads", "bluesky"]);

/** Who sees a post. Supported for YouTube (`public`/`unlisted`/`private`) and TikTok (`public`/`private`). */
export type Visibility = "public" | "unlisted" | "private";
export const VISIBILITIES: readonly Visibility[] = ["public", "unlisted", "private"];
const VISIBILITY_PLATFORMS = new Set(["youtube"]);

/** Narrows a publish: which approved videos, to which connected networks, seen by whom. */
export type PublishChoice = { creativeIds?: string[]; platforms?: string[]; visibility?: Visibility };

const PLATFORM_NAMES: Record<string, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube",
  x: "X",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  threads: "Threads",
  bluesky: "Bluesky",
};
const platformName = (platform: string) => PLATFORM_NAMES[platform] ?? platform;

function normalizePlatform(identifier: string): string {
  const lower = identifier.toLowerCase();
  if (lower === "instagram-standalone") return "instagram";
  if (lower === "linkedin-page") return "linkedin";
  return lower;
}

/** Link to Postiz where the brand's owner connects its social channels. */
export async function connectLink(brandId: string, _returnTo?: string) {
  const brand = await getBrand(brandId);
  if (!brand) throw new Error("No such brand");
  if (!hasPostiz()) throw new ApiError("postiz", 401, "not_configured", "Add a Postiz API key in Settings first.");
  await logEvent({ brandId, message: "Opened Postiz to connect accounts" });
  return "https://platform.postiz.com";
}

export async function connectedAccounts(_brandId: string): Promise<SocialAccount[]> {
  if (!hasPostiz()) return [];
  const raw = await integrations();
  return raw
    .filter((account) => !account.disabled)
    .map((account) => ({
      platform: normalizePlatform(account.identifier),
      name: account.name || account.profile || account.id,
      id: account.id,
    }));
}

/**
 * Why a video may not be posted, or null. One-to-one remakes copy a real creator's video and are
 * for internal review only: they are held unless a person explicitly cleared them. A video whose
 * concept can't be read can't be checked, so it is held too.
 */
export function postingHold(concept: Partial<Pick<Concept, "internal" | "cleared" | "brief" | "format">> | null): string | null {
  if (!concept) return "the video's concept is unreadable, so it can't be checked for posting";
  if (!isInternal(concept) || concept.cleared?.at) return null;
  return concept.brief?.format === "brainrot" ? "brainrot ad: not cleared for posting" : "internal remake: not cleared for posting";
}

/** An internal video: a one-to-one remake of a real creator's video (cleared or not). */
export function isInternal(concept: Partial<Pick<Concept, "internal" | "brief" | "format">> | null | undefined): boolean {
  return Boolean(concept && (concept.internal === true || (concept.format as string | undefined) === "remake" || concept.brief?.format === "remake" || concept.brief?.format === "brainrot"));
}

/** Clears one internal video for posting: an explicit decision by a named person, kept on the video and logged. */
export async function clearForPosting(creativeId: string, by: string, note: string) {
  if (!by.trim() || !note.trim()) throw new Error("Say who clears it and why.");
  const [creative] = await store().find<CreativeRow>("creatives", { id: creativeId }, { limit: 1 });
  if (!creative) throw new Error("No such video");
  const concept = parse<Concept | null>(creative.concept_json, null);
  if (!concept) throw new Error("The video's concept is unreadable");
  concept.cleared = { at: now(), by: by.trim(), note: note.trim() };
  await save("creatives", creativeId, { concept_json: JSON.stringify(concept) });
  const campaign = await getCampaign(creative.campaign_id);
  await logEvent({ brandId: campaign?.brand_id, campaignId: creative.campaign_id, level: "warn", message: `"${concept.title}" (internal) was cleared for posting by ${by.trim()}: ${note.trim()}` });
}

export async function approveAll(campaignId: string) {
  await store().update("creatives", { campaign_id: campaignId, status: "ready", rejected: 0 }, { approved: 1 });
}

/** The stored cut: recorded on the row, or where production keeps it ("crv_…/final.mp4"). */
const cutKey = (creative: CreativeRow) => creative.final_key || `${creative.id}/final.mp4`;

/** Whether there is something to post: the cut in the store or an external URL. */
async function hasMedia(creative: CreativeRow) {
  return Boolean(creative.final_external_url) || (await store().files.exists(cutKey(creative)));
}

/**
 * Queues approved videos for posting. `now` posts each one right away; `daily` spaces them one per
 * day at 16:00 UTC (morning in the Americas, evening in Europe), starting with the next slot.
 * `choice` narrows it to some videos, some of the connected networks, or a visibility (YouTube).
 */
export async function publishCampaign(campaignId: string, mode: "now" | "daily", choice: PublishChoice = {}) {
  const campaign = await getCampaign(campaignId);
  if (!campaign) throw new Error("No such campaign");
  const accounts = await connectedAccounts(campaign.brand_id);
  const connected = new Set(accounts.map((account) => account.platform).filter((platform) => VIDEO_PLATFORMS.has(platform)));
  if (connected.size === 0) throw new Error("Connect at least one of the brand's accounts in Postiz first.");
  const missing = (choice.platforms ?? []).filter((platform) => !connected.has(platform));
  if (missing.length) throw new Error(`Connect the brand's ${missing.map(platformName).join(" and ")} account in Postiz first.`);
  if (choice.visibility) {
    const publicOnly = (choice.platforms ?? [...connected]).filter((platform) => !VISIBILITY_PLATFORMS.has(platform));
    if (publicOnly.length) throw new Error(`Only YouTube posts can be ${choice.visibility}; ${publicOnly.map(platformName).join(", ")} posts are public. Post to YouTube alone, or post publicly.`);
  }

  const creatives = await listCreatives(campaignId);
  const existing = creatives.length ? await store().find<{ creative_id: string }>("posts", { creative_id: { in: creatives.map((c) => c.id) }, status: { ne: "failed" } }) : [];
  const posted = new Set(existing.map((row) => row.creative_id));
  const approved = creatives.filter((c) => c.approved && !c.rejected && c.status === "ready" && !posted.has(c.id) && (!choice.creativeIds || choice.creativeIds.includes(c.id)));
  // Internal remakes never go out unless someone cleared them, even when approved or on autopilot.
  const held = approved.filter((c) => postingHold(parse<Concept | null>(c.concept_json, null)));
  const queue = approved.filter((c) => !held.includes(c));
  if (queue.length === 0) throw new Error(held.length ? "The approved videos are internal remakes, which are not posted unless cleared." : "Approve at least one ready video first.");
  if (held.length) await logEvent({ brandId: campaign.brand_id, campaignId, message: `Held back ${held.length} internal remake${held.length > 1 ? "s" : ""}: not cleared for posting` });

  const skipped: string[] = [];
  let queued = 0;
  let slot = nextSlot(new Date());
  for (const creative of queue) {
    if (!(await hasMedia(creative))) {
      skipped.push(creative.id);
      continue;
    }
    const platforms = choice.platforms ?? parse<string[]>(creative.platforms_json, []).filter((platform) => connected.has(platform));
    const id = newId("pst");
    await store().insert("posts", {
      id,
      creative_id: creative.id,
      brand_id: campaign.brand_id,
      idem: `${id}-publish`,
      platforms_json: JSON.stringify(platforms.length ? platforms : [...connected]),
      scheduled_at: mode === "now" ? null : slot.toISOString(),
      status: "pending",
      result_json: choice.visibility ? JSON.stringify({ request: { visibility: choice.visibility } }) : null,
      created_at: now(),
      updated_at: now(),
    });
    queued += 1;
    if (mode === "daily") slot = new Date(slot.getTime() + 24 * 3600 * 1000);
  }
  if (queued === 0) throw new Error("None of the approved videos has a finished file to post yet.");
  // A campaign still making its other videos keeps running; the worker only advances running ones.
  if (campaign.status !== "running") await save("campaigns", campaignId, { status: "publishing" });
  await logEvent({
    brandId: campaign.brand_id,
    campaignId,
    message: `Queued ${queued} post${queued === 1 ? "" : "s"} ${mode === "now" ? "to go out now" : "one per day"}${choice.visibility ? ` (${choice.visibility})` : ""}${skipped.length ? `; ${skipped.length} had no file to post` : ""}`,
  });
  return { queued, skipped };
}

function nextSlot(from: Date) {
  const slot = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 16, 0, 0));
  if (slot.getTime() - from.getTime() < 30 * 60 * 1000) slot.setUTCDate(slot.getUTCDate() + 1);
  return slot;
}

/** After a busy answer (rate limit, network blip), a queued post waits this long before trying again. */
const BUSY_RETRY_MS = 60 * 1000;

/** Worker step: submit queued posts to Postiz and transition due scheduled posts. */
export async function advancePosts() {
  const rows = await store().find<PostRow>("posts", { status: { in: ["pending", "scheduled", "processing"] } }, { order: [["created_at", "asc"]] });
  if (rows.length === 0) return;
  if (!hasPostiz()) return;

  for (const post of rows) {
    const brand = await getBrand(post.brand_id);
    const [creative] = await store().find<CreativeRow>("creatives", { id: post.creative_id }, { limit: 1 });
    if (!brand || !creative) continue;
    try {
      if (post.status === "pending") {
        // Checked again here: a post queued before a video was held must not go out either.
        const hold = postingHold(parse<Concept | null>(creative.concept_json, null));
        if (hold) {
          await save("posts", post.id, { status: "failed", error: hold });
          await logEvent({ brandId: brand.id, level: "warn", message: `A post was stopped: ${hold}` });
          continue;
        }
        if (post.error && Date.now() - Date.parse(post.updated_at) < BUSY_RETRY_MS) continue;
        await submit(brand.id, post, creative);
      } else if (post.status === "scheduled" && post.scheduled_at && Date.parse(post.scheduled_at) <= Date.now()) {
        await save("posts", post.id, { status: "posted" });
        await logEvent({ brandId: brand.id, message: `Posted to ${parse<string[]>(post.platforms_json, []).map(platformName).join(", ")}` });
      }
    } catch (error) {
      if (error instanceof ApiError && error.retryable) {
        if (post.status === "pending") {
          await save("posts", post.id, { error: `Waiting for Postiz (${error.message.replace(/^postiz: /, "")}); trying again in a minute` });
        }
        continue;
      }
      await save("posts", post.id, { status: post.status === "pending" ? "failed" : post.status, error: error instanceof Error ? error.message : String(error) });
      if (post.status === "pending") await logEvent({ brandId: brand.id, level: "error", message: `A post failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  await settleCampaigns();
}

/**
 * Adds `#AIgenerated` when Postiz does not expose a native AI-content disclosure toggle for the
 * target platform. TikTok supports `video_made_with_ai: true` in Postiz settings.
 */
function captionWithAiLabel(caption: string, platform: string): string {
  if (platform === "tiktok") return caption;
  if (/#aigenerated\b/i.test(caption)) return caption;
  return caption.trim() ? `${caption.trim()}\n\n#AIgenerated` : "#AIgenerated";
}

function matchingIntegrations(channels: PostizIntegration[], platforms: string[]): PostizIntegration[] {
  const wanted = new Set(platforms.map((p) => p.toLowerCase()));
  const picked: PostizIntegration[] = [];
  const seen = new Set<string>();
  for (const channel of channels) {
    if (channel.disabled || seen.has(channel.id)) continue;
    const norm = normalizePlatform(channel.identifier);
    if (wanted.has(norm) || wanted.has(channel.identifier.toLowerCase())) {
      seen.add(channel.id);
      picked.push(channel);
    }
  }
  return picked;
}

/** Uploads the cut if needed and submits the post to each matching Postiz channel. */
async function submit(brandId: string, post: PostRow, creative: CreativeRow) {
  const platforms = parse<string[]>(post.platforms_json, []);
  const request = parse<{ request?: { visibility?: Visibility } }>(post.result_json, {}).request ?? {};
  const channels = matchingIntegrations(await integrations(), platforms);
  if (channels.length === 0) {
    throw new Error(`No connected Postiz channel for ${platforms.map(platformName).join(", ")}.`);
  }

  const media = await postMedia(creative);
  const scheduled = Boolean(post.scheduled_at && Date.parse(post.scheduled_at) > Date.now() + 5 * 60 * 1000);
  const at = scheduled && post.scheduled_at ? new Date(post.scheduled_at) : undefined;
  const title = parse<{ title?: string }>(creative.concept_json, {}).title;

  const results: PostizPostResult[] = [];
  for (const channel of channels) {
    const platform = normalizePlatform(channel.identifier);
    const created = await schedule({
      integrationId: channel.id,
      platform: channel.identifier,
      text: captionWithAiLabel(creative.caption, platform),
      media,
      at,
      title,
      visibility: request.visibility,
      aiGenerated: true,
    });
    results.push(...created);
  }

  const status: PostRow["status"] = scheduled ? "scheduled" : "posted";
  await save("posts", post.id, { status, result_json: JSON.stringify({ posts: results }), error: null });
  await logEvent({
    brandId,
    message: `Post ${scheduled && post.scheduled_at ? `scheduled for ${post.scheduled_at.slice(0, 16).replace("T", " ")} UTC` : "submitted"}: ${platforms.map(platformName).join(", ")}${request.visibility ? ` (${request.visibility})` : ""}`,
  });
  if (status === "posted") {
    await logEvent({ brandId, message: `Posted to ${platforms.map(platformName).join(", ")}` });
  }
}

/** Uploads the stored cut once to Postiz and caches `{ id, path }` on the creative row. */
async function postMedia(creative: CreativeRow): Promise<PostizMedia> {
  if (creative.final_url === "postiz" && creative.final_file_id && creative.final_external_url) {
    return { id: creative.final_file_id, path: creative.final_external_url };
  }
  const key = cutKey(creative);
  if (await store().files.exists(key)) {
    const name = `${slug(parse<{ title?: string }>(creative.concept_json, {}).title ?? creative.id)}.mp4`;
    const uploaded = await upload(await readFile(await store().files.localPath(key)), name, "video/mp4");
    await save("creatives", creative.id, { final_file_id: uploaded.id, final_external_url: uploaded.path, final_url: "postiz" });
    return uploaded;
  }
  if (creative.final_external_url) {
    return { id: creative.final_file_id ?? creative.id, path: creative.final_external_url };
  }
  throw new Error("The video has no finished file to post.");
}

/** A publishing campaign goes live once none of its posts is still on its way. */
async function settleCampaigns() {
  const publishing = await store().find<{ id: string }>("campaigns", { status: "publishing" });
  for (const { id } of publishing) {
    const creatives = await listCreatives(id);
    const open = creatives.length ? await store().find("posts", { creative_id: { in: creatives.map((c) => c.id) }, status: { in: ["pending", "processing"] } }, { limit: 1 }) : [];
    if (open.length === 0) await save("campaigns", id, { status: "live", stage: "live" });
  }
}

// ---------- what a post did ----------

export type PostStats = { views?: number; likes?: number; comments?: number; shares?: number; saves?: number };
type Metric = keyof PostStats;

const METRIC_KEYS: Record<Metric, string[]> = {
  views: ["views", "viewcount", "videoviews", "videoviewcount", "plays", "playcount", "totalplays"],
  likes: ["likes", "likecount", "favorites", "favoritecount", "reactions", "reactioncount"],
  comments: ["comments", "commentcount", "commentscount"],
  shares: ["shares", "sharecount", "reposts", "repostcount", "retweets", "retweetcount"],
  saves: ["saves", "savecount", "saved", "bookmarks", "bookmarkcount"],
};
const METRIC_OF = new Map(Object.entries(METRIC_KEYS).flatMap(([metric, keys]) => keys.map((key) => [key, metric as Metric] as const)));

/**
 * Reads a post's link and metrics from stored analytics or result payloads (e.g. demo replays).
 * Postiz public API post submissions do not return per-post analytics directly.
 */
export function postStats(post: Pick<PostRow, "analytics_json" | "result_json">): PostStats & { url: string | null } {
  const result = parse<{ url?: unknown; metrics?: unknown } | null>(post.result_json, null);
  const analytics = parse<unknown>(post.analytics_json, null);
  const fromAnalytics = collectStats(analytics);
  const stats = Object.keys(fromAnalytics).length ? fromAnalytics : collectStats(result?.metrics ?? null);
  const url = typeof result?.url === "string" && result.url ? result.url : findPermalink(analytics);
  return { url, ...stats };
}

function findPermalink(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  const values = Array.isArray(node) ? node : Object.values(node);
  if (!Array.isArray(node)) {
    for (const [key, value] of Object.entries(node)) if (/^(permalink|post_?url)$/i.test(key) && typeof value === "string" && /^https?:\/\//.test(value)) return value;
  }
  for (const value of values) {
    const found = findPermalink(value);
    if (found) return found;
  }
  return null;
}

function collectStats(node: unknown): PostStats {
  if (Array.isArray(node)) return collectList(node);
  if (!node || typeof node !== "object") return {};
  const here: PostStats = {};
  let below: PostStats = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const metric = METRIC_OF.get(key.toLowerCase().replace(/[^a-z]/g, ""));
    if (metric) {
      const n = count(value);
      if (n !== null && here[metric] === undefined) here[metric] = n;
      continue;
    }
    if (value && typeof value === "object") below = addStats(below, collectStats(value));
  }
  return { ...below, ...here };
}

const TIME_KEYS = ["createdAt", "created_at", "updatedAt", "updated_at", "measuredAt", "measured_at", "date", "timestamp"];
const SERIES_KEYS = ["profilePostId", "profile_post_id", "socialAccountId", "social_account_id", "accountId", "account_id", "platform", "platformType", "network"];

function collectList(items: unknown[]): PostStats {
  const latest = new Map<string, { at: number; item: unknown }>();
  let sum: PostStats = {};
  for (const item of items) {
    const record = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
    const at = record ? TIME_KEYS.map((key) => (typeof record[key] === "string" ? Date.parse(record[key] as string) : NaN)).find((t) => Number.isFinite(t)) : undefined;
    if (at === undefined) {
      sum = addStats(sum, collectStats(item));
      continue;
    }
    const series = SERIES_KEYS.map((key) => record![key]).find((value) => typeof value === "string" && value) ?? "#series";
    const seen = latest.get(String(series));
    if (!seen || at > seen.at) latest.set(String(series), { at, item });
  }
  for (const { item } of latest.values()) sum = addStats(sum, collectStats(item));
  return sum;
}

function count(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const inner = value as Record<string, unknown>;
    for (const key of ["count", "total", "value"]) if (typeof inner[key] === "number") return inner[key] as number;
  }
  return null;
}

function addStats(a: PostStats, b: PostStats): PostStats {
  const sum: PostStats = { ...a };
  for (const [metric, n] of Object.entries(b) as Array<[Metric, number]>) sum[metric] = (sum[metric] ?? 0) + n;
  return sum;
}
