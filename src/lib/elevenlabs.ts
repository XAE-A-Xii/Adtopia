import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { ApiError } from "./http";
import { getSetting } from "./settings";

// ElevenLabs, called directly with the brand's own key (https://elevenlabs.io/docs/api-reference).
// Audio endpoints answer with the audio bytes; speech-to-text answers JSON with word timings.
// ponytail: spend isn't reported per call; ElevenLabs bills the account by characters and minutes.

export type ElevenWords = { text: string; words: Array<{ text: string; start: number | null; end: number | null; type?: string }> };

export const hasElevenLabs = () => Boolean(getSetting("elevenlabs_api_key"));

/** Word timings grouped into sentence-like segments: a break after . ? or ! and at pauses over 0.8 s. */
export function segmentsFromWords(words: ElevenWords["words"]): Array<{ start_seconds: number; end_seconds: number; text: string }> {
  const out: Array<{ start_seconds: number; end_seconds: number; text: string }> = [];
  let current: (typeof out)[number] | null = null;
  for (const word of words) {
    const text = word.text.trim();
    if ((word.type && word.type !== "word") || word.start == null || word.end == null || !text) continue;
    if (current && word.start - current.end_seconds > 0.8) {
      out.push(current);
      current = null;
    }
    if (!current) current = { start_seconds: word.start, end_seconds: word.end, text };
    else Object.assign(current, { end_seconds: word.end, text: `${current.text} ${text}` });
    if (/[.?!]$/.test(text)) {
      out.push(current);
      current = null;
    }
  }
  if (current) out.push(current);
  return out;
}

const MIME: Record<string, string> = { mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", mp4: "video/mp4", ogg: "audio/ogg", webm: "audio/webm" };
const mimeOf = (path: string) => MIME[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

export class ElevenLabsClient {
  constructor(
    private readonly key = getSetting("elevenlabs_api_key"),
    private readonly base = getSetting("elevenlabs_base_url"),
  ) {
    if (!key) throw new ApiError("elevenlabs", 401, "not_configured", "no ElevenLabs API key; add one in Settings");
  }

  /** Text to speech: MP3 bytes in the voice. */
  tts(voiceId: string, body: { text: string; model_id: string; voice_settings?: Record<string, number> }) {
    return this.call(`/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, JSON.stringify(body), "application/json");
  }

  /** Speech to speech: the performance in `audio`, said in the voice. */
  async sts(voiceId: string, audio: string, modelId: string) {
    return this.call(`/v1/speech-to-speech/${voiceId}?output_format=mp3_44100_128`, await this.form(audio, "audio", { model_id: modelId }));
  }

  /** The voice alone, without music or effects. */
  async isolate(audio: string) {
    return this.call("/v1/audio-isolation", await this.form(audio, "audio", {}));
  }

  /** Speech to text with word timings. */
  async transcribe(audio: string, fields: { model_id: string; language_code?: string }): Promise<ElevenWords> {
    const form = await this.form(audio, "file", { timestamps_granularity: "word", tag_audio_events: "false", ...fields });
    return JSON.parse((await this.call("/v1/speech-to-text", form, undefined, "application/json")).toString("utf8")) as ElevenWords;
  }

  private async form(path: string, field: string, fields: Record<string, string>) {
    const form = new FormData();
    form.append(field, new Blob([new Uint8Array(await readFile(path))], { type: mimeOf(path) }), basename(path));
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    return form;
  }

  /** One call, no automatic retry: every call is billed. A busy answer throws a retryable ApiError. */
  private async call(path: string, body: FormData | string, contentType?: string, accept = "audio/mpeg"): Promise<Buffer> {
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method: "POST",
        headers: { "xi-api-key": this.key, accept, ...(contentType ? { "content-type": contentType } : {}) },
        body,
        signal: AbortSignal.timeout(300_000),
      });
    } catch (error) {
      throw new ApiError("elevenlabs", 0, "network_error", error instanceof Error ? error.message : String(error));
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (response.ok) return bytes;
    let detail: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(bytes.toString("utf8")) as { detail?: unknown };
      detail = typeof parsed.detail === "object" && parsed.detail ? (parsed.detail as Record<string, unknown>) : { message: String(parsed.detail ?? "") };
    } catch {
      detail = { message: bytes.toString("utf8").slice(0, 300) };
    }
    const code = String(detail.status ?? detail.code ?? response.status);
    // ElevenLabs says "quota_exceeded" with a 401 when the account is out of characters: treat it as out of credits.
    const status = /quota|credits/i.test(code) ? 402 : response.status;
    throw new ApiError("elevenlabs", status, code, String(detail.message || `HTTP ${response.status}`), response.headers.get("request-id") ?? undefined);
  }
}
