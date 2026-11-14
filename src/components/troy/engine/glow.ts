import { projectX, projectY } from "./tracer";

// The HQ's light: soft halos round every neon tube, sign, lamp and screen, drawn over the baked
// sprites each frame so they can breathe and flicker. The halos are drawn into a small canvas, a
// glow pixel to every two art pixels, and scaled up without smoothing, so the light stays as
// chunky as the art. Added with "lighter" so it brightens what is under it and never darkens.

type P = { x: number; y: number; z: number };

export type GlowSource = {
  /** A point, or the start of a tube when `b` is set. */
  a: P;
  b?: P;
  /** "r, g, b". */
  rgb: string;
  /** Halo radius in art pixels. */
  r: number;
  /** Peak opacity, 0..1. */
  strength: number;
  /** How much it breathes (0 none, 1 fully), and how often it flickers out for a moment (0..1). */
  pulse?: number;
  flicker?: number;
  phase: number;
  /** Lit on the landing too (the HQ's door and its street), not only once the room is shown. */
  always?: boolean;
};

export const NEON = {
  pink: "240, 92, 205",
  cyan: "82, 217, 237",
  blue: "61, 123, 255",
  amber: "245, 184, 106",
  violet: "160, 120, 255",
  white: "230, 240, 255",
  red: "255, 90, 110",
  jade: "77, 195, 160",
} as const;

/**
 * How big and how strong every halo is, against the sizes the sources ask for: kept small and
 * thin so the light reads clear and the pixel art shows through it.
 */
export const GLOW_SIZE = 0.72;
export const GLOW_ALPHA = 0.68;

const hash = (n: number) => {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
};

/** Neon motes drifting up through the room and over the street. */
type Mote = { x: number; y: number; z0: number; speed: number; rgb: string; phase: number; top: number; always: boolean };

export class GlowLayer {
  private canvas: HTMLCanvasElement | null = null;
  private motes: Mote[] = [];

  constructor(
    private readonly sources: () => GlowSource[],
    area: { x0: number; y0: number; x1: number; y1: number; z: number },
    motes = 70,
  ) {
    this.addMotes(area, motes, false);
  }

  /** Scatters `count` motes over a world box, up to height `area.z`. */
  addMotes(area: { x0: number; y0: number; x1: number; y1: number; z: number; z0?: number }, count: number, always: boolean) {
    const colours = [NEON.pink, NEON.cyan, NEON.blue, NEON.violet];
    const seed = this.motes.length;
    for (let i = seed; i < seed + count; i++) {
      this.motes.push({
        x: area.x0 + hash(i * 3.1) * (area.x1 - area.x0),
        y: area.y0 + hash(i * 7.7) * (area.y1 - area.y0),
        z0: (area.z0 ?? 0) + hash(i * 1.9) * (area.z - (area.z0 ?? 0)),
        speed: 2 + hash(i * 5.3) * 5,
        rgb: colours[i % colours.length],
        phase: hash(i * 9.1) * 10,
        top: area.z,
        always,
      });
    }
  }

  /** 0..1: the landing's own lights (sources marked `always`), lit once the HQ's door is drawn. */
  landingLevel = 0;
  /** 0..1: everything fades in with the room and out when it is hidden. */
  level = 0;
  /** Where steam rises from (coffee cups): a few pale pixels drifting up and fading. */
  steam: () => P[] = () => [];

  paint(ctx: CanvasRenderingContext2D, sx: number, sy: number, px: number, time: number) {
    if ((this.level <= 0.01 && this.landingLevel <= 0.01) || typeof document === "undefined") return;
    const cell = Math.max(2, Math.round(px * 2));
    const w = Math.ceil(ctx.canvas.width / cell);
    const h = Math.ceil(ctx.canvas.height / cell);
    if (!this.canvas) this.canvas = document.createElement("canvas");
    const off = this.canvas;
    if (off.width !== w || off.height !== h) {
      off.width = w;
      off.height = h;
    }
    const g = off.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, w, h);
    g.globalCompositeOperation = "lighter";
    const at = (p: P) => ({ x: (sx + projectX(p.x, p.y) * px) / cell, y: (sy + projectY(p.x, p.y, p.z) * px) / cell });
    const halo = (x: number, y: number, radius: number, rgb: string, alpha: number) => {
      if (x < -radius || y < -radius || x > w + radius || y > h + radius || alpha <= 0.01) return;
      const grad = g.createRadialGradient(x, y, 0, x, y, radius);
      grad.addColorStop(0, `rgba(${rgb}, ${alpha})`);
      grad.addColorStop(0.3, `rgba(${rgb}, ${alpha * 0.35})`);
      grad.addColorStop(1, `rgba(${rgb}, 0)`);
      g.fillStyle = grad;
      g.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    };
    for (const s of this.sources()) {
      const breathe = 1 - (s.pulse ?? 0.25) * (0.5 + 0.5 * Math.sin(time * 1.7 + s.phase * 6.3));
      const out = hash(Math.floor(time * 11) + s.phase * 997) < (s.flicker ?? 0) ? 0.25 : 1;
      const alpha = GLOW_ALPHA * s.strength * breathe * out * (s.always ? Math.max(this.level, this.landingLevel) : this.level);
      const radius = (GLOW_SIZE * s.r * px) / cell;
      if (!s.b) {
        const p = at(s.a);
        halo(p.x, p.y, radius, s.rgb, alpha);
        continue;
      }
      // A tube: halos along it, close enough to merge into one band of light.
      const a = at(s.a);
      const b = at(s.b);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.max(1, Math.ceil(len / Math.max(1, radius * 0.6)));
      for (let i = 0; i <= steps; i++) halo(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps, radius, s.rgb, alpha * 0.55);
    }
    // Motes: single glow pixels rising and winking.
    g.globalCompositeOperation = "source-over";
    for (const m of this.motes) {
      const level = m.always ? Math.max(this.level, this.landingLevel) : this.level;
      if (level <= 0.01) continue;
      const span = m.top - Math.min(m.z0, m.top - 1);
      const z = m.top - span + ((m.z0 + time * m.speed) % span);
      const p = at({ x: m.x + Math.sin(time * 0.6 + m.phase) * 3, y: m.y, z });
      const wink = 0.5 + 0.5 * Math.sin(time * 3 + m.phase * 5);
      g.fillStyle = `rgba(${m.rgb}, ${(0.35 + 0.5 * wink) * level})`;
      g.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
    }
    // Steam: pale wisps rising off the cups, swaying, fading as they go.
    for (const [i, cup] of this.steam().entries()) {
      for (let k = 0; k < 4; k++) {
        const t = (time * 0.45 + k / 4 + i * 0.31) % 1;
        const p = at({ x: cup.x + Math.sin(time * 2 + k * 1.7 + i) * 0.8, y: cup.y, z: cup.z + t * 9 });
        g.fillStyle = `rgba(220, 225, 255, ${(1 - t) * 0.55 * this.level})`;
        g.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
      }
    }
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 1;
    ctx.drawImage(off, 0, 0, w * cell, h * cell);
    ctx.restore();
  }
}
