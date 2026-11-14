import { describe, expect, it } from "vitest";
import { FAL, FalClient, falImageUrl, falVideoUrl, hasFal } from "@/lib/fal";

// Opt-in, paid: FAL_LIVE=1 with FAL_KEY set makes one frame (about $0.15).
// FAL_LIVE_RENDER=1 also animates it into a 3 s Kling 3.0 Pro shot with audio (about $0.50).
const live = process.env.FAL_LIVE === "1";
const render = process.env.FAL_LIVE_RENDER === "1";

describe.skipIf(!live)("fal (live)", () => {
  it("makes a 9:16 first frame, and optionally renders it", async () => {
    expect(hasFal()).toBe(true);
    const fal = new FalClient();
    const frame = falImageUrl(
      await fal.run(FAL.frame, {
        prompt: "A woman in her twenties in a bright kitchen, holding a phone, looking into the lens mid-sentence. Photorealistic. No readable text anywhere.",
        image_urls: [],
        aspect_ratio: "9:16",
        num_images: 1,
        output_format: "png",
        resolution: "2K",
      }),
    );
    expect(frame).toMatch(/^https:\/\//);
    console.log(`frame: ${frame}`);
    if (!render) return;

    const video = falVideoUrl(await fal.run(FAL.i2v, { prompt: 'She smiles and says: "Okay, this actually works."', start_image_url: frame, duration: "3", generate_audio: true }, { pollMs: 5000, timeoutMs: 15 * 60_000 }));
    expect(video).toMatch(/^https:\/\//);
    console.log(`video: ${video}`);
  }, 20 * 60_000);
});
