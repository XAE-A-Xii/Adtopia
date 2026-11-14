import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeCostMicro, claudeModel } from "@/lib/claude";
import { ApiError } from "@/lib/http";
import { NaiveClient } from "@/lib/naive";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("claude helpers", () => {
  it("maps Naive's model names to Anthropic's and prices a reply", () => {
    expect(claudeModel("anthropic/claude-sonnet-5.5")).toBe("claude-sonnet-5-5");
    expect(claudeModel("anthropic/claude-haiku-5.5")).toBe("claude-haiku-5-5");
    expect(claudeModel("claude-opus-5-5")).toBe("claude-opus-5-5");
    // 100k in + 20k out on Sonnet 5.5 ($2 / $10 per million) = $0.40
    expect(claudeCostMicro("anthropic/claude-sonnet-5.5", { input_tokens: 60_000, cache_read_input_tokens: 40_000, output_tokens: 20_000 })).toBe(400_000);
  });
});

describe("NaiveClient with only an Anthropic key", () => {
  it("sends Claude calls to Anthropic, with fallbacks on Sonnet 5.5, and says Naive's own services need a key", async () => {
    vi.stubEnv("NAIVE_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", `test-${Math.random()}`);
    const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        sent.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
        return new Response(
          JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_details: null, usage: { input_tokens: 10, output_tokens: 2 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const naive = new NaiveClient();
    expect(naive.hasKey).toBe(false);
    const reply = await naive.message({ model: "anthropic/claude-sonnet-5.5", max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
    expect(reply.content).toEqual([{ type: "text", text: "ok" }]);
    expect(sent[0].url).toContain("api.anthropic.com/v1/messages");
    expect(sent[0].body).toMatchObject({ model: "claude-sonnet-5-5", fallbacks: "default" });

    const upload = (await naive.uploadFile("a.mp4", "video/mp4", Buffer.from("x")).catch((e: unknown) => e)) as ApiError;
    expect(upload).toBeInstanceOf(ApiError);
    expect(upload.message).toMatch(/needs a Naive API key/);
    expect(sent).toHaveLength(1);
  });
});
