"use client";

import { useLayoutEffect, useRef, useState } from "react";
import styles from "../troy.module.css";
import { recording, type Tour } from "./useTour";

/** Narrower than this, the room left in the top bar can't hold the card: it goes just under the bar. */
const MIN_GAP = 360;
/** The side panels' column on the right (16 px from the edge, 420 wide, and a gap): the guide stays clear of it. */
const PANEL = 452;
/** The guide's widest. */
const MAX_WIDTH = 640;

/** The folded state is the viewer's own: remembered between visits. */
const FOLD_KEY = "adtopia.tourFolded";

export function readFolded() {
  try {
    return window.localStorage.getItem(FOLD_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveFolded(folded: boolean) {
  try {
    window.localStorage.setItem(FOLD_KEY, folded ? "1" : "0");
  } catch {
    // Private windows and blocked storage: it just isn't remembered.
  }
}

/**
 * The tour's guide: which step of the animation is on, and what is happening in it, for someone
 * seeing the HQ for the first time. On wide screens it stays in one place at the top of the screen,
 * in the middle and clear of the side panels' column, the same size on every step, and tells the
 * camp how far down it reaches (`onBottom`) so the camera frames the HQ below it. It folds up out of the way
 * (`onFold`), leaving a pull-cord at the top of the screen (PullCord) to bring it back down.
 */
export function TourCard({
  tour,
  wide,
  screening,
  clear = 0,
  onBottom,
  playing = true,
  onPause,
  onFold,
}: {
  tour: Tour;
  wide: boolean;
  screening: boolean;
  clear?: number;
  onBottom?: (bottom: number) => void;
  /** The replay is running; on autoplay the card's button pauses and resumes it (and the tour). */
  playing?: boolean;
  onPause?: () => void;
  /** Folds the card up out of the way, leaving the pull-cord. */
  onFold?: () => void;
}) {
  const step = tour.step;
  // Recording the demo: the captions stay, the buttons go.
  const [buttons] = useState(() => !recording());
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 1280 : window.innerWidth));
  const card = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const measure = () => setWidth(window.innerWidth);
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // How far down the card reaches at the top of the screen (0 when it isn't there).
  const atTop = wide && Boolean(step);
  useLayoutEffect(() => {
    if (!onBottom) return;
    const el = card.current;
    if (!atTop || !el) {
      onBottom(0);
      return;
    }
    const report = () => onBottom(Math.round(el.getBoundingClientRect().bottom));
    report();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(report) : null;
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [atTop, onBottom, width]);
  useLayoutEffect(() => () => onBottom?.(0), [onBottom]);

  if (!step) return null;
  const n = tour.index + 1;
  const last = n >= tour.steps.length;
  // One place and one size for every step, whatever else is open: in the middle of the top of the
  // screen, as wide as fits between the side panels' column on the right (PANEL) and its mirror on
  // the left, so the guide and a station's panel never overlap. On a screen too narrow for that,
  // it goes just under the top bar (clear of the logo), left of the panels' column.
  const centred = Math.min(MAX_WIDTH, width - 2 * PANEL);
  const style = !wide
    ? { left: 12, right: 12, top: 64 }
    : centred >= MIN_GAP
      ? { left: (width - centred) / 2, width: centred, top: 12 }
      : { left: 16, width: Math.max(300, width - PANEL - 16), top: 64 };
  return (
    <div className="pointer-events-none absolute z-50 flex justify-center" style={style}>
      {/* The same card throughout: only its words change from step to step, nothing flashes. */}
      <section ref={card} aria-label="Guide" aria-live="polite" className={`${styles.box} ${styles.enter} pointer-events-auto w-full px-3.5 pb-2.5 pt-2`}>
        <div className="flex items-center gap-2.5">
          <span className={`${styles.pixel} shrink-0 text-[12px] text-[var(--crimson)]`}>
            {n}/{tour.steps.length}
          </span>
          <h2 className={`${styles.pixel} min-w-0 flex-1 text-[16px] font-semibold leading-tight`}>
            {step.title}
          </h2>
          {buttons && (
          <span className="flex shrink-0 items-center gap-[3px]">
            {/* The same keys on every step, the same size and colours: only the words above change. */}
            {tour.auto && onPause && (
              <button type="button" onClick={onPause} className={`${styles.button} ${styles.guideKey} ${styles.pixel} h-8 w-9 text-[13px]`} aria-label={playing ? "Pause" : "Play"} title={`${playing ? "Pause" : "Play"} (Space)`}>
                {playing ? "❚❚" : "▶"}
              </button>
            )}
            <button type="button" onClick={() => n > 1 && tour.back()} aria-disabled={n <= 1} className={`${styles.button} ${styles.guideKey} ${styles.pixel} h-8 w-9 text-[15px]`} aria-label="Back" title="Back (←)">
              ←
            </button>
            <button type="button" onClick={() => !last && tour.next()} aria-disabled={last} className={`${styles.button} ${styles.buttonInk} ${styles.guideKey} ${styles.pixel} h-8 w-[76px] text-[13px]`} aria-label={last ? "The end" : "Next"} title="Next (→)">
              {last ? "End" : "Next →"}
            </button>
          </span>
          )}
          {buttons && (
            <button type="button" onClick={onFold ?? tour.toggle} className={`${styles.button} ${styles.guideFold} ${styles.pixel} ml-1 h-8 w-9 shrink-0 text-[18px] leading-none`} aria-label="Fold the guide away" title="Fold the guide away (T)">
              ▴
            </button>
          )}
        </div>
        {/* Room for the longest step's words, so the card keeps its height from step to step. */}
        <p className="mt-1 min-h-[5.5em] text-[13px] leading-snug text-[var(--ink-soft)]">{step.body}</p>
        {/* How far through the tour; on autoplay it fills on through each step's time. */}
        <span aria-hidden="true" className="mt-2 block h-[3px] bg-[rgba(200,196,255,0.12)]">
          {tour.auto ? (
            <TimerBar key={tour.timer.key} from={(n - 1) / tour.steps.length} to={n / tour.steps.length} dwell={tour.timer.dwell} spent={tour.timer.spent} running={tour.timer.running} />
          ) : (
            <span className="block h-full bg-[var(--crimson)] transition-[width] duration-300" style={{ width: `${(n / tour.steps.length) * 100}%` }} />
          )}
        </span>
      </section>
    </div>
  );
}

/**
 * The folded guide's pull-cord: a cord hanging from the top of the screen with a tab on its end;
 * pulling it brings the guide back down.
 */
export function PullCord({ onPull }: { onPull: () => void }) {
  return (
    <div className="pointer-events-none absolute left-1/2 top-0 z-50 flex -translate-x-1/2 flex-col items-center">
      <span aria-hidden="true" className={styles.cord} />
      <button type="button" onClick={onPull} className={`${styles.cordTab} ${styles.pixel} pointer-events-auto`} aria-label="Pull down the guide" title="Pull down the guide (T)">
        Guide <span aria-hidden="true">▾</span>
      </button>
    </div>
  );
}

/** The tour's bar on autoplay: from this step's start to its end, over the time it has left. */
function TimerBar({ from, to, dwell, spent, running }: { from: number; to: number; dwell: number; spent: number; running: boolean }) {
  const at = from + (to - from) * Math.min(1, dwell ? spent / dwell : 1);
  const [width, setWidth] = useState(at);
  const [transition, setTransition] = useState("none");
  useLayoutEffect(() => {
    // Where it is now, then (next frame) on to the end over the time left; paused, it stays put.
    setTransition("none");
    setWidth(at);
    if (!running) return;
    const frame = requestAnimationFrame(() => {
      setTransition(`width ${Math.max(0, dwell - spent)}s linear`);
      setWidth(to);
    });
    return () => cancelAnimationFrame(frame);
  }, [at, to, dwell, spent, running]);
  return <span className="block h-full bg-[var(--crimson)]" style={{ width: `${width * 100}%`, transition }} />;
}
