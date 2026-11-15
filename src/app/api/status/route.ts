import { handle } from "@/lib/api";
import { ffmpegPath } from "@/lib/media";
import { MonidClient } from "@/lib/monid";
import { secretStatus } from "@/lib/settings";

export const runtime = "nodejs";

type Status = {
  anthropic: { configured: boolean };
  fal: { configured: boolean };
  monid: { ok: boolean; balanceUsd?: number; error?: string };
  mobilerun: { configured: boolean };
  ffmpeg: boolean;
};

let cached: { at: number; status: Status } | null = null;

export async function GET(request: Request) {
  return handle(async () => {
    const fresh = new URL(request.url).searchParams.has("fresh");
    if (!fresh && cached && Date.now() - cached.at < 20_000) return Response.json(cached.status);
    const [monid, ffmpeg] = await Promise.all([monidStatus(), ffmpegPath()]);
    const status: Status = {
      anthropic: { configured: secretStatus("anthropic_api_key").set },
      fal: { configured: secretStatus("fal_api_key").set },
      monid,
      mobilerun: { configured: secretStatus("mobilerun_api_key").set },
      ffmpeg: Boolean(ffmpeg),
    };
    cached = { at: Date.now(), status };
    return Response.json(status);
  });
}

async function monidStatus(): Promise<Status["monid"]> {
  try {
    return { ok: true, balanceUsd: await new MonidClient().balanceUsd() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
