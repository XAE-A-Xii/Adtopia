import { afterEach, describe, expect, it } from "vitest";
import { defaultOptions, formatMix } from "@/lib/pipeline";
import { setSetting } from "@/lib/settings";

describe("the format mix", () => {
  afterEach(async () => {
    await setSetting("format_mix", "split_screen,code_ad,brainrot");
    await setSetting("videos_per_campaign", "1");
  });

  it("makes one video per listed format, in order", () => {
    expect(formatMix()).toEqual(["split_screen", "code_ad", "brainrot"]);
    expect(defaultOptions()).toMatchObject({ concepts: 3, formats: ["split_screen", "code_ad", "brainrot"] });
  });

  it("drops names that aren't formats", async () => {
    await setSetting("format_mix", " code_ad , dance_video,brainrot");
    expect(defaultOptions()).toMatchObject({ concepts: 2, formats: ["code_ad", "brainrot"] });
  });

  it("leaves the director free when empty", async () => {
    await setSetting("format_mix", "");
    await setSetting("videos_per_campaign", "2");
    const options = defaultOptions();
    expect(options.concepts).toBe(2);
    expect(options.formats).toBeUndefined();
  });
});
