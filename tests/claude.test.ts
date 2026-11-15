import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeClient, claudeCostMicro, claudeModel, hasClaude } from "@/lib/claude";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("claude helpers", () => {
  it("normalizes model names to Anthropic's and prices a reply", () => {
    expect(claudeModel("anthropic/claude-sonnet-5.5")).toBe("claude-sonnet-5-5");
    expect(claudeModel("anthropic/claude-haiku-5.5")).toBe("claude-haiku-5-5");
    expect(claudeModel("claude-opus-5-5")).toBe("claude-opus-5-5");
    // 100k in + 20k out on Sonnet 5.5 ($2 / $10 per million) = $0.40
    expect(claudeCostMicro("anthropic/claude-sonnet-5.5", { input_tokens: 60_000, cache_read_input_tokens: 40_000, output_tokens: 20_000 })).toBe(400_000);
  });
});

describe("ClaudeClient", () => {
  it("sends Claude calls to Anthropic with fallbacks on Sonnet 5.5", async () => {
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
    expect(hasClaude()).toBe(true);
    const reply = await claudeClient().message({ model: "anthropic/claude-sonnet-5.5", max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
    expect(reply.content).toEqual([{ type: "text", text: "ok" }]);
    expect(sent[0].url).toContain("api.anthropic.com/v1/messages");
    expect(sent[0].body).toMatchObject({ model: "claude-sonnet-5-5", fallbacks: "default" });
    expect(sent).toHaveLength(1);
  });
});
