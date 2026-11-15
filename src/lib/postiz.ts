import { ApiError } from "./http";
import { getSetting } from "./settings";

// Postiz Public API client (https://docs.postiz.com/public-api/introduction).
// Auth uses a raw `Authorization: <api key>` header (no "Bearer" prefix).
// Create-post is rate limited (~100/hour), so 429 responses surface as retryable ApiError.

export type PostizIntegration = {
  id: string;
  name: string;
  identifier: string;
  picture?: string;
  disabled?: boolean;
  profile?: string;
};

export type PostizMedia = {
  id: string;
  path: string;
};

export type PostizPostResult = {
  postId: string;
  integration: string;
};

export type ScheduleInput = {
  integrationId: string;
  platform: string;
  text: string;
  media: PostizMedia | PostizMedia[];
  at?: Date | string;
  title?: string;
  visibility?: "public" | "unlisted" | "private";
  aiGenerated?: boolean;
};

export const hasPostiz = () => Boolean(getSetting("postiz_api_key"));

function config() {
  const key = getSetting("postiz_api_key");
  if (!key) throw new ApiError("postiz", 401, "not_configured", "no Postiz API key; add one in Settings");
  const base = getSetting("postiz_base_url").replace(/\/+$/, "");
  return { key, base };
}

async function postizFetch(url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(60_000) });
  } catch (error) {
    throw new ApiError("postiz", 0, "network_error", error instanceof Error ? error.message : String(error));
  }
  if (res.ok) return res;
  const body = await res.text();
  let code = String(res.status);
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (typeof parsed.code === "string" || typeof parsed.code === "number") code = String(parsed.code);
    else if (typeof parsed.error === "string" && parsed.error) code = parsed.error;
  } catch {
    // Keep HTTP status as code when error body is not JSON.
  }
  throw new ApiError("postiz", res.status, code, body || `HTTP ${res.status}`);
}

/** Lists all social channels connected in Postiz. */
export async function integrations(): Promise<PostizIntegration[]> {
  const { key, base } = config();
  const res = await postizFetch(`${base}/integrations`, {
    method: "GET",
    headers: { Authorization: key, accept: "application/json" },
  });
  return (await res.json()) as PostizIntegration[];
}

/** Uploads media bytes via multipart form-data (`file` field) and returns `{ id, path }`. */
export async function upload(bytes: Uint8Array | Buffer, filename: string, contentType = "video/mp4"): Promise<PostizMedia> {
  const { key, base } = config();
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: contentType }), filename);
  const res = await postizFetch(`${base}/upload`, {
    method: "POST",
    headers: { Authorization: key },
    body: form,
  });
  const data = (await res.json()) as { id?: string; path?: string };
  if (!data.id || !data.path) throw new ApiError("postiz", 502, "upload_invalid", "upload returned no id or path");
  return { id: data.id, path: data.path };
}

function platformSettings(input: ScheduleInput): Record<string, unknown> {
  const platform = input.platform.toLowerCase();
  if (platform === "tiktok") {
    return {
      __type: "tiktok",
      privacy_level: input.visibility === "private" ? "SELF_ONLY" : "PUBLIC_TO_EVERYONE",
      content_posting_method: "DIRECT_POST",
      duet: true,
      stitch: true,
      comment: true,
      autoAddMusic: "no",
      brand_content_toggle: false,
      brand_organic_toggle: false,
      ...(input.aiGenerated ? { video_made_with_ai: true } : {}),
      ...(input.title ? { title: input.title.slice(0, 90) } : {}),
    };
  }
  if (platform === "youtube") {
    const rawTitle = (input.title || input.text || "Video").trim();
    const title = rawTitle.length >= 2 ? rawTitle.slice(0, 100) : "Video";
    return {
      __type: "youtube",
      title,
      type: input.visibility ?? "public",
      selfDeclaredMadeForKids: "no",
    };
  }
  if (platform === "instagram" || platform === "instagram-standalone") {
    return { __type: platform, post_type: "post" };
  }
  // Other Postiz platforms (x, facebook, linkedin, threads, bluesky) have no native AI-generated toggle in settings.
  return { __type: input.platform };
}

/** Creates an immediate (`now`) or scheduled (`schedule`) post on Postiz. */
export async function schedule(input: ScheduleInput): Promise<PostizPostResult[]> {
  const { key, base } = config();
  const atDate = input.at === undefined ? null : input.at instanceof Date ? input.at : new Date(input.at);
  const type = atDate ? "schedule" : "now";
  const date = (atDate ?? new Date()).toISOString();
  const images = (Array.isArray(input.media) ? input.media : [input.media]).map(({ id, path }) => ({ id, path }));

  const payload = {
    type,
    date,
    shortLink: false,
    tags: [],
    posts: [
      {
        integration: { id: input.integrationId },
        value: [{ content: input.text, image: images }],
        settings: platformSettings(input),
      },
    ],
  };

  const res = await postizFetch(`${base}/posts`, {
    method: "POST",
    headers: { Authorization: key, "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload),
  });
  return (await res.json()) as PostizPostResult[];
}
