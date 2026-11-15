// The brainrot maker: one video from its script, each piece paid for once and kept by key, so a
// restart, a crash or a busy provider costs time, not money.
//
//   voice lines (ElevenLabs direct, or ElevenLabs on Monid) -> shot lengths
//   -> music and sound effects (ElevenLabs direct or Monid, ffmpeg fallback for SFX)
//   -> characters and stills (fal image model) -> clips (fal video model, silent use)
//   -> QC of every clip (Claude vision; one re-render for a failed clip) -> the cut -> QC of the cut
//
// The cost guard compares what is spent plus what is left with the cap before every paid step; the
// video model's real price per second is updated on its first clip when the provider reports it.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { claudeCostMicro } from "../claude";
import { ElevenLabsClient } from "../elevenlabs";
import { FAL, FAL_USD, type FalClient, falImageUrl, falVideoUrl } from "../fal";
import { ApiError } from "../http";
import { download, extractFrames, ffmpegPath, probe, scratchDir } from "../media";
import { type MonidRunner, outputLink, runCostMicro, runToEnd } from "../monid";
import { QC_MODEL } from "../qc";
import { extractJson } from "../research";
import { getSetting } from "../settings";
import type { Files } from "../store/types";
import { type BrainrotScript, type BrainrotSfx, type ClaudeAsk, PRICES, planBrainrot, RECIPES, shotSeconds, videoSeconds } from "./brainrot";
import { buildCut, renderCut, shotDurations, SLOWEST } from "./brainrot-cut";
import { OverBudget, patient } from "./remake";
import type { ProductBrief } from "./types";

const exec = promisify(execFile);

export { OverBudget, videoSeconds };

export type BrainrotEleven = {
  tts: ElevenLabsClient["tts"];
  music?: (prompt: string, durationMs: number) => Promise<Buffer>;
  sfx?: (text: string, durationSeconds: number) => Promise<Buffer>;
};

export type BrainrotDeps = {
  claude: ClaudeAsk;
  fal: Pick<FalClient, "submit" | "status" | "result" | "run">;
  /** Direct ElevenLabs audio (TTS, music, SFX). When unset or out of credits, Monid runs them instead. */
  eleven?: BrainrotEleven | null;
  monid: MonidRunner | null;
  files: Files;
  fetchUrl?: (url: string, path: string) => Promise<void>;
};

export type BrainrotSpend = { claude_micro: number; fal_micro: number; eleven_micro: number; monid_micro: number };

export type BrainrotInput = {
  /** Keys go under `<prefix>/brainrot/...`; the cut is `<prefix>/final.mp4` ("crv_..."). */
  prefix: string;
  script: BrainrotScript;
  product: ProductBrief;
  site: string;
  /** A fal video model ("fal-ai/veo3.1/lite/image-to-video"). */
  videoModel: string;
  /** USD per second assumed for the video model until a clip reports its price. */
  videoPerSecond?: number;
  maxUsd: number;
  /** Vision checks of the clips and the cut (default on). */
  qc?: boolean;
  /** Stop after the first clip, with the video model's measured price. */
  probe?: boolean;
  /** Cut it again from the kept pieces (and check the new cut), after the cut itself changed. */
  recut?: boolean;
  /** The end card: the mascot with the site over it (default), or the product's own page. */
  endCard?: "mascot" | "page";
  pollMs?: number;
  onEvent?: (message: string) => void;
};

export type ClipCheck = { n: number; pass: boolean; issues: string[]; fix: string };
export type CutCheck = { score: number; safe: boolean; issues: string[] };

export type BrainrotShotView = { n: number; status: "pending" | "rendering" | "rendered" | "failed"; seconds: number; still_key: string | null; cost_micro: number; error: string | null };

export type BrainrotResult = {
  key: string | null;
  poster_key: string | null;
  path: string | null;
  duration: number;
  spend: BrainrotSpend;
  /** USD per second the video model was billed, measured on the clips. */
  per_second: number | null;
  qc: CutCheck | null;
  notes: string[];
  shots: BrainrotShotView[];
};

type ClipRecord = { job?: string; endpoint?: string; key?: string; renders?: number; seconds?: number; cost_micro?: number; error?: string; check?: ClipCheck; fixed?: boolean };
type ImageRecord = { key: string; url: string };

type Manifest = {
  version: 1;
  spend: BrainrotSpend;
  voice: Record<string, { key: string; seconds: number }>;
  music: { bed?: string; hype?: string };
  characters: Record<string, ImageRecord>;
  stills: Record<string, ImageRecord>;
  clips: Record<string, ClipRecord>;
  /** The video model's price per second, from its finished clips. */
  measured?: { per_second: number; seconds: number; micro: number };
  checked?: boolean;
  final?: { key: string; poster?: string; duration: number };
  qc?: CutCheck;
  notes: string[];
};

/** The sound effects every brainrot video can use, kept once for all of them. */
export const sfxKey = (name: BrainrotSfx) => `brainrot/sfx/${name}.mp3`;

/** How each sound effect is asked for (ElevenLabs sound generation; the chant is a shouted voice line). */
export const SFX_PROMPTS: Record<BrainrotSfx, { text: string; seconds: number }> = {
  vine_boom: { text: "Vine boom meme sound effect: one huge deep bass boom with a short reverb tail", seconds: 1.5 },
  bass_drop: { text: "Massive distorted 808 bass drop hit, bass boosted meme sound", seconds: 2 },
  airhorn: { text: "MLG air horn blast, three quick loud stabs", seconds: 1.6 },
  record_scratch: { text: "Vinyl record scratch, the music stops", seconds: 1 },
  whoosh: { text: "Fast cinematic whoosh transition", seconds: 0.8 },
  ding: { text: "Bright notification ding", seconds: 0.8 },
  crowd_ohh: { text: "Small crowd going ooooh in surprise", seconds: 1.8 },
  sad_violin: { text: "Tiny sad violin sting, comedic and over the top", seconds: 2.5 },
  cash: { text: "Cash register ka-ching", seconds: 1 },
  explosion: { text: "Huge cartoon explosion boom with debris raining down", seconds: 1.8 },
  aura_up: { text: "Anime power-up aura whoosh with a rising shimmering synth", seconds: 1.6 },
  six_seven: { text: "SIX SEVEN!", seconds: 1.2 },
};

/** The voice that shouts the 6-7 chant. */
export const CHANT_VOICE = "g4ucswVjPpazgbDDe327";

/** Calls ElevenLabs's binary audio POST endpoints (music and sound generation). */
async function elevenPost(path: string, body: Record<string, unknown>, timeoutMs: number): Promise<Buffer> {
  const key = getSetting("elevenlabs_api_key");
  if (!key) throw new ApiError("elevenlabs", 401, "not_configured", "no ElevenLabs API key; add one in Settings");
  const base = getSetting("elevenlabs_base_url").replace(/\/$/, "");
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const out = res.status === 402 || /quota|credit/i.test(text);
    throw new ApiError("elevenlabs", out ? 402 : res.status, out ? "quota_exceeded" : `http_${res.status}`, text.slice(0, 300) || `ElevenLabs HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Direct ElevenLabs audio client using `ElevenLabsClient` for TTS and direct HTTP for music/SFX. */
export function elevenAudioClient(): BrainrotEleven {
  const client = new ElevenLabsClient();
  return {
    tts: (voiceId, body) => client.tts(voiceId, body),
    music: (prompt, durationMs) => elevenPost("/v1/music?output_format=mp3_44100_128", { prompt, music_length_ms: durationMs, model_id: "music_v1", force_instrumental: true }, 180_000),
    sfx: (text, durationSeconds) => elevenPost("/v1/sound-generation?output_format=mp3_44100_128", { text, duration_seconds: durationSeconds, prompt_influence: 0.6 }, 90_000),
  };
}

/** Resolves a brainrot video model setting into a fal endpoint and input format. */
export function falVideoEndpoint(model: string): { endpoint: string; kind: "veo" | "kling" | "generic" } {
  if (/kling/i.test(model)) return { endpoint: model.includes("fal-ai/") ? model : FAL.i2v, kind: "kling" };
  if (/veo/i.test(model)) return { endpoint: model.includes("fal-ai/") ? model : "fal-ai/veo3.1/lite/image-to-video", kind: "veo" };
  return { endpoint: model, kind: "generic" };
}

/** The end card's picture: the product's own home page as a phone shows it, else any screenshot or big photo. */
export function endVisual(product: ProductBrief): ProductBrief["visuals"][number] | null {
  const shots = product.visuals.filter((v) => v.kind === "screenshot");
  return shots.find((v) => /capture:mobile:\/$/.test(v.source)) ?? shots[0] ?? product.visuals.find((v) => v.kind === "photo" && (v.width ?? 0) >= 400) ?? null;
}

const VOICE_SETTINGS = { stability: 0.35, similarity_boost: 0.75 };

/** A voice line cut to the speech (ElevenLabs reads have air at both ends), played `tempo` times faster with its pitch kept. */
export async function tighten(input: string, out: string, tempo = 1) {
  const bin = await ffmpegPath();
  if (!bin) return input;
  const quiet = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05";
  // Pauses inside the line are cut to 0.3 s: some voices read every full stop as a long beat.
  const pauses = "silenceremove=stop_periods=-1:stop_duration=0.3:stop_threshold=-42dB";
  const faster = Math.abs(tempo - 1) > 0.01 ? `,atempo=${Math.min(2, Math.max(0.5, tempo)).toFixed(3)}` : "";
  await exec(bin, ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", input, "-af", `${quiet},areverse,${quiet},areverse,${pauses}${faster}`, "-ar", "44100", "-ac", "1", out]);
  return out;
}

/** A stand-in sound effect drawn by ffmpeg, when ElevenLabs can't make one. */
async function synthSfx(name: BrainrotSfx, out: string) {
  const bin = await ffmpegPath();
  if (!bin) throw new Error("ffmpeg is not available");
  const src: Partial<Record<BrainrotSfx, string>> = {
    vine_boom: "aevalsrc='0.9*sin(2*PI*55*t*(1-0.25*t))*exp(-3*t)':d=1.5",
    bass_drop: "aevalsrc='0.9*sin(2*PI*(95-40*t)*t)*exp(-1.1*t)':d=2",
    explosion: "anoisesrc=d=1.6:c=brown:a=0.9,afade=t=out:st=0.1:d=1.5",
    airhorn: "aevalsrc='0.3*(sin(2*PI*440*t)+sin(2*PI*554*t)+sin(2*PI*659*t))*lt(mod(t,0.5),0.38)':d=1.5",
    ding: "aevalsrc='0.6*sin(2*PI*1318*t)*exp(-6*t)':d=0.8",
  };
  await exec(bin, ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", src[name] ?? "anoisesrc=d=0.8:c=pink:a=0.5,afade=t=in:d=0.3,afade=t=out:st=0.4:d=0.4", "-ac", "1", "-ar", "44100", out]);
}

const CHECK_TOOL = {
  name: "clip_checks",
  description: "Record the verdict for every clip.",
  input_schema: {
    type: "object",
    required: ["shots"],
    properties: {
      shots: {
        type: "array",
        items: {
          type: "object",
          required: ["n", "pass", "issues", "fix"],
          properties: { n: { type: "integer" }, pass: { type: "boolean" }, issues: { type: "array", items: { type: "string" } }, fix: { type: "string", description: "If it fails: one sentence to add to the clip's prompt that avoids the problem. Else ''." } },
        },
      },
    },
  },
};

const CUT_TOOL = {
  name: "cut_check",
  description: "Record the verdict on the finished video.",
  input_schema: {
    type: "object",
    required: ["score", "safe", "issues"],
    properties: { score: { type: "integer", description: "1-10" }, safe: { type: "boolean" }, issues: { type: "array", items: { type: "string" } } },
  },
};

/** What must never be on screen, for both checks. */
const OFF_LIMITS =
  "a real or recognizable person (a celebrity, streamer, politician or any real face); someone else's known character (Tung Tung Tung Sahur, Tralalero Tralala, Skibidi Toilet, cartoon, game or anime characters) or another brand's logo; anything sexual or nude; gore or injury; a stunt that reads as suicide, self-harm or a fatal fall";

const isOutOfCreditsOrAuth = (error: unknown) =>
  error instanceof ApiError && (error.outOfCredits || error.status === 401 || error.status === 402 || error.status === 403 || error.status === 404);

const callCostMicro = (usage: unknown) => {
  const real = usage ? claudeCostMicro(QC_MODEL, usage as Parameters<typeof claudeCostMicro>[1]) : 0;
  return real > 0 ? real : Math.round(PRICES.call * 1e6);
};

/**
 * Makes one brainrot video. Resumable from its manifest; a busy provider throws a retryable
 * ApiError and the next run picks up where this one stopped.
 */
export async function makeBrainrot(deps: BrainrotDeps, input: BrainrotInput): Promise<BrainrotResult> {
  const claude = patient({ ask: deps.claude }).ask;
  const falPoll = patient({
    status: (endpoint: string, jobId: string) => deps.fal.status(endpoint, jobId),
    result: (endpoint: string, jobId: string, st: unknown) => deps.fal.result(endpoint, jobId, st as Awaited<ReturnType<FalClient["status"]>>),
  });
  const { files } = deps;
  const prefix = `${input.prefix}/brainrot`;
  const manifestKey = `${prefix}/manifest.json`;
  const dir = join(scratchDir(), `brainrot-${input.prefix.replace(/[^\w.-]+/g, "-")}`);
  await mkdir(dir, { recursive: true });
  const say = (message: string) => input.onEvent?.(message);
  const pollMs = input.pollMs ?? 8000;
  const fetchTo = deps.fetchUrl ?? download;
  const script = input.script;
  const recipe = RECIPES[script.bit];
  const plan = planBrainrot(script);
  const loaded = (await files.exists(manifestKey)) ? (JSON.parse(await readFile(await files.localPath(manifestKey), "utf8")) as Partial<Manifest>) : {};
  const manifest: Manifest = {
    version: 1,
    spend: { claude_micro: 0, fal_micro: 0, eleven_micro: 0, monid_micro: 0 },
    voice: {},
    music: {},
    characters: {},
    stills: {},
    clips: {},
    notes: [],
    ...(loaded.version === 1 ? loaded : {}),
  };
  let saving = Promise.resolve();
  const persist = () =>
    (saving = saving.then(async () => {
      const path = join(dir, "manifest.json");
      await writeFile(path, JSON.stringify(manifest));
      await files.putFile(manifestKey, path, "application/json");
    }));
  const keep = async (name: string, path: string, type: string) => {
    const key = `${prefix}/${name}`;
    await files.putFile(key, path, type);
    return key;
  };
  const local = async (key: string | null | undefined) => {
    if (!key) return null;
    if (existsSync(key)) return key;
    if (!(await files.exists(key))) return null;
    const path = await files.localPath(key).catch(() => null);
    return path && existsSync(path) ? path : null;
  };
  const refUrl = async (key: string, cachedUrl?: string): Promise<string | null> => {
    const remote = await files.url(key).catch(() => null);
    if (remote && /^https?:\/\//.test(remote)) return remote;
    if (cachedUrl && /^(https?:|data:)/.test(cachedUrl)) return cachedUrl;
    const lp = await files.localPath(key).catch(() => null);
    if (lp && existsSync(lp)) return `data:image/png;base64,${(await readFile(lp)).toString("base64")}`;
    return remote ?? cachedUrl ?? null;
  };
  const spent = () => (manifest.spend.claude_micro + manifest.spend.fal_micro + manifest.spend.eleven_micro + manifest.spend.monid_micro) / 1e6;
  const note = (text: string) => {
    if (!manifest.notes.includes(text)) manifest.notes.push(text);
  };
  const perSecond = () => manifest.measured?.per_second ?? input.videoPerSecond ?? 0.05;

  // ---------- the cost guard ----------
  const planned = (n: number) => {
    const shot = script.shots[n - 1];
    const voice = manifest.voice[String(n)];
    return voice ? voice.seconds + 0.34 : shotSeconds(shot, recipe);
  };
  const left = () => {
    // A probe only pays for the voice, the characters and the first shot's still and clip.
    const probing = Boolean(input.probe && !manifest.measured);
    const shots = script.shots;
    const pictured = probing ? shots.slice(0, 1) : shots;
    const chars = shots.filter((s) => s.words && !manifest.voice[String(s.n)]).reduce((sum, s) => sum + s.words.length + recipe.voice.tags.length, 0) + (script.end.line && !manifest.voice.end ? script.end.line.length : 0);
    const total = shots.reduce((sum, s) => sum + planned(s.n), 0) + 3;
    const musicSeconds = probing ? 0 : (manifest.music.bed ? 0 : total + 2) + (script.music.turn && !manifest.music.hype ? total / 2 : 0);
    const images = plan.characters.filter((c) => !manifest.characters[c.id]).length + pictured.filter((s) => !manifest.stills[String(s.n)]).length;
    const clips = pictured.filter((s) => !manifest.clips[String(s.n)]?.key).reduce((sum, s) => sum + videoSeconds(input.videoModel, (planned(s.n) + 0.2) / SLOWEST), 0);
    const checks = input.qc === false || probing ? 0 : (manifest.checked ? 0 : 1) + (manifest.qc ? 0 : 1);
    return (chars / 1000) * PRICES.ttsPerK + (musicSeconds / 60) * PRICES.musicPerMin + images * PRICES.image + clips * perSecond() + checks * PRICES.call;
  };
  const guard = (step: string) => {
    const ahead = left();
    if (spent() + ahead > input.maxUsd + 1e-6) throw new OverBudget(`brainrot ${step}: $${spent().toFixed(2)} spent + about $${ahead.toFixed(2)} to go is over the $${input.maxUsd.toFixed(2)} cap`);
  };

  // ---------- audio: direct ElevenLabs first, else ElevenLabs on Monid ----------
  let elevenOut = !deps.eleven;
  let monidOut = !deps.monid;
  const monidEleven = async (endpoint: string, body: Record<string, unknown>, name: string): Promise<string | null> => {
    if (monidOut || !deps.monid) return null;
    try {
      const done = await runToEnd(deps.monid, "elevenlabs", endpoint, { body }, { pollMs: Math.min(pollMs, 2000), timeoutMs: 6 * 60_000 });
      manifest.spend.monid_micro += runCostMicro(done);
      const link = outputLink(done.output, "audio");
      if (!link) throw new ApiError("monid", 502, "no_audio", `ElevenLabs ${endpoint} returned no audio for ${name}`);
      const raw = join(dir, `${name.replace(/\//g, "-")}-raw.mp3`);
      await fetchTo(link, raw);
      return raw;
    } catch (error) {
      if (!(error instanceof ApiError && (error.outOfCredits || error.status === 402))) throw error;
      monidOut = true;
      note("Monid's wallet was empty during audio generation");
      return null;
    }
  };
  const directWrite = async (buf: Buffer, name: string, costUsd: number) => {
    manifest.spend.eleven_micro += Math.round(costUsd * 1e6);
    const raw = join(dir, `${name.replace(/\//g, "-")}-raw.mp3`);
    await writeFile(raw, buf);
    return raw;
  };
  const speech = async (text: string, name: string, voice: { eleven: string; tags: string; settings?: Record<string, number> }): Promise<string> => {
    const tagged = `${voice.tags} ${text}`.trim();
    const settings = voice.settings ?? VOICE_SETTINGS;
    if (deps.eleven && !elevenOut) {
      try {
        const buf = await deps.eleven.tts(voice.eleven, { text: tagged, model_id: "eleven_v4", voice_settings: settings });
        return await directWrite(buf, name, (tagged.length / 1000) * PRICES.ttsPerK);
      } catch (error) {
        if (!isOutOfCreditsOrAuth(error) || monidOut) throw error;
        elevenOut = true;
        note("ElevenLabs direct key unavailable; falling back to Monid");
      }
    }
    const viaMonid = await monidEleven("/text-to-speech", { text: tagged, voice_id: voice.eleven, model_id: "eleven_v4", voice_settings: settings }, name);
    if (viaMonid) return viaMonid;
    throw new ApiError("elevenlabs", 402, "no_audio_provider", `no ElevenLabs or Monid provider available for ${name}`);
  };
  const music = async (prompt: string, seconds: number, name: string): Promise<string | null> => {
    const full = `${prompt}. Instrumental, no vocals.`;
    const lengthMs = Math.round(seconds * 1000);
    if (deps.eleven?.music && !elevenOut) {
      try {
        const buf = await deps.eleven.music(full, lengthMs);
        return await directWrite(buf, name, (seconds / 60) * PRICES.musicPerMin);
      } catch (error) {
        if (error instanceof ApiError && error.retryable) throw error;
        if (!isOutOfCreditsOrAuth(error)) throw error;
        if (!monidOut && deps.monid) {
          const viaMonid = await monidEleven("/v1/music", { prompt: full, music_length_ms: lengthMs, model_id: "music_v1", force_instrumental: true }, name);
          if (viaMonid) return viaMonid;
        }
        note(`music skipped (${error instanceof Error ? error.message : String(error)})`);
        return null;
      }
    }
    try {
      const viaMonid = await monidEleven("/v1/music", { prompt: full, music_length_ms: lengthMs, model_id: "music_v1", force_instrumental: true }, name);
      if (viaMonid) return viaMonid;
    } catch (error) {
      if (error instanceof ApiError && error.retryable) throw error;
      note(`music skipped (${error instanceof Error ? error.message : String(error)})`);
      return null;
    }
    note("no music provider available; cut uses speech and sound effects only");
    return null;
  };
  const effect = async (name: BrainrotSfx): Promise<string> => {
    const prompt = SFX_PROMPTS[name];
    if (name === "six_seven") return speech(prompt.text, `sfx-${name}`, { eleven: CHANT_VOICE, tags: "[shouting]", settings: { stability: 0.2, similarity_boost: 0.7 } });
    if (deps.eleven?.sfx && !elevenOut) {
      try {
        const buf = await deps.eleven.sfx(prompt.text, prompt.seconds);
        return await directWrite(buf, `sfx-${name}`, (prompt.seconds / 60) * PRICES.sfxPerMin);
      } catch (error) {
        if (!isOutOfCreditsOrAuth(error) || monidOut) throw error;
      }
    }
    const viaMonid = await monidEleven("/v1/sound-generation", { text: prompt.text, duration_seconds: prompt.seconds, prompt_influence: 0.6 }, `sfx-${name}`);
    if (viaMonid) return viaMonid;
    throw new ApiError("elevenlabs", 402, "no_sfx_provider", `no provider available for sound effect ${name}`);
  };

  guard("before starting");

  // 1. The voice, one line per shot and the end line, so every shot is as long as what is said over it.
  const lines = [...script.shots.filter((s) => s.words).map((s) => ({ id: String(s.n), text: s.words })), ...(script.end.line ? [{ id: "end", text: script.end.line }] : [])];
  await pool(lines, 3, async ({ id, text }) => {
    if (manifest.voice[id] && (await local(manifest.voice[id].key))) return;
    const raw = await speech(text, `voice-${id}`, { eleven: recipe.voice.id, tags: recipe.voice.tags });
    const tight = await tighten(raw, join(dir, `voice-${id}.wav`), recipe.voice.tempo);
    const seconds = (await probe(tight)).duration;
    manifest.voice[id] = { key: await keep(`voice-${id}${tight.endsWith(".wav") ? ".wav" : ".mp3"}`, tight, tight.endsWith(".wav") ? "audio/wav" : "audio/mpeg"), seconds };
    await persist();
  });
  say(`voice: ${lines.length} lines (${recipe.voice.name})`);

  const voiceOf = async (id: string) => {
    const v = manifest.voice[id];
    const path = v ? await local(v.key) : null;
    return path ? { path, seconds: v!.seconds } : null;
  };
  const shotVoices = await Promise.all(script.shots.map((s) => (s.words ? voiceOf(String(s.n)) : Promise.resolve(null))));
  const durations = shotDurations({ script, shots: shotVoices.map((voice) => ({ clip: "", voice })) });

  // 2. Characters drawn once, then every shot's still from them (fal image model).
  const image = async (name: string, prompt: string, refKeys: ImageRecord[]) => {
    const urls = (await Promise.all(refKeys.map((r) => refUrl(r.key, r.url)))).filter((u): u is string => Boolean(u));
    const baseInput = { prompt, aspect_ratio: "9:16", num_images: 1, output_format: "png", resolution: "2K" };
    const output = await deps.fal.run(urls.length ? FAL.frameEdit : FAL.frame, urls.length ? { ...baseInput, image_urls: urls } : baseInput);
    const url = falImageUrl(output);
    if (!url) throw new ApiError("fal", 502, "no_image", `the image for ${name} came back empty`);
    manifest.spend.fal_micro += Math.round(FAL_USD.frame * 1_000_000);
    const path = join(dir, `${name}.png`);
    await fetchTo(url, path);
    return { key: await keep(`${name}.png`, path, "image/png"), url };
  };
  guard("before the pictures");
  for (const c of plan.characters) {
    if (manifest.characters[c.id] && (await local(manifest.characters[c.id].key))) continue;
    manifest.characters[c.id] = await image(`character-${c.id}`, c.prompt, []);
    await persist();
  }
  const wanted = input.probe ? plan.shots.slice(0, 1) : plan.shots;
  await pool(wanted, 3, async (shot) => {
    const id = String(shot.n);
    if (manifest.stills[id] && (await local(manifest.stills[id].key))) return;
    const refs = shot.refs.map((ref) => manifest.characters[ref]).filter((r): r is ImageRecord => Boolean(r));
    manifest.stills[id] = await image(`still-${id}`, shot.still, refs);
    await persist();
  });
  say(`pictures: ${plan.characters.length} characters, ${wanted.length} stills`);

  // 3. The clips, on fal, from each still. The first one finished sets the measured price.
  const { endpoint: videoEndpoint, kind: videoKind } = falVideoEndpoint(input.videoModel);
  const render = async (n: number, extra = "") => {
    const id = String(n);
    const rec = (manifest.clips[id] ??= {});
    // Clips may be slowed down to fill their shot (SLOWEST), so a 4.6 s shot takes a 4 s clip, not a 6 s one.
    const seconds = videoSeconds(input.videoModel, (durations[n - 1] + 0.2) / SLOWEST);
    if (!rec.job) {
      guard(`before clip ${n}`);
      const still = manifest.stills[id];
      const stillUrl = still ? await refUrl(still.key, still.url) : null;
      if (!stillUrl) throw new ApiError("fal", 502, "no_still", `no reference still for shot ${n}`);
      const prompt = [plan.shots[n - 1].clip, extra].filter(Boolean).join(" ").slice(0, 2500);
      const body =
        videoKind === "veo"
          ? { prompt, image_url: stillUrl, duration: `${seconds}s`, aspect_ratio: "9:16", resolution: "720p", generate_audio: false }
          : videoKind === "kling"
            ? { prompt, start_image_url: stillUrl, duration: String(seconds), generate_audio: false }
            : { prompt, image_url: stillUrl, duration: String(seconds), aspect_ratio: "9:16" };
      rec.job = await deps.fal.submit(videoEndpoint, body);
      rec.endpoint = videoEndpoint;
      rec.renders = (rec.renders ?? 0) + 1;
      rec.seconds = seconds;
      rec.error = undefined;
      await persist();
    }
    const ep = rec.endpoint ?? videoEndpoint;
    for (;;) {
      try {
        const status = await falPoll.status(ep, rec.job!);
        if (status.status !== "COMPLETED") {
          await sleep(pollMs);
          continue;
        }
        const out = await falPoll.result(ep, rec.job!, status);
        const videoUrl = falVideoUrl(out);
        if (!videoUrl) throw new ApiError("fal", 502, "no_video", `clip ${n} returned no video`);
        const reported = typeof (out as { cost_micro_usd?: unknown } | null)?.cost_micro_usd === "number" ? (out as { cost_micro_usd: number }).cost_micro_usd : 0;
        const cost = reported > 0 ? reported : Math.round((rec.seconds ?? seconds) * perSecond() * 1_000_000);
        manifest.spend.fal_micro += cost;
        rec.cost_micro = (rec.cost_micro ?? 0) + cost;
        if (cost > 0) {
          const m = manifest.measured ?? { per_second: 0, seconds: 0, micro: 0 };
          m.seconds += rec.seconds ?? seconds;
          m.micro += cost;
          m.per_second = m.micro / 1e6 / Math.max(1, m.seconds);
          manifest.measured = m;
        }
        const path = join(dir, `clip-${id}-r${rec.renders}.mp4`);
        await fetchTo(videoUrl, path);
        rec.key = await keep(`clip-${id}.mp4`, path, "video/mp4");
        rec.job = undefined;
        await persist();
        return;
      } catch (error) {
        if (error instanceof ApiError && error.retryable) throw error;
        rec.error = error instanceof Error ? error.message : String(error);
        rec.job = undefined;
        await persist();
        if ((rec.renders ?? 0) >= 2) throw new Error(`clip ${n}: ${rec.error}`);
        return render(n, extra);
      }
    }
  };
  const renderAll = async (shots: number[]) =>
    pool(shots, 3, async (n) => {
      if (!(await local(manifest.clips[String(n)]?.key))) await render(n);
    });
  // The first clip alone, so the guard knows the model's real price before the rest are paid for.
  if (!manifest.measured) await renderAll([1]);
  if (input.probe) return result(null, null, 0);
  guard("after pricing the video model");

  // 4. Music and sound effects, while the clips render.
  const total = durations.reduce((a, b) => a + b, 0) + 3.5;
  const audio = (async () => {
    const audioType = (path: string) => (path.endsWith(".wav") ? "audio/wav" : "audio/mpeg");
    if (!(manifest.music.bed && (await local(manifest.music.bed)))) {
      const raw = await music(script.music.style || "dumb catchy meme beat", Math.min(60, Math.max(10, total + 1.5)), "music-bed");
      if (raw) {
        manifest.music.bed = await keep(`music-bed.${raw.split(".").pop()}`, raw, audioType(raw));
        await persist();
      }
    }
    if (script.bit === "melodrama" && script.music.turn && script.music.hype && !(manifest.music.hype && (await local(manifest.music.hype)))) {
      const after = durations.slice(script.music.turn - 1).reduce((a, b) => a + b, 0) + 4;
      const raw = await music(script.music.hype, Math.min(60, Math.max(8, after)), "music-hype");
      if (raw) {
        manifest.music.hype = await keep(`music-hype.${raw.split(".").pop()}`, raw, audioType(raw));
        await persist();
      }
    }
    for (const name of neededSfx(script)) {
      if (await files.exists(sfxKey(name))) continue;
      try {
        const raw = await effect(name);
        await files.putFile(sfxKey(name), raw, audioType(raw));
      } catch (error) {
        if (error instanceof ApiError && error.retryable) throw error;
        const out = join(dir, `sfx-${name}.wav`);
        await synthSfx(name, out);
        await files.putFile(sfxKey(name), out, "audio/wav");
        note(`the ${name.replace(/_/g, " ")} sound is a stand-in (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    await persist();
  })();
  await Promise.all([renderAll(script.shots.map((s) => s.n)), audio]);
  say(`clips: ${script.shots.length} on ${input.videoModel} (about $${perSecond().toFixed(3)} a second)`);

  // 5. Every clip checked once; a failed one is rendered again with the check's fix.
  if (input.qc !== false && !manifest.checked) {
    const checks = await checkClips(claude, script, input.product.name, await Promise.all(script.shots.map(async (s) => (await local(manifest.clips[String(s.n)]?.key))!)), (micro) => {
      manifest.spend.claude_micro += micro;
    });
    for (const check of checks) {
      const rec = manifest.clips[String(check.n)];
      if (rec) rec.check = check;
    }
    const failed = checks.filter((c) => !c.pass);
    for (const check of failed) {
      const rec = manifest.clips[String(check.n)];
      if (!rec || rec.fixed) continue;
      // The first render stays kept until a new one lands; the new one is paid for only if it fits.
      const again = videoSeconds(input.videoModel, (durations[check.n - 1] + 0.2) / SLOWEST) * perSecond();
      if (spent() + left() + again > input.maxUsd + 1e-6) {
        note(`clip ${check.n} failed its check (${check.issues.join("; ")}) and was kept: no budget left to render it again`);
        continue;
      }
      rec.fixed = true;
      await persist();
      say(`clip ${check.n} failed its check (${check.issues.join("; ")}); rendering it again`);
      try {
        await render(check.n, check.fix);
      } catch (error) {
        if (error instanceof ApiError && (error.retryable || error.outOfCredits)) throw error;
        note(`clip ${check.n}: its second render failed (${error instanceof Error ? error.message : String(error)}); the first is kept`);
      }
    }
    manifest.checked = true;
    await persist();
  }

  // 6. The cut, kept by key.
  const finalKey = `${input.prefix}/final.mp4`;
  if (input.recut && manifest.final) {
    manifest.final = undefined;
    manifest.qc = undefined;
  }
  let finalPath = manifest.final ? await local(manifest.final.key) : null;
  if (!finalPath) {
    // The mascot card keeps the brainrot energy at the punchline, and a site screenshot can carry other companies' logos.
    const mascot = script.characters.map((c) => manifest.characters[c.id]).find(Boolean) ?? manifest.stills[String(script.shots.length)];
    let endImage = input.endCard !== "page" && mascot ? await local(mascot.key) : null;
    const visual = endImage ? null : endVisual(input.product);
    if (visual) endImage = (await local(visual.key)) ?? (existsSync(visual.url) ? visual.url : null);
    if (visual && !endImage && /^https:\/\//.test(visual.url)) {
      endImage = join(dir, "end-card.png");
      await fetchTo(visual.url, endImage).catch(() => (endImage = null));
    }
    if (!endImage) note("no screenshot of the product for the end card: the video ends on its last shot");
    const sfx: Partial<Record<BrainrotSfx, string>> = {};
    for (const name of neededSfx(script)) {
      const path = await local(sfxKey(name));
      if (path) sfx[name] = path;
    }
    const cut = buildCut({
      script,
      shots: await Promise.all(
        script.shots.map(async (s, i) => {
          const clip = (await local(manifest.clips[String(s.n)]?.key))!;
          return { clip, voice: shotVoices[i], length: (await probe(clip)).duration || undefined };
        }),
      ),
      endVoice: await voiceOf("end"),
      endImage,
      endAnchor: visual ? "top" : "center",
      music: { bed: await local(manifest.music.bed), hype: await local(manifest.music.hype) },
      sfx,
      site: input.site,
    });
    const out = join(dir, "final.mp4");
    say(`cutting ${cut.duration.toFixed(1)} s: ${cut.texts.length} texts, ${cut.sounds.length} sounds, ${cut.fx.length} effects`);
    await renderCut(cut, out, { workDir: dir });
    say("cut done");
    await files.putFile(finalKey, out, "video/mp4");
    const poster = join(dir, "poster.jpg");
    const bin = await ffmpegPath();
    let posterKey: string | undefined;
    if (bin) {
      await exec(bin, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(Math.min(1, cut.duration / 3)), "-i", out, "-frames:v", "1", "-q:v", "3", poster]);
      posterKey = `${input.prefix}/poster.jpg`;
      await files.putFile(posterKey, poster, "image/jpeg");
    }
    manifest.final = { key: finalKey, poster: posterKey, duration: cut.duration };
    await persist();
    finalPath = out;
  }

  // 7. The cut checked as a viewer sees it.
  if (input.qc !== false && !manifest.qc) {
    manifest.qc = await checkCut(claude, script, input.product.name, input.site, finalPath, (micro) => {
      manifest.spend.claude_micro += micro;
    });
    await persist();
  }
  return result(manifest.final?.key ?? null, finalPath, manifest.final?.duration ?? 0);

  function result(key: string | null, path: string | null, duration: number): BrainrotResult {
    return {
      key,
      poster_key: manifest.final?.poster ?? null,
      path,
      duration,
      spend: { ...manifest.spend },
      per_second: manifest.measured?.per_second ?? null,
      qc: manifest.qc ?? null,
      notes: [...manifest.notes, ...Object.entries(manifest.clips).flatMap(([n, c]) => (c.check && !c.check.pass ? [`clip ${n}: ${c.check.issues.join("; ")}`] : []))],
      shots: script.shots.map((s) => {
        const c = manifest.clips[String(s.n)];
        return {
          n: s.n,
          status: c?.key ? "rendered" : c?.job ? "rendering" : c?.error && (c.renders ?? 0) >= 2 ? "failed" : "pending",
          seconds: durations[s.n - 1],
          still_key: manifest.stills[String(s.n)]?.key ?? null,
          cost_micro: c?.cost_micro ?? 0,
          error: c?.error ?? null,
        };
      }),
    };
  }
}

/** The sound effects a script uses, plus the ones the cut always adds. */
export function neededSfx(script: BrainrotScript): BrainrotSfx[] {
  const set = new Set<BrainrotSfx>(script.shots.flatMap((s) => s.sfx));
  set.add("vine_boom");
  if (script.bit === "melodrama" && script.music.turn) set.add("record_scratch");
  if (script.shots.some((s) => /6\s*-\s*7|six\s+seven/i.test(`${s.stamp} ${s.words}`))) set.add("six_seven");
  return [...set];
}

/** Clips per check: two frames each, up to 12 images in one vision request. */
export const CLIPS_PER_CHECK = 6;
const QC_TIMEOUT_MS = 120_000;

/** Two frames of every clip to a vision model, six clips a call: fails only what breaks the rules or the shot. */
export async function checkClips(
  claude: ClaudeAsk,
  script: BrainrotScript,
  productName: string,
  clips: string[],
  onCost?: (micro: number) => void,
): Promise<ClipCheck[]> {
  const out: ClipCheck[] = [];
  for (let first = 0; first < clips.length; first += CLIPS_PER_CHECK) {
    const batch = clips.slice(first, first + CLIPS_PER_CHECK);
    const content: unknown[] = [];
    for (const [k, clip] of batch.entries()) {
      const i = first + k;
      const frames = await extractFrames(clip, 2, 360);
      content.push({ type: "text", text: `Clip ${i + 1}: ${script.shots[i].frame} ${script.shots[i].motion}` });
      for (const frame of frames) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: frame.toString("base64") } });
    }
    content.push({
      type: "text",
      text: [
        `These are two frames from each of ${batch.length} AI clips (numbered as above) for a deliberately absurd "brainrot" meme ad for ${productName}. Looking AI-made, cartoonish, ugly or unhinged is intended: do not fail anything for that.`,
        `Fail a clip only for: ${OFF_LIMITS}; readable or garbled text, letters, captions or logos drawn into the picture; a human being as a main character (characters are animals, food, objects and robots); a clip that does not show its scene at all, or is frozen, blank or melted beyond recognition.`,
        "Call clip_checks once with every clip, by its number.",
      ].join("\n"),
    });
    const reply = await claude({ model: QC_MODEL, max_tokens: 2500, messages: [{ role: "user", content }], tools: [CHECK_TOOL] }, QC_TIMEOUT_MS);
    onCost?.(callCostMicro(reply.usage));
    const raw = (reply.content.find((b) => b.type === "tool_use" && b.name === CHECK_TOOL.name)?.input ?? extractJson(reply.content.map((b) => b.text ?? "").join("\n"))) as { shots?: Array<Partial<ClipCheck>> } | null;
    out.push(
      ...(raw?.shots ?? [])
        .map((s) => ({ n: Number(s.n), pass: s.pass !== false, issues: Array.isArray(s.issues) ? s.issues.filter((x): x is string => typeof x === "string") : [], fix: typeof s.fix === "string" ? s.fix : "" }))
        .filter((s) => s.n > first && s.n <= first + batch.length),
    );
  }
  return out;
}

/** Eight frames of the cut to a vision model: is it safe, is the product readable, does the bit land. */
export async function checkCut(
  claude: ClaudeAsk,
  script: BrainrotScript,
  productName: string,
  site: string,
  path: string,
  onCost?: (micro: number) => void,
): Promise<CutCheck> {
  const frames = await extractFrames(path, 8, 360);
  const reply = await claude(
    {
      model: QC_MODEL,
      max_tokens: 1500,
      messages: [
        {
          role: "user",
          content: [
            ...frames.map((frame) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: frame.toString("base64") } })),
            {
              type: "text",
              text: [
                `Eight frames, in order, of a finished deliberately-terrible "brainrot" meme ad for ${productName} (${site}), the ${RECIPES[script.bit].name} format. Absurd, cringe and AI-looking is the point.`,
                `safe is false if any frame shows: ${OFF_LIMITS}.`,
                `Score 1-10: does it read as a real brainrot meme a viewer would watch to the end, is the meme text readable, and is ${productName} clearly the punchline with ${site} readable at the end? List the concrete problems.`,
                "Call cut_check once.",
              ].join("\n"),
            },
          ],
        },
      ],
      tools: [CUT_TOOL],
    },
    QC_TIMEOUT_MS,
  );
  onCost?.(callCostMicro(reply.usage));
  const raw = (reply.content.find((b) => b.type === "tool_use" && b.name === CUT_TOOL.name)?.input ?? extractJson(reply.content.map((b) => b.text ?? "").join("\n"))) as Partial<CutCheck> | null;
  const score = Number(raw?.score);
  return { score: score >= 1 && score <= 10 ? Math.round(score) : 0, safe: raw?.safe !== false, issues: Array.isArray(raw?.issues) ? raw.issues.filter((x): x is string => typeof x === "string").slice(0, 8) : [] };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Runs `task` over `items`, `limit` at a time; the first busy-provider error (else the first error) is thrown once all settle. */
async function pool<T>(items: T[], limit: number, task: (item: T) => Promise<void>) {
  let next = 0;
  const errors: unknown[] = [];
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await task(item).catch((error: unknown) => void errors.push(error));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (errors.length) throw errors.find((error) => error instanceof ApiError && error.retryable) ?? errors[0];
}
