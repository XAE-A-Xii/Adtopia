import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canCaptureLocally, captureSiteVisualsLocal } from "@/lib/creative/capture";

// Opt-in (free, opens a real site in local Chrome): CAPTURE_LIVE=1, optionally CAPTURE_DOMAIN=example.com.
describe.skipIf(process.env.CAPTURE_LIVE !== "1" || !canCaptureLocally())("captureSiteVisualsLocal (live)", () => {
  it("screenshots the homepage and a few product pages at phone size", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomen-capture-test-"));
    try {
      const visuals = await captureSiteVisualsLocal({ domain: process.env.CAPTURE_DOMAIN ?? "monid.ai", dir });
      console.log(visuals.map((v) => `${v.id} ${v.width}x${v.height} ${v.caption}`).join("\n"));
      expect(visuals.length).toBeGreaterThanOrEqual(1);
      expect(visuals[0]).toMatchObject({ kind: "screenshot", source: "capture:mobile:/", width: 860, height: 1864 });
    } finally {
      if (!process.env.CAPTURE_KEEP) await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
