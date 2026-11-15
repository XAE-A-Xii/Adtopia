import { describe, expect, it } from "vitest";
import { claudeClient, hasClaude } from "@/lib/claude";

// Opt-in, paid (under a cent): CLAUDE_LIVE=1 with ANTHROPIC_API_KEY set.
const live = process.env.CLAUDE_LIVE === "1";

describe.skipIf(!live)("Claude on the Anthropic API (live)", () => {
  it("answers a tool call on Sonnet 5.5 and a streamed call on Haiku 5.5, as Adtopia's code makes them", async () => {
    expect(hasClaude()).toBe(true);
    const claude = claudeClient();
    const tool = { name: "verdict", description: "Return the verdict.", input_schema: { type: "object", required: ["pass", "reason"], properties: { pass: { type: "boolean" }, reason: { type: "string" } } } };
    const reply = await claude.message({ model: "anthropic/claude-sonnet-5.5", max_tokens: 2000, messages: [{ role: "user", content: "Is 'Try it free for 7 days' a clear call to action? Answer with the verdict tool." }], tools: [tool] });
    const verdict = reply.content.find((b) => b.type === "tool_use")?.input as { pass?: boolean; reason?: string } | undefined;
    expect(typeof verdict?.pass).toBe("boolean");

    const streamed = await claude.messageStream({ model: "anthropic/claude-haiku-5.5", max_tokens: 500, messages: [{ role: "user", content: "Write a five-word TikTok hook for a budgeting app." }] });
    const text = streamed.content.find((b) => b.type === "text")?.text ?? "";
    expect(text.length).toBeGreaterThan(5);
    expect(streamed.usage?.output_tokens ?? 0).toBeGreaterThan(0);
    console.log(`sonnet: ${JSON.stringify(verdict)} | haiku: ${text.trim()}`);
  }, 180_000);
});
