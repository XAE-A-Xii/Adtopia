import { ApiError, requestJson } from "./http";
import { getSetting } from "./settings";

// fal (https://fal.ai/docs/model-apis/model-endpoints/queue): submit to the queue, poll the status,
// then read the result. Requests carry no idempotency key, so a submit is never retried here: a
// retried submit is a second paid job.

export const FAL = {
  /** Gemini 3 Pro Image ("Nano Banana Pro"): frames, with reference images when there are any. */
  frame: "fal-ai/nano-banana-pro/edit",
  /** Kling 3.0 Pro with its own voice: from a first frame, or from the prompt alone. */
  i2v: "fal-ai/kling-video/v3/pro/image-to-video",
  t2v: "fal-ai/kling-video/v3/pro/text-to-video",
} as const;

/**
 * Price estimates in USD, since fal does not report a cost per request.
 * ponytail: list prices from Nov 2026 (Kling 3.0 Pro with audio, per second); update when fal changes them.
 */
export const FAL_USD = { frame: 0.15, renderPerSecond: 0.168 } as const;

export const hasFal = () => Boolean(getSetting("fal_api_key"));

/** The queue URLs use only the owner and app ("fal-ai/kling-video"), never the full endpoint path. */
const appOf = (endpoint: string) => endpoint.split("/").slice(0, 2).join("/");

export type FalStatus = { status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED"; error?: string | null; error_type?: string | null };

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export class FalClient {
  constructor(
    private readonly key = getSetting("fal_api_key"),
    private readonly base = getSetting("fal_base_url"),
  ) {
    if (!key) throw new ApiError("fal", 401, "not_configured", "no fal API key; add one in Settings");
  }

  private async call<T>(method: "GET" | "POST", url: string, body?: unknown) {
    return (await requestJson<T>({ service: "fal", url, method, headers: { authorization: `Key ${this.key}` }, body, timeoutMs: 60_000, retries: method === "GET" ? 2 : 0 })).data;
  }

  /** Queues a job; returns its request id. */
  async submit(endpoint: string, input: Record<string, unknown>): Promise<string> {
    const { request_id } = await this.call<{ request_id?: string }>("POST", `${this.base}/${endpoint}`, input);
    if (!request_id) throw new ApiError("fal", 502, "no_request", `${endpoint}: fal queued no request`);
    return request_id;
  }

  status(endpoint: string, requestId: string) {
    return this.call<FalStatus>("GET", `${this.base}/${appOf(endpoint)}/requests/${requestId}/status`);
  }

  /** A finished job's output. A job that failed throws: the model refused or rejected its input. */
  async result<T>(endpoint: string, requestId: string, status?: FalStatus): Promise<T> {
    if (status?.error) throw new ApiError("fal", 422, status.error_type ?? "job_failed", `${endpoint}: ${status.error}`);
    return this.call<T>("GET", `${this.base}/${appOf(endpoint)}/requests/${requestId}`);
  }

  /** Submits and waits for the output (for short jobs such as a frame). */
  async run<T>(endpoint: string, input: Record<string, unknown>, options: { pollMs?: number; timeoutMs?: number } = {}): Promise<T> {
    const id = await this.submit(endpoint, input);
    const deadline = Date.now() + (options.timeoutMs ?? 180_000);
    for (;;) {
      const status = await this.status(endpoint, id);
      if (status.status === "COMPLETED") return this.result<T>(endpoint, id, status);
      if (Date.now() > deadline) throw new ApiError("fal", 504, "job_timeout", `${endpoint}: still ${status.status.toLowerCase()} (request ${id})`);
      await sleep(options.pollMs ?? 2000);
    }
  }
}

/** The first link fal returned for an image or a video. */
export const falImageUrl = (output: unknown) => (output as { images?: Array<{ url?: string }> })?.images?.[0]?.url ?? null;
export const falVideoUrl = (output: unknown) => (output as { video?: { url?: string } })?.video?.url ?? null;
