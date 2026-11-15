import { body, handle } from "@/lib/api";
import { FAL } from "@/lib/fal";
import { DEFAULTS, deleteSetting, getSetting, SECRET_KEYS, secretStatus, type SettingKey, setSetting } from "@/lib/settings";

export const runtime = "nodejs";

const EDITABLE: SettingKey[] = [
  "video_model",
  "video_seconds",
  "shots_per_video",
  "videos_per_campaign",
  "learn_style",
  "qc_max_retries",
  "monid_video_fallback",
  "monid_video_resolution",
  "autopilot",
  "planner_model",
  "warmup_minutes",
  "static_ads_auto",
  "static_concepts",
  "static_model",
  "static_image_model",
  "static_ai_images",
  "presenter_engine",
  "finish",
  "remake_presenter",
  "remake_voice",
  "remake_voice_match",
  "remake_max_usd",
  "remake_screens",
  "production_mode",
  "creator_fee_usd",
];

function videoModels() {
  return [...new Set([FAL.i2v, FAL.t2v, getSetting("video_model")].filter(Boolean))].sort();
}

export async function GET() {
  return handle(async () =>
    Response.json({
      values: Object.fromEntries(EDITABLE.map((key) => [key, getSetting(key)])),
      secrets: Object.fromEntries(SECRET_KEYS.map((key) => [key, secretStatus(key)])),
      videoModels: videoModels(),
    }),
  );
}

export async function POST(request: Request) {
  return handle(async () => {
    const input = await body<Record<string, unknown>>(request);
    for (const [key, raw] of Object.entries(input)) {
      if (!(key in DEFAULTS)) continue;
      const settingKey = key as SettingKey;
      const value = String(raw ?? "").trim();
      if (SECRET_KEYS.includes(settingKey)) {
        if (value === "") await deleteSetting(settingKey);
        else await setSetting(settingKey, value);
      } else if (EDITABLE.includes(settingKey)) {
        await setSetting(settingKey, value);
      }
    }
    return Response.json({ ok: true });
  });
}
