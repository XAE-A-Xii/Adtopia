import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { type ClaudeClient, claudeClient, claudeCostMicro } from "./claude";
import { logEvent, newId, now, parse, save, store } from "./db";
import { FalClient, hasFal } from "./fal";
import { ApiError } from "./http";
import { MonidClient } from "./monid";
import { advanceCreative, type CreativeRow, insertCreative, type ProductionContext, type ShotState } from "./production";
import { scratchDir } from "./media";
import { brainrotConcept, pickBit, riffOf, siteOf, writeBrainrot } from "./creative/brainrot";
import { canCaptureLocally, captureSiteVisuals, captureSiteVisualsLocal } from "./creative/capture";
import { planProduction } from "./creative/plan";
import { getBrandKit } from "./creative/brandkit";
import { analyzeProduct } from "./creative/product";
import { cloneOf } from "./creative/cloneability";
import { breakdownAll, canonicalUrl, orderBreakdowns, pickAvoidingTaken, scoreCandidates } from "./creative/references";
import { applyRelevance, screenRelevance } from "./creative/relevance";
import { scout, scoutSpecs } from "./creative/scout";
import { targetSeconds, writeScript } from "./creative/script";
import type { ProductBrief, ProductVisual, ReferenceBreakdown, ReferenceCandidate, VideoFormat } from "./creative/types";
import { compactResearch, fallbackPlan, phaseASpecs, phaseCSpecs, planResearch, type ResearchPack, type ResearchPlan, type RunSpec, type Video } from "./research";
import { ensureRuns, listRuns, progressRuns, requeueFailedRuns } from "./runs";
import { cleanPreferences } from "./preferences";
import { getBool, getInt, getSetting } from "./settings";
import { type Concept, conceptFrom, DIRECTOR_PROMPT, FORMATS, normalizeStrategy, type PastResult, STRATEGY_SCHEMA, type Strategy, strategyMessage } from "./strategy";

// The campaign state machine. The worker calls advanceCampaign() every few seconds; every step is
// idempotent, so a restart picks up exactly where it stopped. Rows live in the store (src/lib/store):
// SQLite locally, Convex on serverless hosts, so every read and write is awaited. Files that must
// outlive a tick (captured screenshots, renders, the cut) go through store().files; scratch work
// (downloads, reference videos) lives in scratchDir() for the length of one tick.

export type CampaignStage = "research" | "style" | "strategy" | "production" | "review" | "live";
export type CampaignStatus = "running" | "review" | "publishing" | "live" | "failed" | "stopped";

/**
 * concepts is the number of videos; 0 makes a static-ads-only campaign. statics starts a static ad pack when research is done.
 * production: "ai" renders every video; "creators" casts each brief to a real creator instead (casting-job.ts).
 */
/** `preferences`: what the customer asked for when the campaign started (see src/lib/preferences.ts). */
export type CampaignOptions = { concepts: number; shotsPerConcept: number; secondsPerShot: number; videoModel: string; learnStyle: boolean; statics?: boolean; production?: "ai" | "creators"; preferences?: string; formats?: VideoFormat[] };

export type BrandRow = { id: string; name: string; domain: string; url: string; profile_json: string | null; identity_id: string | null; social_activated: number; created_at: string };

export type CampaignRow = {
  id: string;
  brand_id: string;
  status: CampaignStatus;
  stage: CampaignStage;
  error: string | null;
  attempts: number;
  options_json: string;
  plan_json: string | null;
  research_json: string | null;
  style_build_id: string | null;
  style_idem: string | null;
  style_json: string | null;
  style_started_at: string | null;
  style_attempt: number;
  strategy_idem: string | null;
  strategy_session_id: string | null;
  strategy_nudges: number;
  strategy_json: string | null;
  naive_out: number;
  style_spend_micro: number;
  strategy_spend_micro: number;
  naive_spend_micro: number;
  monid_spend_micro: number;
  created_at: string;
  updated_at: string;
};

export const getBrand = async (id: string) => (await store().find<BrandRow>("brands", { id }, { limit: 1 }))[0];
export const getCampaign = async (id: string) => (await store().find<CampaignRow>("campaigns", { id }, { limit: 1 }))[0];
export const listCreatives = (campaignId: string) => store().find<CreativeRow>("creatives", { campaign_id: campaignId }, { order: [["idx", "asc"], ["generation", "asc"]] });

/** The format_mix setting: the formats every campaign makes, one video each, in order (unknown names dropped). */
export function formatMix(): VideoFormat[] {
  return getSetting("format_mix")
    .split(",")
    .map((name) => name.trim())
    .filter((name): name is VideoFormat => (FORMATS as string[]).includes(name))
    .slice(0, 8);
}

export function defaultOptions(): CampaignOptions {
  const formats = formatMix();
  return {
    ...(formats.length ? { formats } : {}),
    concepts: formats.length || Math.max(1, Math.min(8, getInt("videos_per_campaign"))),
    shotsPerConcept: Math.max(1, Math.min(3, getInt("shots_per_video"))),
    secondsPerShot: Math.max(4, Math.min(10, getInt("video_seconds"))),
    videoModel: getSetting("video_model"),
    learnStyle: getBool("learn_style"),
    statics: getBool("static_ads_auto"),
    production: getSetting("production_mode") === "creators" ? "creators" : "ai",
  };
}

export function normalizeDomain(input: string) {
  const trimmed = input.trim();
  const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  if (!url.hostname.includes(".")) throw new Error("Enter a website address like example.com");
  return { domain: url.hostname.replace(/^www\./, "").toLowerCase(), url: `${url.protocol}//${url.hostname}` };
}

export async function createBrand(input: string) {
  const { domain, url } = normalizeDomain(input);
  const [existing] = await store().find<BrandRow>("brands", { domain }, { limit: 1 });
  if (existing) return existing.id;
  const id = newId("brd");
  const name = domain.split(".")[0];
  await store().insert("brands", { id, name: name[0].toUpperCase() + name.slice(1), domain, url, created_at: now(), updated_at: now() });
  return id;
}

export async function startCampaign(brandId: string, options: CampaignOptions = defaultOptions()) {
  const id = newId("cmp");
  const preferences = cleanPreferences(options.preferences);
  options = { ...options, preferences };
  if (!preferences) delete options.preferences;
  await store().insert("campaigns", {
    id,
    brand_id: brandId,
    status: "running",
    stage: "research",
    options_json: JSON.stringify(options),
    style_idem: `${id}-style`,
    strategy_idem: `${id}-strategy`,
    created_at: now(),
    updated_at: now(),
  });
  await logEvent({
    brandId,
    campaignId: id,
    message: options.concepts > 0 ? `Campaign started: ${options.concepts} videos, ${options.shotsPerConcept} shots each, ${options.videoModel}${options.statics ? ", plus static ads" : ""}` : "Campaign started: research and static ads, no videos",
  });
  if (preferences) await logEvent({ brandId, campaignId: id, message: `The customer asked for: ${preferences}` });
  return id;
}

export function clients() {
  const build = <T>(make: () => T): T | null => {
    try {
      return make();
    } catch {
      return null;
    }
  };
  return {
    claude: build(() => claudeClient()),
    fal: hasFal() ? new FalClient() : null,
    monid: build(() => new MonidClient()),
  };
}

/**
 * How many times in a row a step may hit a busy or failing provider before the campaign fails: about
 * half an hour for planning steps, about three hours for production, whose shots already back off
 * one by one and only need the campaign to keep waiting.
 */
const RETRY_LIMIT = 12;
const PRODUCTION_RETRY_LIMIT = 40;
export const retryLimit = (stage: string) => (stage === "production" ? PRODUCTION_RETRY_LIMIT : RETRY_LIMIT);
/** The wait before retrying such a step: 5 s doubling to 5 min, about half an hour in all. */
export const retryDelayMs = (attempts: number) => Math.min(300, 5 * 2 ** Math.max(0, attempts - 1)) * 1000;
/**
 * When each campaign may retry, in memory: the campaign row is rewritten every tick (spend), so it
 * can't hold this. A restart only means one retry comes sooner.
 */
const retryAfter = new Map<string, number>();

export async function advanceCampaign(id: string) {
  const campaign = await getCampaign(id);
  if (!campaign || campaign.status !== "running") return;
  if ((retryAfter.get(id) ?? 0) > Date.now()) return;
  try {
    if (campaign.stage === "research") await stepResearch(campaign);
    else if (campaign.stage === "style") await stepStyle(campaign);
    else if (campaign.stage === "strategy") await stepStrategy(campaign);
    else if (campaign.stage === "production") await stepProduction(campaign);
    if (campaign.attempts) await save("campaigns", id, { attempts: 0 });
    retryAfter.delete(id);
  } catch (error) {
    if (error instanceof ApiError && error.retryable && campaign.attempts < retryLimit(campaign.stage)) {
      const attempts = campaign.attempts + 1;
      retryAfter.set(id, Date.now() + retryDelayMs(attempts));
      await save("campaigns", id, { attempts });
      // Say so once, not on every retry.
      if (attempts === 1) await logEvent({ brandId: campaign.brand_id, campaignId: id, level: "warn", message: `A provider is busy at ${campaign.stage} (${error.message}); retrying with backoff for up to about ${campaign.stage === "production" ? "3 hours" : "30 minutes"}` });
    } else {
      const message = error instanceof Error ? error.message : String(error);
      await save("campaigns", id, { status: "failed", error: message });
      await logEvent({ brandId: campaign.brand_id, campaignId: id, level: "error", message: `Stopped at ${campaign.stage}: ${message}` });
    }
  }
  await recomputeSpend(id);
}

// ---------- research ----------

async function stepResearch(campaign: CampaignRow) {
  const { claude, monid } = clients();
  if (!monid) throw new Error("Research runs on Monid: add a Monid API key in Settings, then retry.");
  const brand = (await getBrand(campaign.brand_id))!;
  await ensureRuns(campaign.id, phaseASpecs(brand.domain));
  await progressRuns({ campaignId: campaign.id, brandId: campaign.brand_id }, monid, ["A", "C", "D"]);
  const runs = await listRuns(campaign.id);
  if (runs.some((run) => run.status === "pending" || run.status === "running")) return;

  const forCompact = runs.map((run) => ({ key: run.key, status: run.status, output: parse<unknown>(run.output_json, undefined) }));
  if (!campaign.plan_json) {
    const partial = compactResearch(brand.domain, forCompact, null);
    await save("brands", brand.id, { name: partial.brand.name || brand.name, profile_json: JSON.stringify(partial.brand) });
    const plan: ResearchPlan = claude
      ? await planResearch(claude, { domain: brand.domain, brand: partial.brand, siteExcerpt: partial.site_excerpt, similar: partial.similar_sites })
      : fallbackPlan(brand.domain, partial.brand, partial.similar_sites);
    await save("campaigns", campaign.id, { plan_json: JSON.stringify(plan) });
    await ensureRuns(campaign.id, phaseCSpecs(plan));
    await logEvent({
      brandId: brand.id,
      campaignId: campaign.id,
      message: `Research plan: ${plan.category}; competitors ${plan.competitors.map((c) => c.name).join(", ") || "unknown"}; searching ${plan.content_queries.join(", ")}`,
    });
    return;
  }

  const plan = parse<ResearchPlan | null>(campaign.plan_json, null);
  if (plan && !plan.scouted) {
    // The scout reads the first wave (who broke out, which hooks and hashtags recur) and digs further.
    const firstWave = compactResearch(brand.domain, forCompact, plan);
    const searched = [plan.brand_name, ...plan.content_queries, ...plan.competitors.map((c) => c.name)];
    let report = { notes: "", searches: [] as Array<{ platform: string; query: string; why: string }> };
    if (claude && firstWave.videos.length) {
      try {
        report = await scout(claude, { plan, videos: firstWave.videos, brand: { name: firstWave.brand.name, description: firstWave.brand.description }, alreadySearched: searched });
      } catch (error) {
        if (error instanceof ApiError && error.retryable) throw error;
      }
    }
    const specs = scoutSpecs({ notes: report.notes, searches: report.searches as Parameters<typeof scoutSpecs>[0]["searches"] });
    await ensureRuns(campaign.id, specs);
    await save("campaigns", campaign.id, { plan_json: JSON.stringify({ ...plan, scouted: true, scout_notes: report.notes }) });
    await logEvent({
      brandId: brand.id,
      campaignId: campaign.id,
      message: specs.length
        ? `Scout: ${report.notes || "following up on the first wave"} Digging into ${report.searches.map((x) => `"${x.query}" (${x.platform})`).join(", ")}`
        : `Scout: no follow-up searches${report.notes ? `. ${report.notes}` : ""}`,
    });
    return;
  }
  const pack = compactResearch(brand.domain, forCompact, plan);
  const done = runs.filter((run) => run.status === "done").length;
  if (done === 0) throw new Error("Every research source failed. Check the website address and your Monid balance, then retry.");
  const options = parse<CampaignOptions>(campaign.options_json, defaultOptions());
  const videos = options.concepts > 0;
  await save("campaigns", campaign.id, videos ? { research_json: JSON.stringify(pack), stage: options.learnStyle && claude ? "style" : "strategy" } : { research_json: JSON.stringify(pack), stage: "review", status: "review" });
  await logEvent({
    brandId: brand.id,
    campaignId: campaign.id,
    message: `Research done: ${pack.videos.length} short videos to rank, ${pack.ads.length} live ads, ${pack.reddit.length} Reddit threads, ${pack.seo.keywords.length} keywords (${done}/${runs.length} sources)`,
  });
  if (options.statics || !videos) {
    // Static packs keep their tables and renders on the local disk, so they need the SQLite store.
    if (store().kind !== "sqlite") {
      await logEvent({ brandId: brand.id, campaignId: campaign.id, level: "warn", message: "Static ads aren't available on this deployment yet: they still keep their data on the local disk." });
    } else {
      const { startStaticPack } = await import("./statics/pipeline");
      await startStaticPack(campaign.id);
    }
  }
}

// ---------- references and the product (the "style" stage) ----------

/** What the reference stage keeps on the campaign (in style_json), step by step, so a restart resumes. */
export type CreativeState = {
  slug: null;
  version: null;
  /** A readable summary of the references for the research tab. */
  skill_md: string;
  samples: string[];
  product?: ProductBrief;
  captured?: boolean;
  candidates?: Array<Pick<ReferenceCandidate, "url" | "platform" | "author" | "views" | "followers" | "origin" | "score"> & { relevance?: number; relevance_reason?: string }>;
  /** The relevance screen's verdicts, by URL (done once, before the first breakdown). */
  screened?: Array<{ url: string; relevance: number; reason: string }>;
  /** The candidates picked for a breakdown, saved before the breakdowns start (they take minutes). */
  picked?: string[];
  breakdowns?: ReferenceBreakdown[];
  failures?: Array<{ url: string; error: string }>;
  /** Reference URLs whose breakdown failed for a passing reason, retried once on the next tick. */
  retry?: string[];
  /**
   * Picked references another brand remade recently (only when the niche left too few fresh ones):
   * the director must give them a different angle so the two brands' ads don't look alike.
   */
  shared?: string[];
};

/** A researched video's lane, from the search that found it. */
export const originOf = (video: Pick<Video, "source">): ReferenceCandidate["origin"] =>
  /^tiktok_comp_/.test(video.source) ? "competitor" : /^tiktok_bench_/.test(video.source) ? "benchmark" : /^scout_/.test(video.source) ? "adjacent" : "category";

export const creativeState = (campaign: Pick<CampaignRow, "style_json">) => parse<CreativeState | null>(campaign.style_json, null);

async function stepStyle(campaign: CampaignRow) {
  const { claude, fal } = clients();
  const brand = (await getBrand(campaign.brand_id))!;
  const log = (message: string, level: "info" | "warn" = "info") => logEvent({ brandId: brand.id, campaignId: campaign.id, level, message });
  if (!claude) {
    await save("campaigns", campaign.id, { stage: "strategy" });
    return log("Skipped the reference study: no Anthropic API key.", "warn");
  }
  const pack = parse<ResearchPack | null>(campaign.research_json, null);
  if (!pack) throw new Error("Research is missing; start a new campaign.");
  const state: CreativeState = creativeState(campaign) ?? { slug: null, version: null, skill_md: "", samples: [] };
  const persist = () => save("campaigns", campaign.id, { style_json: JSON.stringify(state) });
  // Downloads for the product analyst and the reference videos: only needed within one tick.
  const work = join(scratchDir(), `work-${campaign.id}`);
  const toStrategy = async () => {
    await save("campaigns", campaign.id, { stage: "strategy" });
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  };

  if (!state.product) {
    const kit = getBrandKit(brand.id);
    const hasKit = kit.assets.length > 0 || kit.repo !== null;
    state.product = await analyzeProduct(claude, pack, work, hasKit ? kit : null);
    await persist();
    const fromKit = state.product.visuals.filter((v) => v.source.startsWith("brandkit:")).length;
    return log(
      `Product brief: ${state.product.kind}, "${state.product.one_liner}" (${state.product.visuals.length} visuals${fromKit ? `, ${fromKit} from the brand kit` : ""}${kit.repo ? `; code scanned: ${kit.repo.commands.length} commands, ${kit.repo.screens.length} screens` : ""})`,
    );
  }

  if (!state.captured) {
    if (state.product.kind !== "physical") {
      const dir = join(scratchDir(), `visuals-${campaign.id}`);
      try {
        const shots = canCaptureLocally() ? await captureSiteVisualsLocal({ domain: brand.domain, dir }) : await captureSiteVisuals({ domain: brand.domain, dir });
        // Production cuts to these on later ticks (on a serverless host, maybe another machine): keep them.
        const kept = await Promise.all(shots.map((shot, i) => keepVisual(`visuals-${campaign.id}`, { ...shot, id: `s${i + 1}` })));
        state.product.visuals.push(...kept);
        await log(`Captured ${shots.length} phone-size screenshots of ${brand.domain} to show the product on screen`);
      } catch (error) {
        if (error instanceof ApiError && error.retryable && campaign.attempts < 3) throw error;
        await log(`Could not screenshot ${brand.domain}: ${error instanceof Error ? error.message : String(error)}`, "warn");
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    state.captured = true;
    await persist();
    return;
  }

  const options = parse<CampaignOptions>(campaign.options_json, defaultOptions());
  if (!state.breakdowns || state.retry?.length) {
    const ranked = scoreCandidates(pack.videos, originOf);
    // Numbers pick viral clips; the relevance screen keeps only ones a remake would make sense for.
    if (!state.screened && options.learnStyle && ranked.length) {
      const plan = parse<ResearchPlan | null>(campaign.plan_json, null);
      try {
        state.screened = await screenRelevance(claude, ranked, { product: state.product, scoutNotes: plan?.scout_notes });
      } catch (error) {
        if (error instanceof ApiError && error.retryable && campaign.attempts < 3) throw error;
        state.screened = [];
      }
      const kept = state.screened.filter((r) => r.relevance >= 6).length;
      await log(`Relevance screen: ${kept} of ${state.screened.length} top-ranked videos could be remade for ${state.product.name}${state.screened.length ? ` (dropped: ${state.screened.filter((r) => r.relevance < 6).slice(0, 4).map((r) => r.reason).join("; ")})` : ""}`);
      await persist();
    }
    const candidates = state.screened?.length ? applyRelevance(ranked, state.screened) : ranked;
    const verdicts = new Map((state.screened ?? []).map((r) => [r.url, r]));
    state.candidates = candidates.slice(0, 20).map(({ url, platform, author, views, followers, origin, score }) => ({ url, platform, author, views, followers, origin, score, relevance: verdicts.get(url)?.relevance, relevance_reason: verdicts.get(url)?.reason }));
    // A second pass only retries the breakdowns that failed for a passing reason (a busy provider).
    // Never remake a video this brand already remade in an earlier campaign.
    const remade = await remadeReferences(brand.id, campaign.id);
    // Nor one another brand remade lately: two companies in one niche would get the same ad.
    const taken = state.retry?.length || !options.learnStyle ? [] : await takenByOtherBrands(brand.id);
    const choice = options.learnStyle && !state.retry?.length ? pickAvoidingTaken(candidates, 6, { keepOrder: Boolean(state.screened?.length), exclude: remade, taken }) : null;
    const picks = state.retry?.length ? ranked.filter((c) => state.retry!.includes(c.url)) : (choice?.picks ?? []);
    if (choice) {
      state.shared = choice.shared;
      if (choice.shared.length) await log(`Few fresh references in this niche: reusing ${choice.shared.length} that another brand remade lately; the director will give ${choice.shared.length === 1 ? "it" : "them"} a different angle`);
      else if (choice.avoided) await log(`Skipped ${choice.avoided} viral ${choice.avoided === 1 ? "video" : "videos"} another brand remade lately, so this brand's ads don't look like theirs`);
    }
    if (picks.length && !state.retry?.length) {
      // The shortlist shows (the camp's references) while the breakdowns run, which takes minutes.
      state.picked = picks.map((p) => p.url);
      await persist();
      const done = new Set(remade.map(canonicalUrl));
      const skipped = candidates.filter((c) => done.has(canonicalUrl(c.url))).length;
      await log(`Breaking down ${picks.length} outlier videos beat by beat (transcript, cuts, frames): ${picks.map((p) => `@${p.author} ${p.score.why}, clones ${cloneOf(p)}/10`).join("; ")}${skipped ? ` (skipped ${skipped} this brand already remade)` : ""}`);
    }
    const result = picks.length
      ? await breakdownAll({ message: claude.message, fal: fal ?? undefined }, picks, { workDir: work, brand: { name: state.product.name, one_liner: state.product.one_liner, kind: state.product.kind } })
      : { breakdowns: [] as ReferenceBreakdown[], failures: [] };
    const firstPass = !state.retry?.length;
    // The director reads them in this order: the ones the footage clone can reproduce first, then by fit.
    state.breakdowns = orderBreakdowns([...(state.breakdowns ?? []), ...result.breakdowns]);
    state.retry = firstPass ? result.failures.filter((f) => f.retryable).map((f) => f.candidate.url) : [];
    state.failures = [...(state.failures ?? []).filter((f) => !picks.some((p) => p.url === f.url)), ...result.failures.map((f) => ({ url: f.candidate.url, error: f.error }))];
    state.samples = state.breakdowns.map((b) => b.url);
    state.skill_md = referencesMarkdown(state);
    await persist();
    if (state.retry.length) return log(`${state.retry.length} reference video(s) hit a busy provider; retrying them once`, "warn");
    await toStrategy();
    return log(
      state.breakdowns.length
        ? `Reference study ready: ${state.breakdowns.length} videos broken down${state.failures.length ? ` (${state.failures.length} could not be read)` : ""}`
        : "No reference video could be broken down; the director works from the research alone.",
      state.breakdowns.length ? "info" : "warn",
    );
  }
  await toStrategy();
}

/** Keeps a captured image in the store's files and points the visual at a local copy of it. */
async function keepVisual(folder: string, visual: ProductVisual): Promise<ProductVisual> {
  const files = store().files;
  const key = `${folder}/${basename(visual.url)}`;
  await files.putFile(key, visual.url, /\.jpe?g$/i.test(key) ? "image/jpeg" : "image/png");
  return { ...visual, key, url: await files.localPath(key) };
}

/** The research tab's view of the reference study. */
export function referencesMarkdown(state: CreativeState) {
  const lines: string[] = [];
  if (state.product) {
    lines.push(`## Product brief`, ``, `**${state.product.name}** (${state.product.kind}): ${state.product.one_liner}`, ``, `- Problem: ${state.product.problem}`, `- Aha: ${state.product.aha}`, `- Visuals on screen: ${state.product.visuals.map((v) => `${v.id} ${v.caption}`).join("; ") || "none"}`, ``);
  }
  for (const ref of state.breakdowns ?? []) {
    lines.push(
      `## @${ref.author} on ${ref.platform}: ${ref.views.toLocaleString("en")} views${ref.outlier ? `, ${ref.outlier.toFixed(1)}x followers` : ""}`,
      ``,
      `${ref.url} · ${Math.round(ref.duration)} s · ${ref.format} · fit ${ref.fit.score}/10 (${ref.fit.reason})${ref.cloneability ? ` · clones ${ref.cloneability.score}/10${ref.footage?.hardest ? ` (hardest: ${ref.footage.hardest})` : ""}` : ""}`,
      ``,
      `**Hook** (${ref.hook.mechanic}): "${ref.hook.line}"${ref.hook.on_screen_text ? ` / on screen: "${ref.hook.on_screen_text}"` : ""}`,
      ``,
      ...ref.beats.map((b) => `- ${b.start.toFixed(1)}-${b.end.toFixed(1)}s **${b.job}** (${b.shot}): ${b.visual}${b.line ? ` / "${b.line}"` : ""}`),
      ``,
      `Why it works: ${ref.why_it_works}`,
      ``,
    );
  }
  if (state.failures?.length) lines.push(`Could not read: ${state.failures.map((f) => `${f.url} (${f.error})`).join("; ")}`);
  return lines.join("\n");
}

// ---------- strategy ----------

/** The director's model. */
const DIRECTOR_MODEL = "anthropic/claude-sonnet-5.5";

async function stepStrategy(campaign: CampaignRow) {
  const { claude, fal } = clients();
  if (!claude) throw new Error("The strategist runs on Anthropic: add an Anthropic API key in Settings, then retry.");
  const brand = (await getBrand(campaign.brand_id))!;
  const options = parse<CampaignOptions>(campaign.options_json, defaultOptions());
  const pack = parse<ResearchPack | null>(campaign.research_json, null);
  if (!pack) throw new Error("Research is missing; start a new campaign.");
  const state = creativeState(campaign);
  const product = state?.product ?? (await import("./creative/product")).fallbackBrief(pack);
  const breakdowns = state?.breakdowns ?? [];
  const shared = state?.shared ?? [];

  // The director's briefs are in: the script room writes each video, then production starts.
  if (campaign.strategy_json) return scriptRoom(campaign, claude, product, breakdowns);
  // remake (persona portraits, twin frames) and filmed_screen (a photo of a monitor) make images on fal.
  const falOnly: Partial<Record<string, string>> = fal ? {} : { remake: "talking_head_broll", filmed_screen: "voiceover_demo" };
  // The format mix applies only to a campaign made with it (a static-ads-only one has no videos).
  const formats = options.formats?.length === options.concepts ? options.formats : undefined;
  const keep = async (output: unknown) => {
    const strategy = normalizeStrategy(output, options, { referenceIds: breakdowns.map((b) => b.id), visualIds: product.visuals.map((v) => v.id) });
    // A required format mix wins over the director's choice, brief by brief.
    for (const [i, brief] of (strategy.campaign.briefs ?? []).entries()) brief.format = formats?.[i] ?? brief.format;
    for (const brief of strategy.campaign.briefs ?? []) brief.format = (falOnly[brief.format] as typeof brief.format | undefined) ?? brief.format;
    if (!strategy.campaign.briefs?.length) throw new Error("The creative director returned no video briefs.");
    await save("campaigns", campaign.id, { strategy_json: JSON.stringify(strategy) });
    await logEvent({
      brandId: brand.id,
      campaignId: campaign.id,
      message: `Campaign "${strategy.campaign.name}": ${strategy.campaign.briefs.map((b) => `"${b.title}" (${b.format.replace(/_/g, " ")})`).join(", ")}. The script room is writing them.`,
    });
  };

  await logEvent({ brandId: brand.id, campaignId: campaign.id, message: `The creative director is choosing which ${breakdowns.length ? "reference videos to transplant" : "patterns to use"} for ${options.concepts} videos` });
  const reply = await claude.messageStream({
    model: DIRECTOR_MODEL,
    max_tokens: 32_000,
    system: DIRECTOR_PROMPT,
    messages: [{ role: "user", content: `${strategyMessage(pack, { product, breakdowns, shared }, options, await pastResults(brand.id, campaign.id))}\n\n${Object.keys(falOnly).length ? `\n\nThis deployment cannot make the ${Object.keys(falOnly).join(" or ")} formats: choose from the others.` : ""}\n\n${formats ? `\n\nThis campaign must make exactly ${formats.length} videos, one in each of these formats, in this order: ${formats.join(", ")}. Write each brief for its format, and pick for each the reference that suits that format best.` : ""}\n\nAnswer by calling submit_strategy once, with every video brief filled in.` }],
    tools: [{ name: "submit_strategy", description: "Return the brand brief, the search plan and one video brief per video.", input_schema: STRATEGY_SCHEMA }],
  });
  await save("campaigns", campaign.id, { strategy_spend_micro: claudeCostMicro(DIRECTOR_MODEL, reply.usage) });
  const output = reply.content.find((block) => block.type === "tool_use" && block.name === "submit_strategy")?.input;
  if (!output) throw new ApiError("anthropic", 502, "no_strategy", "the creative director answered without a structured plan");
  return keep(output);
}

/**
 * The script room: every brief gets a writer and a critic in parallel. Finished concepts are saved
 * as they land, so a restart only rewrites the ones that were missing.
 */
async function scriptRoom(campaign: CampaignRow, claude: Pick<ClaudeClient, "message">, product: ProductBrief, breakdowns: ReferenceBreakdown[]) {
  const { preferences } = parse<Partial<CampaignOptions>>(campaign.options_json, {});
  const strategy = parse<Strategy>(campaign.strategy_json, null as unknown as Strategy);
  const briefs = strategy.campaign.briefs ?? [];
  const done = strategy.campaign.concepts ?? [];
  const pending = briefs.filter((brief) => !done.some((concept) => concept.brief?.title === brief.title));
  const round = (strategy.campaign.script_rounds ?? 0) + 1;
  strategy.campaign.script_rounds = round;
  const site = pending.some((brief) => brief.format === "brainrot") ? siteOf((await store().find<{ url: string }>("brands", { id: campaign.brand_id }, { limit: 1 }))[0]?.url) || product.name : "";
  const results = await Promise.allSettled(
    pending.map(async (brief) => {
      // Brainrot ads riff on the director's reference in one of Adtopia's brainrot formats.
      if (brief.format === "brainrot") {
        const riff = breakdowns.find((b) => b.id === brief.reference_id);
        return brainrotConcept(brief, await writeBrainrot({ product, site, bit: pickBit(brief, product.name), brief, riff: riff ? riffOf(riff) : null }));
      }
      const reference = breakdowns.find((b) => b.id === brief.reference_id) ?? breakdowns[0];
      const script = await writeScript(claude, { product, brief, reference: reference ?? emptyReference(), targetSeconds: reference ? targetSeconds(reference, brief.format) : 18, preferences });
      const plan = planProduction(script, brief, product, reference?.delivery ?? "", reference?.beats ?? []);
      return conceptFrom(brief, script, plan, reference, product);
    }),
  );
  const failures: string[] = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") done.push(result.value);
    else if (!(result.reason instanceof ApiError && result.reason.retryable) || round >= 4) failures.push(`"${pending[i].title}": ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
  });
  strategy.campaign.concepts = briefs.map((brief) => done.find((concept) => concept.brief?.title === brief.title)).filter((c): c is Concept => Boolean(c));
  await save("campaigns", campaign.id, { strategy_json: JSON.stringify(strategy) });
  for (const failure of failures) await logEvent({ brandId: campaign.brand_id, campaignId: campaign.id, level: "warn", message: `The script room could not write ${failure}` });
  const outstanding = briefs.length - strategy.campaign.concepts.length - failures.length;
  if (outstanding > 0) return; // retryable trouble: try the rest next tick
  if (strategy.campaign.concepts.length === 0) throw new Error("The script room could not write any of the videos.");

  // Videos first, then the stage, so a tick that reads "production" always finds them; and only
  // once, so a tick that died in between doesn't add a second set.
  if ((await listCreatives(campaign.id)).length === 0) {
    for (const [idx, concept] of strategy.campaign.concepts.entries()) await insertCreative(campaign.id, idx, concept);
  }
  await save("campaigns", campaign.id, { stage: "production" });
  await logEvent({
    brandId: campaign.brand_id,
    campaignId: campaign.id,
    message: `Scripts ready: ${strategy.campaign.concepts.map((c) => `"${c.title}" ${c.script?.total_seconds ?? "?"}s, critic ${c.script?.review?.score ?? "?"}/10`).join("; ")}. Now producing.`,
  });
}

function emptyReference(): ReferenceBreakdown {
  return {
    id: "",
    url: "",
    platform: "tiktok",
    author: "",
    views: 0,
    followers: null,
    outlier: null,
    duration: 18,
    format: "talking head with product cutaways and captions",
    hook: { line: "", on_screen_text: "", visual: "", mechanic: "a relatable problem stated bluntly in the first second" },
    beats: [],
    pacing: { cuts: 0, avg_shot_seconds: 3, words_per_minute: null },
    caption_style: "bold white captions",
    delivery: "casual, direct",
    why_it_works: "",
    fit: { score: 5, reason: "no reference available" },
    transcript: "",
  };
}

/** What this brand's earlier posted videos did, so the next campaign learns from them. */
async function pastResults(brandId: string, currentCampaignId: string): Promise<PastResult[]> {
  const { postStats } = await import("./publish");
  type Post = { creative_id: string; platforms_json: string; status: string; result_json: string | null; analytics_json: string | null; error: string | null };
  const posts = await store().find<Post>("posts", { brand_id: brandId, status: { in: ["posted", "failed"] } }, { order: [["created_at", "desc"]] });
  const creatives = posts.length ? await store().find<{ id: string; campaign_id: string; concept_json: string }>("creatives", { id: { in: [...new Set(posts.map((p) => p.creative_id))] } }) : [];
  const byId = new Map(creatives.map((c) => [c.id, c]));
  const rows = posts
    .map((post) => ({ post, creative: byId.get(post.creative_id) }))
    .filter((row) => row.creative && row.creative.campaign_id !== currentCampaignId)
    .slice(0, 12);
  return rows.map(({ post, creative }) => {
    const concept = parse<Partial<Concept>>(creative!.concept_json, {});
    const { url, ...stats } = postStats(post);
    return {
      title: concept.title ?? "",
      format: concept.format ?? "",
      hook: concept.hook ?? "",
      platforms: parse<string[]>(post.platforms_json, []),
      status: post.status,
      url,
      stats: Object.keys(stats).length ? stats : null,
      error: post.status === "failed" ? post.error : null,
      analytics: parse<Record<string, unknown> | null>(post.analytics_json, null),
    };
  });
}

/**
 * The reference videos this brand already remade in its other campaigns (from each video's concept),
 * so the next campaign picks new ones. A remake that failed outright does not count.
 */
export async function remadeReferences(brandId: string, exceptCampaignId: string): Promise<string[]> {
  const campaigns = await store().find<{ id: string }>("campaigns", { brand_id: brandId, id: { ne: exceptCampaignId } });
  return referencesRemadeIn(campaigns.map((c) => c.id));
}

/** Days a reference stays taken once another brand remade it. */
export const TAKEN_DAYS = 60;

/**
 * The reference videos other brands remade in the last TAKEN_DAYS days. Two brands that find the
 * same viral video are in the same niche; if both remade it, their ads would look alike. Only the
 * links leave this function: nothing about the other brand reaches this brand's agents.
 */
export async function takenByOtherBrands(brandId: string, now = new Date()): Promise<string[]> {
  const since = new Date(now.getTime() - TAKEN_DAYS * 86_400_000).toISOString();
  const campaigns = await store().find<{ id: string }>("campaigns", { brand_id: { ne: brandId }, created_at: { gte: since } });
  return referencesRemadeIn(campaigns.map((c) => c.id));
}

async function referencesRemadeIn(campaignIds: string[]): Promise<string[]> {
  const rows = campaignIds.length ? await store().find<{ concept_json: string }>("creatives", { campaign_id: { in: campaignIds }, status: { ne: "failed" } }) : [];
  const urls = rows.map((row) => parse<Partial<Concept>>(row.concept_json, {}).reference?.url).filter((url): url is string => Boolean(url));
  return [...new Set(urls)];
}

/** What the customer asked for in the brand's latest campaign, for the next one (autopilot, "new campaign"). */
export async function lastPreferences(brandId: string): Promise<string | undefined> {
  const [latest] = await store().find<{ options_json: string }>("campaigns", { brand_id: brandId }, { order: [["created_at", "desc"]], limit: 1 });
  return latest ? cleanPreferences(parse<Partial<CampaignOptions>>(latest.options_json, {}).preferences) : undefined;
}

// ---------- production ----------

async function stepProduction(campaign: CampaignRow) {
  const { claude, fal, monid } = clients();
  // Real-creator mode: each brief is cast to a creator and approved by the client-taste agent.
  if (parse<Partial<CampaignOptions>>(campaign.options_json, {}).production === "creators") {
    const { stepCastingStage } = await import("./casting-job");
    const cast = await stepCastingStage(campaign, { claude, monid });
    if (cast.settled) {
      await save("campaigns", campaign.id, { stage: "review", status: "review" });
      await logEvent({ brandId: campaign.brand_id, campaignId: campaign.id, message: `${cast.ready} of ${cast.total} briefs have an approved creator; their outreach waits for you` });
    }
    return;
  }
  const strategy = parse<Strategy | null>(campaign.strategy_json, null);
  if (!strategy) throw new Error("The campaign has no strategy yet.");
  const ctx: ProductionContext = {
    campaignId: campaign.id,
    brandId: campaign.brand_id,
    claude,
    fal,
    monid,
    strategy,
    product: creativeState(campaign)?.product,
    kit: (() => {
      const kit = getBrandKit(campaign.brand_id);
      return kit.assets.length || kit.repo ? kit : null;
    })(),
  };
  const active = (await listCreatives(campaign.id)).filter((creative) => !creative.rejected);
  await Promise.all(active.filter((c) => c.status === "queued" || c.status === "producing").map((creative) => advanceCreative(ctx, creative)));
  const now_ = (await listCreatives(campaign.id)).filter((creative) => !creative.rejected);
  if (now_.every((creative) => creative.status === "ready" || creative.status === "failed")) {
    const ready = now_.filter((creative) => creative.status === "ready").length;
    await save("campaigns", campaign.id, { stage: "review", status: "review" });
    await logEvent({ brandId: campaign.brand_id, campaignId: campaign.id, message: `${ready} of ${now_.length} videos are ready for review` });
    // Posting stays opt-in: the global autopilot setting, or this brand's loop with automatic posting on.
    const autopost = getBool("autopilot") || (await (await import("./loop")).autopostOn(campaign.brand_id));
    if (autopost && ready > 0) {
      const { approveAll, publishCampaign } = await import("./publish");
      await approveAll(campaign.id);
      await publishCampaign(campaign.id, "daily").catch((error: unknown) =>
        logEvent({ brandId: campaign.brand_id, campaignId: campaign.id, level: "warn", message: `Autopilot could not schedule posts: ${error instanceof Error ? error.message : String(error)}` }),
      );
    }
  }
}

/** A fresh take on one concept, optionally steered by a note from the reviewer. */
export async function regenerateCreative(creativeId: string, note?: string) {
  const [creative] = await store().find<CreativeRow>("creatives", { id: creativeId }, { limit: 1 });
  if (!creative) throw new Error("No such video");
  const campaign = (await getCampaign(creative.campaign_id))!;
  const concept = parse<Concept>(creative.concept_json, null as unknown as Concept);
  if (note?.trim()) {
    concept.shots = concept.shots.map((shot) => ({ ...shot, video_prompt: `${shot.video_prompt}\nDirector's note for this take: ${note.trim()}`, frame_prompt: `${shot.frame_prompt}\nDirector's note: ${note.trim()}` }));
  }
  await save("creatives", creative.id, { rejected: 1, approved: 0 });
  const id = await insertCreative(campaign.id, creative.idx, concept, creative.generation + 1);
  await save("campaigns", campaign.id, { stage: "production", status: "running", error: null });
  await logEvent({ brandId: campaign.brand_id, campaignId: campaign.id, message: `Re-rendering "${concept.title}"${note?.trim() ? ` with the note: ${note.trim()}` : ""}` });
  return id;
}

/** Stops a campaign where it is. */
export async function stopCampaign(id: string) {
  const campaign = await getCampaign(id);
  if (!campaign) throw new Error("No such campaign");
  await save("campaigns", id, { status: "stopped", error: "Stopped by you" });
  await logEvent({ brandId: campaign.brand_id, campaignId: id, level: "warn", message: `Stopped at ${campaign.stage}` });
}

export async function retryCampaign(id: string) {
  const campaign = await getCampaign(id);
  if (!campaign) throw new Error("No such campaign");
  if (campaign.stage === "research") await requeueFailedRuns(id, ["A", "C", "D"]);
  if (campaign.stage === "production") {
    for (const creative of (await listCreatives(id)).filter((c) => c.status === "failed" && !c.rejected)) await regenerateCreative(creative.id);
  }
  await save("campaigns", id, { status: "running", error: null, attempts: 0 });
  await logEvent({ brandId: campaign.brand_id, campaignId: id, message: `Retrying from ${campaign.stage}` });
}

export async function recomputeSpend(campaignId: string) {
  const campaign = await getCampaign(campaignId);
  if (!campaign) return;
  const research = (await listRuns(campaignId, ["A", "C", "D", "S"])).reduce((sum, run) => sum + (run.cost_micro ?? 0), 0);
  let monidVideo = 0;
  for (const creative of await listCreatives(campaignId)) {
    for (const shot of parse<ShotState[]>(creative.shots_json, [])) {
      // fal renders count alongside Monid's render spend.
      monidVideo += shot.monid_cost + (shot.fal_cost ?? 0);
    }
  }
  await save("campaigns", campaignId, {
    naive_spend_micro: campaign.style_spend_micro + campaign.strategy_spend_micro,
    monid_spend_micro: research + monidVideo,
  });
}
