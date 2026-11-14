"use client";

import { usePathname } from "next/navigation";
import { type FormEvent, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiFailure, type BrandListItem, listBrands, normalizeSite, startCampaign } from "./api";
import { Baker } from "./engine/baker";
import { easeInOutCubic, easeInOutSine, Stage } from "./engine/stage";
import { pixelFont } from "./fonts";
import { CampScene } from "./scenes/camp";
import { Greeter, greetCamera } from "./scenes/greeter";
import { LandingScene, OPEN_SECONDS } from "./scenes/landing";
import { ROOM } from "./scenes/layout";
import { Camp } from "./camp/Camp";
import { DEMO_ID } from "./camp/demo";
import { useInertSiblings, useReducedMotion } from "./hooks";
import styles from "./troy.module.css";

type View = "landing" | "camp";
/**
 * `greeting`: the door opens and one agent steps out; `asking`: it asks for the visitor's
 * preferences; `submitting`: it walks back in while the campaign starts; then the crew marches out.
 */
type Phase = "loading" | "idle" | "greeting" | "asking" | "submitting" | "opening" | "marching";
type Engine = { stage: Stage; baker: Baker; landing: LandingScene; camp: CampScene; greeter: Greeter };

export function TroyExperience({ initialView, brandId: initialBrandId, demoOnly = false }: { initialView: View; brandId?: string; demoOnly?: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const formAnchorRef = useRef<HTMLDivElement>(null);
  const engine = useRef<Engine | null>(null);
  const [view, setView] = useState<View>(initialView);
  const [brandId, setBrandId] = useState<string | undefined>(initialBrandId);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [site, setSite] = useState("");
  // The demo opens only the websites it has a recording for (public/demo/index.json).
  const [demoSites, setDemoSites] = useState<string[]>([]);
  useEffect(() => {
    if (!demoOnly) return;
    let alive = true;
    fetch("/demo/index.json", { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : null))
      .then((index: { scripts?: Array<{ domain?: string }> } | null) => alive && setDemoSites((index?.scripts ?? []).map((s) => s.domain ?? "").filter(Boolean)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [demoOnly]);
  /** The website the demo replays, as typed at the horse (the camp mounts before the address says it). */
  const [demoSite, setDemoSite] = useState<string | null>(null);
  const [shakeKey, setShakeKey] = useState(0);
  const [brands, setBrands] = useState<BrandListItem[] | null>(null);
  const [arrived, setArrived] = useState(initialView === "camp");
  // Children anchor HTML to the world, so they mount only once the engine exists.
  const [engineReady, setEngineReady] = useState(false);
  const pathname = usePathname();
  const reducedMotion = useReducedMotion();
  // The demo has its own landing, so its camp's links and Back lead there.
  const home = demoOnly ? "/demo" : "/";

  // The camp lives under the same canvas: these pages are full-bleed and ignore any app chrome.
  useInertSiblings(rootRef);

  // --- The greeter ----------------------------------------------------------------------------
  // On the landing the door opens by itself and the greeter steps out to wait on the pavement;
  // once the website is in, it asks for preferences, then fetches the crew.
  const reducedRef = useRef(reducedMotion);
  reducedRef.current = reducedMotion;
  /** The greeter is out on the pavement (waiting, or asking). */
  const greeterOut = useRef(false);
  const [greeterWaiting, setGreeterWaiting] = useState(false);
  /** Its walk out is under way (the door's timer or the walk itself). */
  const greetPending = useRef(false);
  /** The website came in before the greeter was out: ask as soon as it is. */
  const askWhenOut = useRef(false);
  // The walk out runs on a timer; Back or leaving the page must stop it.
  const cancelGreet = useRef<() => void>(() => undefined);
  useEffect(() => () => cancelGreet.current(), []);

  /** Opens the door and sends the greeter out to wait (on arrival, after a failure, after Back). */
  const greet = useCallback(() => {
    const e = engine.current;
    if (!e || greeterOut.current || greetPending.current) return;
    cancelGreet.current();
    greetPending.current = true;
    const out = () => {
      greetPending.current = false;
      greeterOut.current = true;
      setGreeterWaiting(true);
      if (askWhenOut.current) {
        askWhenOut.current = false;
        setPhase("asking");
      }
    };
    if (reducedRef.current) {
      e.landing.openNow();
      e.greeter.comeOut(out, true);
      return;
    }
    e.landing.open();
    // The greeter steps out once the shutter is most of the way up.
    const timer = setTimeout(() => e.greeter.comeOut(out), OPEN_SECONDS * 0.6 * 1000);
    cancelGreet.current = () => {
      clearTimeout(timer);
      greetPending.current = false;
    };
  }, []);
  const greetRef = useRef(greet);
  greetRef.current = greet;

  /** The greeter is gone back inside (or put away): it no longer waits. */
  const greeterGone = useCallback(() => {
    greeterOut.current = false;
    greetPending.current = false;
    askWhenOut.current = false;
    setGreeterWaiting(false);
  }, []);

  // --- Engine lifecycle -------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const baker = new Baker();
    const stage = new Stage(canvas, baker);
    const landing = new LandingScene(stage, {});
    const camp = new CampScene(stage, landing);
    const greeter = new Greeter(stage);
    // The soldiers who march out of the horse are the camp's agents, in the order the camp needs them.
    landing.recruit = () => camp.nextRecruit();
    engine.current = { stage, baker, landing, camp, greeter };
    stage.onResize = () => frame(engine.current, viewRef.current, false);
    if (initialView === "camp") {
      landing.openNow();
      camp.show(true);
    }
    frame(engine.current, initialView, false);
    stage.start();
    setEngineReady(true);

    let alive = true;
    landing.island.reveal = 0;
    landing.body.reveal = 0;
    void landing.ready(baker).then(() => {
      if (!alive) return;
      // The horse appears grain by grain, like the island's rim.
      const start = performance.now();
      const grow = () => {
        if (!alive) return;
        const t = Math.min(1, (performance.now() - start) / 900);
        landing.island.reveal = t;
        landing.body.reveal = Math.min(1, t * 1.25);
        if (t < 1) requestAnimationFrame(grow);
      };
      requestAnimationFrame(grow);
      setPhase((p) => (p === "loading" ? "idle" : p));
      // Once the HQ has appeared, its door opens and the greeter steps out.
      if (initialView === "landing") setTimeout(() => alive && viewRef.current === "landing" && greetRef.current(), 1000);
    });
    void landing.preload(baker).catch(() => undefined);
    void greeter.preload(baker).catch(() => undefined);
    return () => {
      alive = false;
      stage.dispose();
      baker.dispose();
      engine.current = null;
      setEngineReady(false);
    };
    // The engine is created once per mount; view changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const viewRef = useRef(view);
  viewRef.current = view;
  // The opening runs on timers; Back or leaving the page must stop them.
  const cancelMarch = useRef<() => void>(() => undefined);
  useEffect(() => () => cancelMarch.current(), []);

  // Back/forward between the landing and "/camp/…" without remounting.
  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    if (pathname === home && viewRef.current === "camp") {
      cancelMarch.current();
      setView("landing");
      setArrived(false);
      setPhase("idle");
      cancelGreet.current();
      e.greeter.hide();
      greeterGone();
      e.landing.reset();
      e.camp.reset();
      e.camp.show(false);
      frame(e, "landing", true);
      greet();
    } else if (pathname?.startsWith("/camp/") && viewRef.current === "landing") {
      const id = decodeURIComponent(pathname.split("/")[2] ?? "");
      if (id) {
        setBrandId(id);
        setView("camp");
        setArrived(true);
        e.landing.openNow();
        e.camp.show(true);
        frame(e, "camp", true);
      }
    }
  }, [pathname, home, greet, greeterGone]);

  // Keep the form glued under the island.
  useLayoutEffect(() => {
    const e = engine.current;
    const el = formAnchorRef.current;
    if (!e || !el) return;
    return e.stage.anchor(el, () => ({ x: FORM_AT.x, y: FORM_AT.y, z: FORM_AT.z }));
  }, [engineReady, view]);

  // Returning visitors: their camps, from the core's brand list (none in demo builds).
  useEffect(() => {
    if (demoOnly) return;
    let alive = true;
    listBrands()
      .then((list) => alive && setBrands(list))
      .catch(() => alive && setBrands(null));
    return () => {
      alive = false;
    };
  }, [demoOnly]);

  /** The website box: the camera closes in on the greeter, who asks for preferences. */
  const submit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const e = engine.current;
      if (!e || (phase !== "idle" && phase !== "loading")) return;
      const checked = normalizeSite(site);
      const notInDemo = demoOnly && demoSites.length > 0 && !("error" in checked) && !demoSites.includes(checked.domain);
      if ("error" in checked || notInDemo) {
        setError("error" in checked ? checked.error : `This demo replays ${list(demoSites)}: type ${demoSites.length === 1 ? "it" : "one of them"} to open the gates.`);
        setShakeKey((k) => k + 1);
        e.landing.rattle();
        return;
      }
      setError(null);
      setPhase("greeting");
      const ask = () => {
        if (greeterOut.current) setPhase("asking");
        else {
          // Typed fast, before the greeter was out: it asks as soon as it is.
          askWhenOut.current = true;
          greet();
        }
      };
      // Close in on the greeter, then it asks.
      if (reducedMotion) {
        e.stage.look(greetCamera(e.stage), 0);
        ask();
      } else e.stage.look(greetCamera(e.stage), 1.2, easeInOutCubic, ask);
    },
    [phase, site, reducedMotion, demoOnly, demoSites, greet],
  );

  /** Back to the website box: the camera pulls back and the greeter waits on the pavement. */
  const cancelGreeting = useCallback(() => {
    const e = engine.current;
    if (!e) return;
    askWhenOut.current = false;
    frame(e, "landing", !reducedMotion);
    setPhase("idle");
  }, [reducedMotion]);

  /**
   * The visitor answered (or skipped): the greeter walks back in to fetch the crew while the
   * campaign starts, and the crew marches out once both are done.
   */
  const answer = useCallback(
    async (preferences: string) => {
      const e = engine.current;
      if (!e || phase !== "asking") return;
      const checked = normalizeSite(site);
      if ("error" in checked) return;
      setPhase("submitting");
      greeterGone();
      const backInside = new Promise<void>((resolve) => e.greeter.goIn(resolve, reducedMotion));
      try {
        const [result] = await Promise.all([
          demoOnly ? new Promise<{ brandId: string }>((resolve) => setTimeout(() => resolve({ brandId: DEMO_ID }), 700)) : startCampaign(site, preferences.trim() || undefined),
          backInside,
        ]);
        setBrandId(result.brandId);
        setDemoSite(result.brandId === DEMO_ID ? checked.domain : null);
        setPhase("opening");
        // The demo camp replays the recording for this website, if one is installed.
        // The demo keeps ?record= and ?autoplay= (recording it) on its way into the camp.
        const keep = new URLSearchParams(window.location.search);
        const extra = ["record", "autoplay"].map((k) => (keep.get(k) ? `&${k}=${encodeURIComponent(keep.get(k)!)}` : "")).join("");
        const href = result.brandId === DEMO_ID ? `/camp/${DEMO_ID}?site=${encodeURIComponent(checked.domain)}${extra}` : `/camp/${encodeURIComponent(result.brandId)}`;
        cancelMarch.current();
        cancelMarch.current = march(e, result.brandId, reducedMotion, () => {
          setView("camp");
          setPhase("marching");
          window.history.pushState(null, "", href);
        }, () => setArrived(true));
      } catch (err) {
        // Nobody is coming out: the door closes and the website box comes back with the reason.
        await backInside;
        e.landing.reset();
        frame(e, "landing", !reducedMotion);
        setPhase("idle");
        // The greeter comes back out to try again.
        setTimeout(() => viewRef.current === "landing" && greet(), 600);
        setError(err instanceof ApiFailure && err.status === 404 ? "Surreel's API isn't running here yet. Start the app with the core track merged." : err instanceof Error ? err.message : String(err));
        setShakeKey((k) => k + 1);
      }
    },
    [phase, site, reducedMotion, demoOnly, greet, greeterGone],
  );

  const busy = phase !== "idle" && phase !== "loading";
  const formGone = busy || view === "camp";

  return (
    <div ref={rootRef} className={`${styles.root} ${pixelFont.variable}`}>
      <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />

      {view === "landing" && (
        <header className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-5 px-5 py-4 sm:px-8 sm:py-6">
          <span className={`${styles.pixel} pointer-events-auto mr-auto flex items-center gap-2.5 text-[22px] font-semibold tracking-tight`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/nomen-logo.png" alt="" width={44} height={31} className="h-[31px] w-auto" />
            Surreel
          </span>
          {brands && brands.length > 0 && <BrandsMenu brands={brands} />}
          {!demoOnly && (
            <a href="/settings" className={`${styles.link} ${styles.pixel} pointer-events-auto text-[15px]`}>
              Settings
            </a>
          )}
        </header>
      )}

      {view === "landing" && engineReady && (
        <div ref={formAnchorRef} className="pointer-events-none absolute left-0 top-0 will-change-transform">
          <form
            key={shakeKey}
            onSubmit={submit}
            className={`pointer-events-auto -translate-x-1/2 ${formGone ? styles.leave : styles.enter} ${shakeKey ? styles.shake : ""}`}
            style={{ width: "min(440px, calc(100vw - 32px))" }}
            aria-label="Start a campaign"
          >
            <label htmlFor="troy-site" className={`${styles.pixel} mb-3 block text-center text-[15px] text-[var(--ink-soft)]`}>
              What&apos;s your company&apos;s website?
            </label>
            <div className={`${styles.box} flex items-center gap-2 py-1.5 pl-4 pr-1.5`}>
              <input
                id="troy-site"
                name="site"
                value={site}
                onChange={(event) => {
                  setSite(event.target.value);
                  if (error) setError(null);
                }}
                placeholder={demoOnly ? (demoSites[0] ?? "") : "yourcompany.com"}
                inputMode="url"
                autoComplete="url"
                autoCapitalize="none"
                spellCheck={false}
                autoFocus
                disabled={busy || formGone}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "troy-site-error" : "troy-site-hint"}
                className={`${styles.input} ${styles.pixel} h-11 flex-1 text-[19px]`}
              />
              <button type="submit" disabled={busy || formGone} className={`${styles.button} ${styles.pixel} h-10 shrink-0 px-4 text-[15px]`}>
                {busy ? (
                  <>
                    <span className={styles.spinner} aria-hidden="true" /> Knocking
                  </>
                ) : (
                  <>
                    <span className="hidden min-[420px]:inline">Open the gates</span>
                    <span className="min-[420px]:hidden">Open</span> <span aria-hidden="true">→</span>
                  </>
                )}
              </button>
            </div>
            <p id="troy-site-hint" className="mt-4 text-center text-[13px] leading-relaxed text-[var(--ink-soft)]">
              {demoOnly && (
                <span className="block text-[12px] text-[var(--ink-faint)]">
                  This is the demo: the HQ replays {demoSites.length ? `the finished campaign for ${list(demoSites)}` : "a finished campaign"}, so nothing is spent.
                </span>
              )}
              <a href={demoOnly ? "/camp/demo" : "/demo"} className={`${styles.link} ${styles.pixel} mt-2 inline-block text-[13px] underline decoration-dotted underline-offset-4`}>
                {demoOnly ? "Or skip straight to the HQ →" : "Or try the demo, which spends nothing →"}
              </a>
            </p>
            <p id="troy-site-error" role="alert" className="mt-2 min-h-5 text-center text-[13px] font-medium text-[var(--crimson)]">
              {error}
            </p>
          </form>
        </div>
      )}

      {/* The camp mounts as the doors open, so its agents are ready to march out when the plank lands. */}
      {engineReady && brandId && (view === "camp" || phase === "opening" || phase === "marching") && <Camp brandId={brandId} arrived={arrived} engine={engine} home={home} site={demoSite} />}

      {view === "landing" && engineReady && greeterWaiting && (phase === "idle" || phase === "loading") && <GreetingBubble engine={engine} />}
      {view === "landing" && engineReady && phase === "asking" && <PreferenceBubble engine={engine} onAnswer={answer} onCancel={cancelGreeting} />}

      <p className="sr-only" aria-live="polite">
        {phase === "greeting" ? "The door opens and an agent steps out to greet you." : phase === "submitting" ? "The agent goes back in to fetch the crew." : phase === "opening" ? "Your agents are on their way down to the HQ." : ""}
      </p>
    </div>
  );
}

/** Frames the camera for a view: the horse with room for the form, or the camp. */
function frame(e: { stage: Stage; camp: CampScene } | null, view: View, animate: boolean) {
  if (!e) return;
  const target = view === "camp" ? e.camp.camera() : landingCamera(e.stage);
  e.stage.look(target, animate ? 1.6 : 0, easeInOutCubic);
}

/** The form sits on the road in front of the HQ's door (world point). */
const FORM_AT = { x: 46, y: 46, z: ROOM.wall };
/** Its screen y (art px). */
const FORM_SY = 46 - 1.2247 * ROOM.wall;

export function landingCamera(stage: Stage) {
  const { width, height } = stage.size;
  const formHeight = 232;
  const top = FORM_SY - 160; // the top of the HQ's building and its aerial
  const bottom = FORM_SY;
  // On phones the island's rim may run off the sides; the horse itself must fit.
  const halfWidth = width < 640 ? 94 : 170;
  const fit = Math.min((height - formHeight - 40) / (bottom - top), (width - 24) / (halfWidth * 2), 3.5);
  const zoom = stage.fitZoom(fit);
  const total = (bottom - top) * zoom + formHeight;
  const topPx = Math.max(20, (height - total) / 2);
  return { x: 20, y: top - (topPx - height / 2) / zoom, zoom };
}

/** Seconds the camera takes to follow the column from the horse down to the camp. */
const FOLLOW_SECONDS = 6.5;

/**
 * Doors, plank, and the camp's agents marching out and down to their posts, with the camera
 * following them. Returns a cancel function.
 */
function march(e: { stage: Stage; landing: LandingScene; camp: CampScene }, brandId: string, reduced: boolean, toCamp: () => void, arrived: () => void) {
  const { stage, landing, camp } = e;
  camp.prepare(brandId);
  if (reduced) {
    landing.openNow();
    camp.show(true);
    toCamp();
    stage.look(camp.camera(), 0);
    arrived();
    return () => undefined;
  }
  camp.beginEntrance();
  // The greeter already opened the door: the crew comes out right behind it.
  const plankDown = landing.isOpen ? 400 : OPEN_SECONDS * 0.885 * 1000;
  landing.open();
  const timers = [
    // The road to the camp appears as the plank lands, and the first soldier steps out.
    setTimeout(() => {
      camp.show(true);
      landing.startStream();
    }, plankDown),
    // Follow the column down to the camp.
    setTimeout(() => {
      toCamp();
      stage.look(camp.camera(), FOLLOW_SECONDS, easeInOutSine, arrived);
    }, plankDown + 700),
  ];
  return () => timers.forEach(clearTimeout);
}

/** The greeter's hello while it waits for the website: a small pixel bubble over its head. */
function GreetingBubble({ engine }: { engine: RefObject<Engine | null> }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const e = engine.current;
    if (!e || !ref.current) return;
    return e.stage.anchor(ref.current, () => e.greeter.head());
  }, [engine]);
  return (
    <div ref={ref} className="pointer-events-none absolute left-0 top-0 z-[8] will-change-transform" role="status">
      <div className={`${styles.enter} -translate-x-1/2 -translate-y-full`}>
        <p className={`${styles.box} ${styles.pixel} whitespace-nowrap px-2.5 py-1.5 text-center text-[13px] leading-snug text-[var(--ink)]`}>Hi! What&apos;s your website?</p>
        <svg width="14" height="8" viewBox="0 0 7 4" shapeRendering="crispEdges" aria-hidden="true" className="mx-auto -mt-[3px] block">
          <path d="M0 0h7v1h-1v1h-1v1h-1v1h-1v-1h-1v-1h-1v-1h-1z" fill="var(--ink)" />
          <path d="M1 0h5v1h-1v1h-1v1h-1v-1h-1v-1h-1z" fill="var(--paper)" />
        </svg>
      </div>
    </div>
  );
}

/** Longest answer the greeter takes. */
const PREFERENCES_MAX = 600;

/**
 * The greeter's question, in a pixel speech bubble over its head: what the visitor wants (tone,
 * audience, things to avoid…). Optional: "No, go ahead" sends the crew in with nothing.
 */
function PreferenceBubble({ engine, onAnswer, onCancel }: { engine: RefObject<Engine | null>; onAnswer: (preferences: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  useLayoutEffect(() => {
    const e = engine.current;
    if (!e || !ref.current) return;
    return e.stage.anchor(ref.current, () => e.greeter.head());
  }, [engine]);
  return (
    <div ref={ref} className="pointer-events-none absolute left-0 top-0 z-[10] will-change-transform">
      <form
        className={`${styles.enter} pointer-events-auto -translate-x-1/2 -translate-y-full`}
        style={{ width: "min(360px, calc(100vw - 32px))" }}
        aria-label="Your preferences"
        onSubmit={(event) => {
          event.preventDefault();
          onAnswer(text);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
      >
        <div className={`${styles.box} px-4 pb-3 pt-3.5`}>
          <label htmlFor="troy-preferences" className={`${styles.pixel} mb-2.5 block text-center text-[15px] leading-snug text-[var(--ink)]`}>
            Do you have any preference or requirements?
          </label>
          <textarea
            id="troy-preferences"
            value={text}
            onChange={(event) => setText(event.target.value.slice(0, PREFERENCES_MAX))}
            onKeyDown={(event) => {
              // Enter sends; Shift+Enter makes a new line.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onAnswer(text);
              }
            }}
            rows={2}
            autoFocus
            placeholder="e.g. playful tone, aimed at students, no voice-over, mention the free trial"
            className={`${styles.input} block w-full resize-none rounded-sm border-2 border-[rgba(200,196,255,0.15)] px-2.5 py-2 text-[14px] leading-snug`}
          />
          <div className="mt-3 flex items-center justify-end gap-3">
            <button type="button" onClick={() => onAnswer("")} className={`${styles.link} ${styles.pixel} whitespace-nowrap text-[13px]`}>
              No, go ahead
            </button>
            <button type="submit" disabled={!text.trim()} className={`${styles.button} ${styles.pixel} h-9 shrink-0 whitespace-nowrap px-3 text-[13px]`}>
              Tell the crew <span aria-hidden="true">→</span>
            </button>
          </div>
          <button type="button" onClick={onCancel} className={`${styles.link} ${styles.pixel} mt-1.5 text-[12px]`}>
            ← Change website
          </button>
        </div>
        <svg width="14" height="8" viewBox="0 0 7 4" shapeRendering="crispEdges" aria-hidden="true" className="mx-auto -mt-[3px] block">
          <path d="M0 0h7v1h-1v1h-1v1h-1v1h-1v-1h-1v-1h-1v-1h-1z" fill="var(--ink)" />
          <path d="M1 0h5v1h-1v1h-1v1h-1v-1h-1v-1h-1z" fill="var(--paper)" />
        </svg>
      </form>
    </div>
  );
}

function BrandsMenu({ brands }: { brands: BrandListItem[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pointer-events-auto relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={`${styles.link} ${styles.pixel} text-[15px]`}>
        Your camps ({brands.length}) {open ? "▴" : "▾"}
      </button>
      {open && (
        <ul className={`${styles.boxSoft} absolute right-0 top-9 z-10 max-h-[60vh] w-72 overflow-y-auto py-2 text-sm`}>
          {brands.map((brand) => (
            <li key={brand.id}>
              <a href={`/camp/${encodeURIComponent(brand.id)}`} className="flex items-center justify-between gap-3 px-4 py-2 hover:bg-[var(--sand)]/40">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{brand.name}</span>
                  <span className="block truncate text-xs text-[var(--ink-soft)]">{brand.domain}</span>
                </span>
                <span className={`${styles.pixel} shrink-0 text-xs text-[var(--ink-soft)]`}>{brand.campaign ? stageWord(brand.campaign.stage, brand.campaign.status) : "idle"}</span>
              </a>
            </li>
          ))}
          <li className="mt-1 border-t-2 border-[rgba(200,196,255,0.1)] px-4 pt-2">
            <a href="/brands" className={`${styles.link} ${styles.pixel} text-[13px]`}>
              All brands and workspaces →
            </a>
          </li>
        </ul>
      )}
    </div>
  );
}

export function stageWord(stage: string, status: string) {
  if (status === "failed") return "needs you";
  if (status === "review") return "review";
  if (status === "live") return "live";
  if (status === "publishing") return "posting";
  return { research: "scouting", style: "studying", strategy: "planning", production: "filming", review: "review", live: "live" }[stage] ?? stage;
}

/** "a", "a or b", "a, b or c". */
function list(items: string[]) {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}
