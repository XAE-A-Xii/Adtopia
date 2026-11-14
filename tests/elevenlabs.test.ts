import { afterEach, describe, expect, it, vi } from "vitest";
import { ElevenLabsClient, segmentsFromWords } from "@/lib/elevenlabs";
import { ApiError } from "@/lib/http";

describe("segmentsFromWords", () => {
  it("breaks at sentence ends and long pauses, and skips spacing and audio events", () => {
    const words = [
      { text: "I", start: 0, end: 0.1, type: "word" },
      { text: " ", start: 0.1, end: 0.2, type: "spacing" },
      { text: "tried", start: 0.2, end: 0.5, type: "word" },
      { text: "it.", start: 0.5, end: 0.8, type: "word" },
      { text: "(laughs)", start: 0.8, end: 1.2, type: "audio_event" },
      { text: "Wow", start: 1.3, end: 1.6, type: "word" },
      { text: "honestly", start: 3, end: 3.5, type: "word" },
      { text: "?", start: null, end: null, type: "word" },
    ];
    expect(segmentsFromWords(words)).toEqual([
      { start_seconds: 0, end_seconds: 0.8, text: "I tried it." },
      { start_seconds: 1.3, end_seconds: 1.6, text: "Wow" },
      { start_seconds: 3, end_seconds: 3.5, text: "honestly" },
    ]);
  });
});

describe("ElevenLabsClient errors", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads an out-of-quota answer as out of credits, and a 429 as retryable", async () => {
    const answer = (status: number, detail: unknown) => vi.fn(async () => new Response(JSON.stringify({ detail }), { status }));
    const client = new ElevenLabsClient("test-key", "https://eleven.test");

    vi.stubGlobal("fetch", answer(401, { status: "quota_exceeded", message: "out of characters" }));
    const quota = await client.tts("v", { text: "hi", model_id: "m" }).catch((e: unknown) => e);
    expect(quota).toBeInstanceOf(ApiError);
    expect((quota as ApiError).outOfCredits).toBe(true);
    expect((quota as ApiError).retryable).toBe(false);

    vi.stubGlobal("fetch", answer(429, { status: "too_many_concurrent_requests", message: "busy" }));
    const busy = (await client.tts("v", { text: "hi", model_id: "m" }).catch((e: unknown) => e)) as ApiError;
    expect(busy.retryable).toBe(true);
    expect(busy.message).toBe("elevenlabs: busy");
  });
});
