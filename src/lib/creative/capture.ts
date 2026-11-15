import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { ApiError } from "../http";
import { probe } from "../media";
import { ChromeSession, findChrome } from "./screens";
import type { ProductVisual } from "./types";

// Product screenshots for the edit: a local headless Chrome that presents as a phone, capturing
// a screenshot of the homepage and up to four pages that show what the product is (pricing,
// features, how it works, docs), saved locally as ProductVisuals.

/** What a capture needs from a browser. */
type PageBrowser = {
  goto: (url: string) => Promise<{ url: string }>;
  title: () => Promise<string>;
  screenshot: (path: string) => Promise<void>;
  links: () => Promise<Array<{ href: string; text: string }>>;
};

export type CaptureInput = {
  /** "monid.ai", "www.monid.ai" or "https://monid.ai/". */
  domain: string;
  /** Pages to capture after the homepage ("/pricing" or full URLs on the domain). Omitted, they are found from the homepage's links. */
  paths?: string[];
  /** Where the PNGs are saved. */
  dir: string;
  /** Pages besides the homepage, at most (default 4). */
  maxPages?: number;
  /** Default 430 x 932, a large phone. */
  viewport?: { width: number; height: number };
  /** Stop starting new pages after this long (default 110 s). */
  budgetMs?: number;
  /** Unused; kept for backwards-compatible callers. */
  pollMs?: number;
  /** ProductVisual ids are this plus a number (default "s": s1, s2, ...). */
  idPrefix?: string;
};

export const PHONE_VIEWPORT = { width: 430, height: 932 };

/**
 * Remote managed-browser capture has been removed; use `captureSiteVisualsLocal` with local Chrome.
 */
export async function captureSiteVisuals(_input: CaptureInput): Promise<ProductVisual[]> {
  throw new ApiError("anthropic", 501, "not_configured", "Remote browser capture is not available; install local Chrome/Chromium for site screenshots.");
}

/** A phone's user agent, for sites that pick their mobile layout by it rather than by width. */
const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

/** Whether a local Chrome can take the screenshots (it can't on serverless hosts). */
export const canCaptureLocally = () => Boolean(findChrome());

/** Headless Chrome for the open web: a throwaway profile, driven over the DevTools pipe. */
function siteChromeArgs(profile: string, viewport: { width: number; height: number }) {
  return [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-default-apps",
    "--use-mock-keychain",
    "--password-store=basic",
    `--user-data-dir=${profile}`,
    `--window-size=${viewport.width},${viewport.height}`,
    "--remote-debugging-pipe",
    ...(typeof process.getuid === "function" && process.getuid() === 0 ? ["--no-sandbox"] : []),
    "about:blank",
  ];
}

/**
 * The same screenshots from a local headless Chrome emulating a phone: free, no key. One browser,
 * one page, a throwaway profile; each page gets a second and a half after its load event for
 * scripts and animations to settle.
 */
export async function captureSiteVisualsLocal(input: CaptureInput & { chrome?: string }): Promise<ProductVisual[]> {
  const chrome = input.chrome ?? findChrome();
  if (!chrome) throw new Error("No Chrome or Chromium found to take screenshots: install Google Chrome, or set CHROME_PATH.");
  const started = Date.now();
  const left = () => (input.budgetMs ?? 110_000) - (Date.now() - started);
  const viewport = input.viewport ?? PHONE_VIEWPORT;
  await mkdir(input.dir, { recursive: true });
  const session = await ChromeSession.open(chrome, { ...viewport, scale: 2, port: 0, timeoutMs: 30_000, args: (profile) => siteChromeArgs(profile, viewport), phone: { userAgent: PHONE_UA } });
  const browser: PageBrowser = {
    goto: async (url) => {
      await session.navigate(url);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { url: await session.evaluate<string>("location.href") };
    },
    title: () => session.evaluate<string>("document.title"),
    screenshot: (path) => session.capture(path),
    links: () => session.evaluate<Array<{ href: string; text: string }>>("[...document.querySelectorAll('a[href]')].slice(0, 300).map((a) => ({ href: a.href, text: (a.innerText || '').trim().slice(0, 80) }))"),
  };
  try {
    return await capturePages(browser, input, left);
  } finally {
    await session.close();
  }
}

/** The homepage, then the most useful pages (found from its links, or given): one screenshot each. */
async function capturePages(browser: PageBrowser, input: CaptureInput, left: () => number): Promise<ProductVisual[]> {
  const host = hostOf(input.domain);
  const bare = host.replace(/^www\./, "");
  const origin = `https://${host}`;
  const prefix = input.idPrefix ?? "s";
  const visuals: ProductVisual[] = [];
  const seen = new Set<string>();
  let lastError: unknown = null;

  const shoot = async (url: string) => {
    const landed = await browser.goto(url);
    const final = pageKey(landed.url);
    if (seen.has(final)) return;
    seen.add(final);
    const title = (await browser.title().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 120);
    const path = pathOf(landed.url, bare);
    const local = join(input.dir, `site-${slug(path)}.png`);
    await browser.screenshot(local);
    const size = await imageSize(local);
    visuals.push({
      id: `${prefix}${visuals.length + 1}`,
      kind: "screenshot",
      url: local,
      caption: `${pageLabel(path)}, as a phone shows it${title ? `: "${title}"` : ""}`,
      source: `capture:mobile:${path}`,
      ...(size ? { width: size.width, height: size.height } : {}),
    });
  };

  let links: Array<{ href: string; text: string }> = [];
  try {
    await shoot(`${origin}/`);
    if (!input.paths) links = await browser.links();
  } catch (error) {
    lastError = error; // the homepage would not load or capture: explicit paths may still work
  }

  const max = input.maxPages ?? 4;
  const pages = input.paths ? input.paths.map((path) => resolvePage(path, origin, bare)).filter((url): url is string => url !== null).slice(0, max) : pickPages(links, bare, max);
  for (const page of pages) {
    if (left() < 12_000) break;
    try {
      await shoot(page);
    } catch (error) {
      lastError = error; // one page failing (a redirect off the domain, a slow load) never costs the others
    }
  }
  // Nothing captured at all is a failure worth reporting, not an empty success.
  if (visuals.length === 0 && lastError) throw lastError instanceof Error ? lastError : new Error(String(lastError));
  return visuals;
}

// ---------- choosing pages ----------

const PAGE_KINDS: Array<{ kind: string; score: number; test: RegExp }> = [
  { kind: "pricing", score: 10, test: /^(pricing|plans?|prices?)$/ },
  { kind: "product", score: 8, test: /^(features?|product|platform|how-it-works|how|solutions?|use-cases?|why-.+|overview|tour)$/ },
  { kind: "shop", score: 7, test: /^(products?|shop|store)$/ },
  { kind: "docs", score: 6, test: /^(docs?|documentation|getting-started|quickstart|quick-start|guides?|demo|integrations?|examples?|api)$/ },
  { kind: "collection", score: 5, test: /^(collections?|catalog|catalogue)$/ },
  { kind: "proof", score: 4, test: /^(customers?|case-studies|reviews?|testimonials)$/ },
  { kind: "about", score: 2, test: /^(about|about-us|our-story)$/ },
];
const SKIP = /(^|[/-])(log-?in|sign-?in|sign-?up|register|account|cart|checkout|privacy|terms|legal|cookies?|careers?|jobs|contact|press|status|support|help|affiliates?|unsubscribe|blog|news|changelog)([/-]|$)/;
const SKIP_HOSTS = /^(app|dashboard|console|auth|login|accounts?|status|help|support|blog)\./;
/** Path segments that only group pages ("/pages/how-it-works" is a top-level page on Shopify). */
const NEUTRAL_SEGMENTS = new Set(["pages", "en", "en-us", "us"]);

/**
 * The most useful pages to show, one per kind: pricing, features or how it works, a product page,
 * docs, then customers. Login, legal, careers and blog posts are skipped; shorter paths win ties.
 */
export function pickPages(links: Array<{ href: string; text: string }>, domain: string, max = 4): string[] {
  const bare = hostOf(domain).replace(/^www\./, "");
  const best = new Map<string, { url: string; score: number }>();
  for (const link of links) {
    let url: URL;
    try {
      url = new URL(link.href, `https://${bare}/`);
    } catch {
      continue;
    }
    const host = url.hostname.toLowerCase();
    if (!/^https?:$/.test(url.protocol) || !(host === bare || host.endsWith(`.${bare}`)) || SKIP_HOSTS.test(host)) continue;
    const path = url.pathname.toLowerCase().replace(/\/+$/, "");
    const docsHost = /^(docs|developers?)\./.test(host);
    if ((!path && !docsHost) || SKIP.test(path) || /\.(pdf|zip|png|jpe?g|gif|svg|webp|mp4|xml|json)$/.test(path)) continue;
    const parts = path.split("/").filter((part) => part && !NEUTRAL_SEGMENTS.has(part));
    const match = docsHost ? PAGE_KINDS.find((kind) => kind.kind === "docs") : PAGE_KINDS.find((kind) => parts.some((part) => kind.test.test(part)));
    if (!match) continue;
    // A deep docs page is less useful than the section's front page; a shop's product page is two deep.
    const score = match.score - Math.max(0, parts.length - (match.kind === "shop" || match.kind === "collection" ? 2 : 1)) * 1.5;
    const clean = `${url.protocol}//${host}${url.pathname.replace(/\/+$/, "") || "/"}`;
    const current = best.get(match.kind);
    if (!current || score > current.score || (score === current.score && clean.length < current.url.length)) best.set(match.kind, { url: clean, score });
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, max).map((page) => page.url);
}

function resolvePage(path: string, origin: string, bare: string): string | null {
  try {
    const url = new URL(path, `${origin}/`);
    const host = url.hostname.toLowerCase();
    return host === bare || host.endsWith(`.${bare}`) ? url.href : null;
  } catch {
    return null;
  }
}

// ---------- small helpers ----------

/** "https://www.Monid.ai/x" -> "www.monid.ai". */
function hostOf(domain: string) {
  const trimmed = domain.trim();
  try {
    return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return trimmed.toLowerCase().replace(/^https?:\/\//, "").replace(/[/?#].*$/, "");
  }
}

function pageKey(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}

/** "/pricing" for the brand's own host; "docs.monid.ai/start" for a subdomain. */
function pathOf(url: string, bare: string) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    const host = parsed.hostname.replace(/^www\./, "");
    return host === bare ? path : `${host}${path === "/" ? "" : path}`;
  } catch {
    return url;
  }
}

function pageLabel(path: string) {
  if (path === "/") return "homepage";
  const last = path.split("/").filter(Boolean).pop() ?? path;
  return `${last.replace(/[-_]+/g, " ")} page (${path})`;
}

function slug(path: string) {
  return path === "/" ? "home" : path.replace(/^\/+/, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 60) || "page";
}

/** Width and height from a PNG's IHDR, else from ffmpeg. */
async function imageSize(path: string): Promise<{ width: number; height: number } | null> {
  try {
    const file = await open(path, "r");
    try {
      const head = Buffer.alloc(24);
      await file.read(head, 0, 24, 0);
      if (head.readUInt32BE(0) === 0x89504e47 && head.toString("ascii", 12, 16) === "IHDR") return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
    } finally {
      await file.close();
    }
    const info = await probe(path);
    return info.width && info.height ? { width: info.width, height: info.height } : null;
  } catch {
    return null;
  }
}
