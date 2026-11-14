import Anthropic from "@anthropic-ai/sdk";
import { ApiError } from "./http";
import { getSetting } from "./settings";

// Claude on the Anthropic API with the brand's own key: the same Messages calls Nomen otherwise
// sends through Naive's proxy. Model names arrive in Naive's form ("anthropic/claude-sonnet-5.5").

export const hasClaude = () => Boolean(getSetting("anthropic_api_key"));

/** "anthropic/claude-sonnet-5.5" → "claude-sonnet-5-5". */
export const claudeModel = (model: string) => model.replace(/^anthropic\//, "").replace(/(\d)\.(\d)/g, "$1-$2");

/** Sonnet and Opus 5.5 can decline a request; "default" fallbacks rerun it on a fallback model in the same call. Haiku 5.5 has none. */
const FALLBACK = /^claude-(sonnet|opus)-5-5$/;

/** List prices in USD per million tokens (input, output), for spend estimates. */
const PRICES: Array<[RegExp, number, number]> = [
  [/haiku-5-5/, 0.1, 0.5],
  [/sonnet-5/, 2, 10],
  [/opus-5-5/, 4, 20],
];

export type ClaudeInput = { model: string; max_tokens: number; system?: string; messages: Array<{ role: "user" | "assistant"; content: unknown }>; tools?: object[] };
export type ClaudeReply = {
  content: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
  stop_reason: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
};

/** What a reply cost at list prices, in micro-USD (cache reads counted at full price: an over-estimate). */
export function claudeCostMicro(model: string, usage: ClaudeReply["usage"]) {
  const [, input, output] = PRICES.find(([pattern]) => pattern.test(claudeModel(model))) ?? [null, 4, 20];
  const tokensIn = (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0);
  return Math.round(tokensIn * input + (usage?.output_tokens ?? 0) * output);
}

let client: { key: string; anthropic: Anthropic } | null = null;
function anthropic() {
  const key = getSetting("anthropic_api_key");
  if (!client || client.key !== key) client = { key, anthropic: new Anthropic({ apiKey: key }) };
  return client.anthropic;
}

function params(input: ClaudeInput): Anthropic.Beta.MessageCreateParamsNonStreaming {
  const model = claudeModel(input.model);
  return {
    model,
    max_tokens: input.max_tokens,
    ...(input.system ? { system: input.system } : {}),
    messages: input.messages as Anthropic.Beta.BetaMessageParam[],
    ...(input.tools ? { tools: input.tools as Anthropic.Beta.BetaToolUnion[] } : {}),
    ...(FALLBACK.test(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
  };
}

function reply(message: Anthropic.Beta.BetaMessage): ClaudeReply {
  if (message.stop_reason === "refusal") throw new ApiError("anthropic", 422, "refusal", `Claude declined this request (${message.stop_details?.category ?? "no category"})`);
  return { content: message.content as ClaudeReply["content"], stop_reason: message.stop_reason ?? "", usage: message.usage as ClaudeReply["usage"] };
}

/** Anthropic's errors as Nomen's: busy and network trouble are retryable, an empty balance is out of credits. */
async function guard<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof Anthropic.APIConnectionError) throw new ApiError("anthropic", 0, "network_error", error.message);
    if (error instanceof Anthropic.APIError) {
      const credits = /credit balance/i.test(error.message);
      const type = (error.error as { error?: { type?: string } } | undefined)?.error?.type;
      throw new ApiError("anthropic", credits ? 402 : (error.status ?? 0), credits ? "insufficient_credits" : (type ?? String(error.status)), error.message, error.requestID ?? undefined);
    }
    throw error;
  }
}

export const claudeMessage = (input: ClaudeInput, timeoutMs: number) => guard(async () => reply(await anthropic().beta.messages.create(params(input), { timeout: timeoutMs })));

/** Streamed, for long answers; usage as Naive's stream reports it (cache tokens folded into input). */
export const claudeStream = (input: ClaudeInput, timeoutMs: number) =>
  guard(async () => {
    const out = reply(await anthropic().beta.messages.stream(params(input), { timeout: timeoutMs }).finalMessage());
    const u = out.usage ?? {};
    return { ...out, usage: { input_tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), output_tokens: u.output_tokens ?? 0 } };
  });
