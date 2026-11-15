"use client";

import { usePathname } from "next/navigation";
import { type FormEvent, type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiFailure, type BrandListItem, listBrands, normalizeSite, startCampaign } from "./api";
import { Baker } from "./engine/baker";
import { easeInOutCubic, easeInOutSine, Stage } from "./engine/stage";
import { pixelFont } from "./fonts";
import { CampScene } from "./scenes/camp";
import { GREETER, Greeter } from "./scenes/greeter";
import { LandingScene, OPEN_SECONDS } from "./scenes/landing";
import { ENTRANCE, ROOM, STREET_LANE } from "./scenes/layout";
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
  /** What the visitor tells the greeter for the crew (the second answer, in the same box). */
  const [crewNote, setCrewNote] = useState("");
  /** The greeter is calling the crew out as it leads them down (its one line besides its questions). */
  const [rollOut, setRollOut] = useState(false);
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
    // Quietly: the sparks are saved for the crew.
    e.landing.open(true);
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

  /** The website is in: the greeter asks what the crew should know, in the same box. */
  const submit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const e = engine.current;
      if (!e || (phase !== "idle" && phase !== "loading")) return;
      const checked = normalizeSite(site);
      const notInDemo = demoOnly && demoSites.length > 0 && !("error" in checked) && !demoSites.includes(checked.domain);
      if ("error" in checked || notInDemo) {
        setError("error" in checked ? checked.error : `This demo replays ${list(demoSites)}: type ${demoSites.length === 1 ? "it" : "one of them"} for ${GREETER.name}.`);
        setShakeKey((k) => k + 1);
        e.landing.rattle();
        return;
      }
      setError(null);
      // The greeter asks its second question; the box below becomes the answer to it.
      if (greeterOut.current) setPhase("asking");
      else {
        // Typed fast, before the greeter was out: it asks as soon as it is.
        setPhase("greeting");
        askWhenOut.current = true;
        greet();
      }
    },
    [phase, site, demoOnly, demoSites, greet],
  );

  /** Back to the website: the greeter asks for it again. */
  const cancelGreeting = useCallback(() => {
    askWhenOut.current = false;
    setPhase("idle");
  }, []);

  /**
   * The visitor answered (or skipped): the greeter walks back in to fetch the crew while the
   * campaign starts, and the crew marches out once both are done.
   */
  const answer = useCallback(
    async (preferences: string) => {
      setCrewNote("");
      const e = engine.current;
      if (!e || phase !== "asking") return;
      const checked = normalizeSite(site);
      if ("error" in checked) return;
      setPhase("submitting");
      try {
        // The greeter waits outside while the campaign starts; then it leads the crew down.
        const result = await (demoOnly ? new Promise<{ brandId: string }>((resolve) => setTimeout(() => resolve({ brandId: DEMO_ID }), 700)) : startCampaign(site, preferences.trim() || undefined));
        greeterGone();
        setBrandId(result.brandId);
        setDemoSite(result.brandId === DEMO_ID ? checked.domain : null);
        setPhase("opening");
        // The demo camp replays the recording for this website, if one is installed.
        // The demo keeps ?record= and ?autoplay= (recording it) on its way into the camp.
        const keep = new URLSearchParams(window.location.search);
        const extra = ["record", "autoplay"].map((k) => (keep.get(k) ? `&${k}=${encodeURIComponent(keep.get(k)!)}` : "")).join("");
        const href = result.brandId === DEMO_ID ? `/camp/${DEMO_ID}?site=${encodeURIComponent(checked.domain)}${extra}` : `/camp/${encodeURIComponent(result.brandId)}`;
        cancelMarch.current();
        if (reducedMotion) e.greeter.hide();
        cancelMarch.current = march(
          e,
          result.brandId,
          reducedMotion,
          () => {
            setView("camp");
            setPhase("marching");
            window.history.pushState(null, "", href);
          },
          () => setArrived(true),
          // The greeter leads the crew down, calling them out.
          () => {
            e.greeter.lead();
            setRollOut(true);
            setTimeout(() => setRollOut(false), 3600);
          },
        );
      } catch (err) {
        // Nobody is coming out: the greeter, still outside, asks for the website again, and the
        // box comes back with the reason.
        setPhase("idle");
        setError(err instanceof ApiFailure && err.status === 404 ? "Surreel's API isn't running here yet. Start the app with the core track merged." : err instanceof Error ? err.message : String(err));
        setShakeKey((k) => k + 1);
      }
    },
    [phase, site, reducedMotion, demoOnly, greeterGone],
  );

  // The box asks for the website, then (in the same place) for anything the crew should know.
  const askingCrew = phase === "asking";
  // The box keeps showing the second question while it leaves, after the answer.
  const crewStep = askingCrew || phase === "submitting";
  const busy = phase !== "idle" && phase !== "loading";
  const siteChecked = normalizeSite(site);
  const siteDomain = "error" in siteChecked ? null : siteChecked.domain;
  const formGone = (busy && phase !== "asking" && phase !== "greeting") || view === "camp";

  return (
    <div ref={rootRef} className={`${styles.root} ${pixelFont.variable}`}>
      <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />

      {view === "landing" && (
        <header className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-5 px-5 py-4 sm:px-8 sm:py-6">
          <span className={`${styles.pixel} pointer-events-auto mr-auto flex items-center gap-2.5 text-[22px] font-semibold tracking-tight`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/surreel-mark.svg" alt="" width={31} height={31} className="size-[31px]" style={{ imageRendering: "pixelated" }} />
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
            key={`${shakeKey}-${crewStep ? "crew" : "site"}`}
            onSubmit={(event) => {
              if (!askingCrew) return submit(event);
              event.preventDefault();
              void answer(crewNote);
            }}
            onKeyDown={(event) => {
              if (askingCrew && event.key === "Escape") cancelGreeting();
            }}
            className={`pointer-events-auto -translate-x-1/2 ${formGone ? styles.leave : styles.enter} ${shakeKey ? styles.shake : ""}`}
            // The second question: the bubble first, the box a beat after it.
            style={{ width: "min(440px, calc(100vw - 32px))", animationDelay: askingCrew ? "450ms" : undefined }}
            aria-label={crewStep ? "Anything the crew should know" : "Start a campaign"}
          >
            {/* The greeter asks (its bubble); this box is the visitor's answer, the same each time. */}
            <label htmlFor="troy-site" className={`${styles.pixel} mb-2 block text-[12px] uppercase tracking-wider text-[var(--ink-faint)]`}>
              {crewStep ? "For the crew (optional)" : "Your website"}
            </label>
            {/* A console: the field (its border lights up on focus) and, apart from it, the key. */}
            <div className={styles.console}>
              <div className={styles.consoleSlot}>
                <div className={styles.consoleField}>
                  <div className={styles.consoleInner}>
                    <span className={`${styles.consolePrompt} ${styles.pixel}`} aria-hidden="true">
                      &gt;
                    </span>
              {crewStep ? (
                <input
                  id="troy-site"
                  name="preferences"
                  value={crewNote}
                  onChange={(event) => setCrewNote(event.target.value.slice(0, PREFERENCES_MAX))}
                  placeholder="e.g. playful, for students"
                  autoComplete="off"
                  autoFocus
                  disabled={!askingCrew}
                  className={`${styles.input} ${styles.pixel} h-12 min-w-0 flex-1 text-[17px]`}
                />
              ) : (
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
                  aria-describedby={error ? "troy-site-error" : undefined}
                  className={`${styles.input} ${styles.pixel} h-12 min-w-0 flex-1 text-[19px]`}
                />
              )}
                  </div>
                </div>
              </div>
              <div className={styles.consoleKeySlot}>
                <button type="submit" disabled={(busy && !askingCrew) || formGone} className={`${styles.consoleKey} ${styles.pixel} text-[15px]`}>
                  {busy && !askingCrew ? (
                    <>
                      <span className={styles.spinner} aria-hidden="true" /> {GREETER.name}&apos;s on it
                    </>
                  ) : (
                    <>
                      <span className={styles.consoleKeyText}>
                        {crewStep ? (
                          crewNote.trim() ? "Tell the crew" : "Surprise us"
                        ) : (
                          <>
                            <span className="hidden min-[420px]:inline">Hand it over</span>
                            <span className="min-[420px]:hidden">Go</span>
                          </>
                        )}
                      </span>
                      <span className={styles.consoleArrow} aria-hidden="true">
                        →
                      </span>
                    </>
                  )}
                </button>
              </div>
            </div>
            <p id="troy-site-error" role="alert" className="mt-3 min-h-5 text-center text-[13px] font-medium text-[var(--crimson)]">
              {askingCrew ? null : error}
            </p>
          </form>
        </div>
      )}

      {/* The camp mounts as the doors open, so its agents are ready to march out when the plank lands. */}
      {engineReady && brandId && (view === "camp" || phase === "opening" || phase === "marching") && <Camp brandId={brandId} arrived={arrived} engine={engine} home={home} site={demoSite} />}

      {/* Neon says three things: its two questions, and the call as it leads the crew down. */}
      {engineReady && rollOut && (
        <GreeterBubble key="rollout" engine={engine}>
          Crew, down to the HQ! Let&apos;s roll out!
        </GreeterBubble>
      )}
      {view === "landing" && engineReady && greeterWaiting && (phase === "idle" || phase === "loading" || phase === "asking") && (
        <GreeterBubble key={phase === "asking" ? "crew" : "site"} engine={engine}>
          {phase === "asking" ? (
            <>
              {siteDomain ? (
                <>
                  <span className="text-[var(--teal)]">{siteDomain}</span>, nice!
                </>
              ) : (
                "Nice!"
              )}{" "}
              Anything the crew should know? Tone, audience, things to skip…
            </>
          ) : (
            <>Hey, I&apos;m {GREETER.name}! Which site are we making videos for?</>
          )}
        </GreeterBubble>
      )}

      <p className="sr-only" aria-live="polite">
        {phase === "greeting" ? `${GREETER.name} comes over to ask about your videos.` : phase === "submitting" ? `${GREETER.name} heads back in to fetch the crew.` : phase === "opening" ? "The crew is on its way down to the HQ." : ""}
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

/**
 * The landing's picture on screen (art px): the slab of street the HQ stands on, from its left to
 * its right corner, from the top of the HQ's aerial to the slab's front corner underneath.
 */
const LANDING_SLAB = { x0: -48, x1: 48, y0: ENTRANCE.y - ENTRANCE.depth - 6, y1: STREET_LANE + 22 };
const LANDING_VIEW = {
  sx0: LANDING_SLAB.x0 - LANDING_SLAB.y1,
  sx1: LANDING_SLAB.x1 - LANDING_SLAB.y0,
  top: (ENTRANCE.x - ENTRANCE.half + ENTRANCE.y - ENTRANCE.depth) / 2 - 1.2247 * (ROOM.wall + ENTRANCE.tall + 32),
  bottom: (LANDING_SLAB.x1 + LANDING_SLAB.y1) / 2 - 1.2247 * (ROOM.wall - 8),
};
/** Its middle across, where the box below is centred too. */
const LANDING_MID = (LANDING_VIEW.sx0 + LANDING_VIEW.sx1) / 2;
/** Art px between the slab's bottom corner and the box. */
const FORM_GAP = 14;
/** The box hangs from this world point: centred under the picture, just below it. */
const FORM_AT = (() => {
  const z = ROOM.wall - 8;
  const sum = 2 * (LANDING_VIEW.bottom + FORM_GAP + 1.2247 * z);
  return { x: (sum + LANDING_MID) / 2, y: (sum - LANDING_MID) / 2, z };
})();

/**
 * The landing's camera: the HQ, its slab of street and the box under it, together, in the middle
 * of the screen across and down.
 */
export function landingCamera(stage: Stage) {
  const { width, height } = stage.size;
  // The label, the box and the line for an error under it (CSS px).
  const formHeight = 130;
  const span = LANDING_VIEW.bottom + FORM_GAP - LANDING_VIEW.top;
  const fit = Math.min((height - formHeight - 80) / span, (width - 32) / (LANDING_VIEW.sx1 - LANDING_VIEW.sx0), 3.5);
  const zoom = stage.fitZoom(fit);
  const total = span * zoom + formHeight;
  const topPx = Math.max(20, (height - total) / 2);
  return { x: LANDING_MID, y: LANDING_VIEW.top - (topPx - height / 2) / zoom, zoom };
}

/** Seconds the camera takes to follow the column from the horse down to the camp. */
const FOLLOW_SECONDS = 6.5;

/**
 * Doors, plank, and the camp's agents marching out and down to their posts, with the camera
 * following them. Returns a cancel function.
 */
function march(e: { stage: Stage; landing: LandingScene; camp: CampScene }, brandId: string, reduced: boolean, toCamp: () => void, arrived: () => void, lead?: () => void) {
  const { stage, landing, camp } = e;
  camp.prepare(brandId);
  // A leader out front calls the crew out instead of the first of them.
  if (lead && !reduced) camp.muteRollOut();
  if (reduced) {
    landing.openNow();
    camp.show(true);
    toCamp();
    stage.look(camp.camera(), 0);
    arrived();
    return () => undefined;
  }
  camp.beginEntrance();
  // The greeter already opened the door (quietly): the crew comes out right behind it, with the
  // burst of sparks the greeter's opening saved for them.
  const wasOpen = landing.isOpen;
  const plankDown = wasOpen ? 400 : OPEN_SECONDS * 0.885 * 1000;
  landing.open();
  const timers = [
    // The road to the camp appears as the plank lands, and the first soldier steps out.
    setTimeout(() => {
      if (wasOpen) landing.burst();
      lead?.();
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

/**
 * A speech bubble from the greeter, up and to the left of its head, a short pixel tail at its
 * bottom right pointing down at it. Always the same: the same width, who is talking in small pixel
 * capitals, then what they say; only the words change. (On a narrow screen: straight above.)
 */
function GreeterBubble({ engine, children }: { engine: RefObject<Engine | null>; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const e = engine.current;
    if (!e || !ref.current) return;
    return e.stage.anchor(ref.current, () => e.greeter.head());
  }, [engine]);
  return (
    <div ref={ref} className="pointer-events-none absolute left-0 top-0 z-[8] will-change-transform" role="status">
      <div className={styles.greeterBubble}>
        <div className={styles.enter}>
          <div className={`${styles.box} relative px-3.5 pb-3 pt-2.5`}>
            <p className={`${styles.pixel} mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-[var(--teal)]`}>
              {GREETER.name} <span className="text-[var(--ink-faint)]">· {GREETER.role}</span>
            </p>
            <p className={`${styles.pixel} text-[15px] leading-[1.45] text-[var(--ink)]`}>{children}</p>
            {/*
              The tail, in the bubble's own colours and its border's 3 px steps: it hangs from the
              bottom right corner, its right edge carrying on the bubble's border straight down, its
              top opening into the bubble, its left edge stepping down to the tip.
            */}
            <svg width="21" height="18" viewBox="0 0 7 6" shapeRendering="crispEdges" aria-hidden="true" className={styles.greeterTail}>
              {[0, 1, 2, 3, 4].map((r) => (
                <g key={r}>
                  <rect x={r} y={r} width="1" height="1" fill="var(--line)" />
                  <rect x={r + 1} y={r} width={5 - r} height="1" fill="var(--paper)" />
                  <rect x="6" y={r} width="1" height="1" fill="var(--line)" />
                </g>
              ))}
              <rect x="5" y="5" width="2" height="1" fill="var(--line)" />
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Longest note the greeter takes for the crew. */
const PREFERENCES_MAX = 600;

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
