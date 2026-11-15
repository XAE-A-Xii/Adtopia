import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/http";
import { hasPostiz, integrations, schedule, upload } from "@/lib/postiz";

const BASE = "https://postiz.test/public/v1";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("postiz client", () => {
  it("reports whether postiz_api_key is configured", () => {
    vi.stubEnv("POSTIZ_API_KEY", "");
    expect(hasPostiz()).toBe(false);
    vi.stubEnv("POSTIZ_API_KEY", "pz_test_123");
    expect(hasPostiz()).toBe(true);
  });

  it("throws ApiError not_configured when key is missing", async () => {
    vi.stubEnv("POSTIZ_API_KEY", "");
    await expect(integrations()).rejects.toMatchObject({
      service: "postiz",
      status: 401,
      code: "not_configured",
    });
  });

  it("lists integrations with raw Authorization header and default/custom base URL", async () => {
    vi.stubEnv("POSTIZ_API_KEY", "pz_raw_key");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ id: "int_1", name: "Acme", identifier: "tiktok" }]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const list = await integrations();
    expect(list).toEqual([{ id: "int_1", name: "Acme", identifier: "tiktok" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.postiz.com/public/v1/integrations");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("pz_raw_key");

    vi.stubEnv("POSTIZ_BASE_URL", `${BASE}/`);
    await integrations();
    expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toBe(`${BASE}/integrations`);
  });

  it("uploads bytes as multipart/form-data with field 'file'", async () => {
    vi.stubEnv("POSTIZ_API_KEY", "pz_raw_key");
    vi.stubEnv("POSTIZ_BASE_URL", BASE);

    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ id: "file_1", path: "https://uploads.postiz.com/clip.mp4" }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const media = await upload(bytes, "clip.mp4", "video/mp4");
    expect(media).toEqual({ id: "file_1", path: "https://uploads.postiz.com/clip.mp4" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/upload`);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("pz_raw_key");
    expect(init?.body).toBeInstanceOf(FormData);
    const form = init?.body as FormData;
    const entry = form.get("file") as File;
    expect(entry).toBeInstanceOf(Blob);
    expect(entry.name).toBe("clip.mp4");
    expect(entry.type).toBe("video/mp4");
    expect(new Uint8Array(await entry.arrayBuffer())).toEqual(bytes);
  });

  it("sends type 'now' when 'at' is omitted and sets TikTok AI flag", async () => {
    vi.stubEnv("POSTIZ_API_KEY", "pz_raw_key");
    vi.stubEnv("POSTIZ_BASE_URL", BASE);

    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify([{ postId: "post_1", integration: "int_tt" }]), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await schedule({
      integrationId: "int_tt",
      platform: "tiktok",
      text: "Check this out",
      media: { id: "med_1", path: "https://uploads.postiz.com/v.mp4" },
      aiGenerated: true,
    });

    expect(result).toEqual([{ postId: "post_1", integration: "int_tt" }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/posts`);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("pz_raw_key");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");

    const parsed = JSON.parse(String(init?.body));
    expect(parsed).toMatchObject({
      type: "now",
      shortLink: false,
      tags: [],
      posts: [
        {
          integration: { id: "int_tt" },
          value: [
            {
              content: "Check this out",
              image: [{ id: "med_1", path: "https://uploads.postiz.com/v.mp4" }],
            },
          ],
          settings: {
            __type: "tiktok",
            privacy_level: "PUBLIC_TO_EVERYONE",
            video_made_with_ai: true,
          },
        },
      ],
    });
    expect(parsed.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("sends type 'schedule' with UTC ISO date when 'at' is given", async () => {
    vi.stubEnv("POSTIZ_API_KEY", "pz_raw_key");
    vi.stubEnv("POSTIZ_BASE_URL", BASE);

    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify([{ postId: "post_2", integration: "int_yt" }]), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const at = new Date("2026-11-20T16:00:00.000Z");
    await schedule({
      integrationId: "int_yt",
      platform: "youtube",
      text: "Description",
      media: { id: "med_2", path: "https://uploads.postiz.com/yt.mp4" },
      at,
      title: "Launch Video",
      visibility: "unlisted",
    });

    const parsed = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(parsed).toEqual({
      type: "schedule",
      date: "2026-11-20T16:00:00.000Z",
      shortLink: false,
      tags: [],
      posts: [
        {
          integration: { id: "int_yt" },
          value: [
            {
              content: "Description",
              image: [{ id: "med_2", path: "https://uploads.postiz.com/yt.mp4" }],
            },
          ],
          settings: {
            __type: "youtube",
            title: "Launch Video",
            type: "unlisted",
            selfDeclaredMadeForKids: "no",
          },
        },
      ],
    });
  });

  it("maps HTTP errors to ApiError('postiz', status, code, body)", async () => {
    vi.stubEnv("POSTIZ_API_KEY", "pz_raw_key");
    vi.stubEnv("POSTIZ_BASE_URL", BASE);

    const errorBody = JSON.stringify({ code: "rate_limited", message: "Too many posts per hour" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(errorBody, { status: 429 })));

    let caught: unknown;
    try {
      await schedule({
        integrationId: "int_1",
        platform: "x",
        text: "hello",
        media: { id: "m1", path: "https://uploads.postiz.com/m1.mp4" },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const apiError = caught as ApiError;
    expect(apiError.service).toBe("postiz");
    expect(apiError.status).toBe(429);
    expect(apiError.code).toBe("rate_limited");
    expect(apiError.message).toBe(`postiz: ${errorBody}`);
    expect(apiError.retryable).toBe(true);
  });

  it("maps network errors to retryable ApiError", async () => {
    vi.stubEnv("POSTIZ_API_KEY", "pz_raw_key");
    vi.stubEnv("POSTIZ_BASE_URL", BASE);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("socket hang up");
    }));

    await expect(integrations()).rejects.toMatchObject({
      service: "postiz",
      status: 0,
      code: "network_error",
      retryable: true,
    });
  });
});
