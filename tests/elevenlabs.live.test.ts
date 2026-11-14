import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TTS_MODEL } from "@/lib/creative/dub";
import { DEFAULT_VOICES } from "@/lib/creative/persona";
import { ElevenLabsClient, hasElevenLabs, segmentsFromWords } from "@/lib/elevenlabs";

// Opt-in, paid (a few cents): ELEVENLABS_LIVE=1 with ELEVENLABS_API_KEY set.
const live = process.env.ELEVENLABS_LIVE === "1";

describe.skipIf(!live)("ElevenLabs direct (live)", () => {
  it("speaks a line in the default voice and transcribes it back with word timings", async () => {
    expect(hasElevenLabs()).toBe(true);
    const eleven = new ElevenLabsClient();
    const dir = await mkdtemp(join(tmpdir(), "nomen-eleven-"));
    try {
      const line = "I tried it for a week. Honestly, it changed how I work.";
      const mp3 = await eleven.tts(DEFAULT_VOICES.female.id, { text: line, model_id: TTS_MODEL.model_id, voice_settings: { ...TTS_MODEL.voice_settings, speed: 1.1 } });
      expect(mp3.length).toBeGreaterThan(5_000);
      const path = join(dir, "line.mp3");
      await writeFile(path, mp3);

      const result = await eleven.transcribe(path, { model_id: "scribe_v2", language_code: "en" });
      expect(result.text.toLowerCase()).toContain("week");
      const segments = segmentsFromWords(result.words);
      expect(segments.length).toBeGreaterThanOrEqual(2);
      expect(segments[0].end_seconds).toBeGreaterThan(segments[0].start_seconds);
      console.log(`tts ${Math.round(mp3.length / 1024)} KB; heard: "${result.text.trim()}"; segments: ${segments.map((s) => `${s.start_seconds.toFixed(1)}-${s.end_seconds.toFixed(1)}s`).join(", ")}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
