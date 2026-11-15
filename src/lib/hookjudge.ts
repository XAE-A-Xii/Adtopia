import { claudeMessage, hasClaude } from "./claude";
import { canonicalUrl } from "./creative/references";
import { logEvent, parse, store } from "./db";
import { extractJson, type ResearchPack, type ResearchPlan } from "./research";
import { getSetting } from "./settings";
import { captionFor, type Concept } from "./strategy";

export const JUDGE_TIMEOUT_MS = 20_000;

export type JudgeAnswer = "A" | "B";
export type JudgeConfig = { url?: string; key?: string; secret?: string; timeoutMs?: number };
export type PickResult = { caption: string; index: number; calls: number; reason: string };

type CampaignCaptionRow = {
  id: string;
  brand_id: string;
  plan_json: string | null;
  research_json: string | null;
};

function resolveConfig(config?: JudgeConfig) {
  return {
    url: (config?.url ?? getSetting("hook_judge_url")).trim(),
    key: (config?.key ?? getSetting("hook_judge_key")).trim(),
    secret: (config?.secret ?? getSetting("hook_judge_secret")).trim(),
    timeoutMs: config?.timeoutMs ?? JUDGE_TIMEOUT_MS,
  };
}

export const hasHookJudge = () => {
  const { url, key, secret } = resolveConfig();
  return Boolean(url && key && secret);
};

/** Pairwise caption judge hosted on Modal; sends `{ query, a, b }` and Modal proxy-auth headers. */
export async function judge(query: string, a: string, b: string, config?: JudgeConfig): Promise<JudgeAnswer> {
  const { url, key, secret, timeoutMs } = resolveConfig(config);
  if (!url || !key || !secret) throw new Error("hook judge not configured");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Modal-Key": key,
      "Modal-Secret": secret,
    },
    body: JSON.stringify({ query, a, b }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`hook judge HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const data = (await response.json()) as { answer?: unknown };
  if (data?.answer !== "A" && data?.answer !== "B") throw new Error(`unexpected hook judge answer: ${String(data?.answer)}`);
  return data.answer;
}

/**
 * Picks the strongest caption among `candidates`. Candidate 0 is the baseline; each challenger is
 * compared with the baseline in both A/B orders and wins only if it beats the baseline in both.
 */
export async function pickCaption(query: string, candidates: string[], config?: JudgeConfig): Promise<PickResult> {
  if (candidates.length === 0) return { caption: "", index: 0, calls: 0, reason: "no candidates" };
  if (candidates.length === 1) return { caption: candidates[0], index: 0, calls: 0, reason: "single candidate" };
  const { url, key, secret } = resolveConfig(config);
  if (!url || !key || !secret) return { caption: candidates[0], index: 0, calls: 0, reason: "hook judge not configured" };

  const baseline = candidates[0];
  let calls = 0;
  let winner = 0;
  try {
    for (let i = 1; i < candidates.length; i++) {
      const challenger = candidates[i];
      calls += 1;
      const forward = await judge(query, baseline, challenger, config);
      calls += 1;
      const reverse = await judge(query, challenger, baseline, config);
      if (forward === "B" && reverse === "A" && winner === 0) winner = i;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { caption: baseline, index: 0, calls, reason: `judge fallback: ${message}` };
  }

  if (winner > 0) {
    return { caption: candidates[winner], index: winner, calls, reason: `candidate ${winner} beat baseline in both orders` };
  }
  return { caption: baseline, index: 0, calls, reason: "baseline kept (no challenger won both orders)" };
}

function queryFromSource(source: string, plan: ResearchPlan | null): string | null {
  if (!plan) return null;
  if (source === "tiktok_brand") return plan.brand_name || null;
  if (source === "tiktok_ads" || source === "meta_ads_cat" || source === "tiktok_top_ads") return plan.ads_query || null;
  const content = source.match(/^(?:tiktok|reels|shorts)_(\d+)$/);
  if (content) return plan.content_queries?.[Number(content[1])] || null;
  const conv = source.match(/^(?:tiktok|reels)_conv_(\d+)$/);
  if (conv) return plan.conversion_queries?.[Number(conv[1])] || null;
  const face = source.match(/^(?:tiktok|reels)_face_(\d+)$/);
  if (face) return plan.face_queries?.[Number(face[1])] || null;
  const comp = source.match(/^(?:tiktok_comp|tiktok_ads_comp|meta_ads_comp)_(\d+)$/);
  if (comp) return plan.competitors?.[Number(comp[1])]?.name || null;
  const bench = source.match(/^tiktok_bench_(\d+)$/);
  if (bench) return plan.benchmarks?.[Number(bench[1])]?.name || null;
  return null;
}

/** Finds the search query behind the creative's reference video, falling back to the campaign's main keyword. */
export async function captionSearchQuery(
  campaignId: string,
  campaign: CampaignCaptionRow | undefined,
  concept: Pick<Concept, "reference" | "inspired_by">,
): Promise<string> {
  const plan = parse<ResearchPlan | null>(campaign?.plan_json, null);
  const pack = parse<ResearchPack | null>(campaign?.research_json, null);
  const refUrl = concept.reference?.url || concept.inspired_by?.[0] || "";
  if (refUrl && pack?.videos?.length) {
    const refKey = canonicalUrl(refUrl);
    const video = pack.videos.find((v) => v.url === refUrl || canonicalUrl(v.url) === refKey);
    if (video?.source) {
      const [run] = await store().find<{ input_json: string }>("monid_runs", { campaign_id: campaignId, key: video.source }, { limit: 1 });
      const input = parse<{ body?: Record<string, unknown> } | null>(run?.input_json, null);
      const fromRun = [input?.body?.query, input?.body?.keyword, input?.body?.advertiserName, input?.body?.companyName].find(
        (v): v is string => typeof v === "string" && v.trim() !== "",
      );
      if (fromRun) return fromRun.trim();
      const fromPlan = queryFromSource(video.source, plan);
      if (fromPlan) return fromPlan;
    }
  }
  return (
    [
      plan?.content_queries?.[0],
      pack?.seo?.keywords?.[0]?.keyword,
      plan?.ads_query,
      plan?.category,
      pack?.brand?.industry,
      pack?.brand?.name,
    ]
      .find((v): v is string => typeof v === "string" && v.trim() !== "")
      ?.trim() ?? ""
  );
}

const CAPTION_TOOL = {
  name: "caption_candidates",
  description: "Record 3 distinct post caption candidates for this short-form video.",
  input_schema: {
    type: "object",
    required: ["captions"],
    properties: {
      captions: {
        type: "array",
        minItems: 3,
        maxItems: 3,
        items: { type: "string", description: "One short, natural post caption body without repeating hashtags unless part of the sentence." },
      },
    },
  },
};

function formatCandidate(text: string, hashtags: string[]) {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (!hashtags.length || /#[\p{L}\p{N}_]/u.test(trimmed)) return trimmed;
  return `${trimmed}\n\n${hashtags.join(" ")}`;
}

async function generateCaptionCandidates(concept: Concept, query: string): Promise<string[]> {
  const spoken = concept.script?.beats?.map((b) => b.line).filter(Boolean).join(" ") ?? "";
  const reply = await claudeMessage(
    {
      model: getSetting("planner_model"),
      max_tokens: 1000,
      system: [
        "You write short-form post captions for TikTok, Reels and Shorts. Write 3 distinct caption candidates for the same video.",
        "Keep candidate 1 faithful to the draft caption if one is given, and give candidates 2 and 3 meaningfully different hook angles (e.g. a sharp question, a blunt contrast, or a concrete takeaway).",
        "Sound like a real creator: short, human, one clear call to action, no invented claims or personal-history testimonials, and no ad-copy cliches. Call caption_candidates once.",
      ].join("\n"),
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            title: concept.title,
            format: concept.format,
            angle: concept.angle,
            hook: concept.hook,
            cta: concept.cta,
            draft_caption: concept.caption,
            hashtags: concept.hashtags,
            search_query: query,
            spoken_lines: spoken.slice(0, 600),
          }),
        },
      ],
      tools: [CAPTION_TOOL],
    },
    30_000,
  );
  const call = reply.content.find((block) => block.type === "tool_use" && block.name === CAPTION_TOOL.name);
  const raw = (call?.input ?? extractJson(reply.content.map((block) => block.text ?? "").join("\n"))) as { captions?: unknown } | null;
  if (!Array.isArray(raw?.captions)) return [];
  return raw.captions
    .filter((c): c is string => typeof c === "string" && c.trim() !== "")
    .map((c) => formatCandidate(c, concept.hashtags))
    .filter(Boolean)
    .slice(0, 3);
}

/**
 * Produces the post caption when a creative is written. When the hook judge is configured, asks
 * Claude for 3 candidates, ranks them pairwise via `pickCaption`, and logs the pick; otherwise
 * keeps the single `captionFor(concept)` behaviour unchanged.
 */
export async function resolveCreativeCaption(campaignId: string, concept: Concept): Promise<string> {
  const baseline = captionFor(concept);
  if (!hasHookJudge() || !hasClaude()) return baseline;

  const [campaign] = await store().find<CampaignCaptionRow>("campaigns", { id: campaignId }, { limit: 1 });
  const query = await captionSearchQuery(campaignId, campaign, concept);

  let candidates: string[];
  try {
    candidates = await generateCaptionCandidates(concept, query);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logEvent({ brandId: campaign?.brand_id, campaignId, level: "warn", message: `Caption candidates failed for "${concept.title}" (${message}); kept baseline caption` });
    return baseline;
  }

  if (candidates.length === 0) return baseline;
  if (candidates.length < 3 && baseline && !candidates.includes(baseline)) {
    candidates = [baseline, ...candidates].slice(0, 3);
  }

  const pick = await pickCaption(query, candidates);
  await logEvent({
    brandId: campaign?.brand_id,
    campaignId,
    message: `Caption judge for "${concept.title}" (query "${query || "none"}"): picked candidate ${pick.index + 1}/${candidates.length} (${pick.calls} calls; ${pick.reason})`,
  });
  return pick.caption;
}
