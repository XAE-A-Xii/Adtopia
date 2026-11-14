import { afterEach, describe, expect, it, vi } from "vitest";
import { FAL, FalClient, falVideoUrl } from "@/lib/fal";
import { ApiError } from "@/lib/http";

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("FalClient", () => {
  it("submits once, polls the app's status URL and reads the result", async () => {
    const calls: Array<{ method: string; url: string; auth: string }> = [];
    const answers = [json({ request_id: "req_1" }), json({ status: "IN_PROGRESS" }), json({ status: "COMPLETED" }), json({ video: { url: "https://cdn.test/out.mp4" } })];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ method: init.method ?? "GET", url, auth: (init.headers as Record<string, string>).authorization });
        return answers.shift()!;
      }),
    );
    const output = await new FalClient("k", "https://queue.test").run(FAL.i2v, { prompt: "hi" }, { pollMs: 1 });
    expect(falVideoUrl(output)).toBe("https://cdn.test/out.mp4");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://queue.test/fal-ai/kling-video/v3/pro/image-to-video",
      "GET https://queue.test/fal-ai/kling-video/requests/req_1/status",
      "GET https://queue.test/fal-ai/kling-video/requests/req_1/status",
      "GET https://queue.test/fal-ai/kling-video/requests/req_1",
    ]);
    expect(calls.every((c) => c.auth === "Key k")).toBe(true);
  });

  it("never retries a failed submit, and reports a failed job as not retryable", async () => {
    const fetch = vi.fn(async () => json({ detail: "busy" }, 503));
    vi.stubGlobal("fetch", fetch);
    const fal = new FalClient("k", "https://queue.test");
    const busy = (await fal.submit(FAL.t2v, { prompt: "hi" }).catch((e: unknown) => e)) as ApiError;
    expect(busy.retryable).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);

    const failed = (await fal.result(FAL.t2v, "req_2", { status: "COMPLETED", error: "content policy", error_type: "safety" }).catch((e: unknown) => e)) as ApiError;
    expect(failed).toBeInstanceOf(ApiError);
    expect(failed.retryable).toBe(false);
  });
});
