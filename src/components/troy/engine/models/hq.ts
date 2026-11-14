import { solid } from "../materials";
import { R } from "../palette";
import { hash2, type HitInfo, Model, mul, rotX, rotY, type ShadeOut, translate } from "../tracer";
import { ENTRANCE, LOFT, ROOM, STAIRS, STATIONS, STREET_LANE } from "../../scenes/layout";

// The underground HQ's shell: the basement's floor and its two back walls (the front walls and the
// ceiling are cut away, like a dollhouse), the stairs down from the street, and the slice of the
// street above them. World coordinates, so the room bakes as one ground layer behind everything.

const frac = (v: number) => v - Math.floor(v);

/**
 * Lamps on the walls (world points), for the warm pools they throw on the floor here and for the
 * glow drawn over the scene (engine/glow.ts).
 */
export function wallLamps() {
  const { x0, y0, y1, x1 } = ROOM;
  const left = [
    { x: x0 + 1.6, y: y0 + (y1 - y0) * 0.3, z: 80 },
    ...[0.66, 0.9].map((k) => ({ x: x0 + 1.6, y: y0 + (y1 - y0) * k, z: 44 })),
  ];
  const right = [0.62, 0.9].map((k) => ({ x: x0 + (x1 - x0) * k, y: y0 + 1.6, z: 44 }));
  return [...left, ...right];
}

/** Where the floor's rugs lie: under the strategy corner, the approval lounge and the command table. */
function rugAt(x: number, y: number): { ramp: number; border: boolean } | null {
  const strategy = STATIONS.find((s) => s.id === "tent")!;
  const approval = STATIONS.find((s) => s.id === "theatre")!;
  const c = { x: (ROOM.x0 + ROOM.x1) / 2, y: (ROOM.y0 + ROOM.y1) / 2 };
  const hub = Math.hypot(x - c.x, y - c.y);
  if (hub < 26) return { ramp: R.neonCyan, border: hub > 24.4 };
  const box = (cx: number, cy: number, hx: number, hy: number) => Math.abs(x - cx) < hx && Math.abs(y - cy) < hy;
  const edge = (cx: number, cy: number, hx: number, hy: number) => !box(cx, cy, hx - 1.4, hy - 1.4);
  if (box(strategy.x + 2, strategy.y + 4, 22, 18)) return { ramp: R.neonPink, border: edge(strategy.x + 2, strategy.y + 4, 22, 18) };
  if (box(approval.x + 2, approval.y + 2, 26, 26)) return { ramp: R.amber, border: edge(approval.x + 2, approval.y + 2, 26, 26) };
  return null;
}

/** Dark floor tiles with thin grout lines, rugs, cables to the command table and warm lamp light. */
function floorTiles(h: HitInfo, out: ShadeOut) {
  out.ramp = R.hqFloor;
  out.dither = 0;
  if (h.nz < 0.5) {
    // The cut edge of the slab: concrete with a dark seam and a neon kerb light along the top.
    out.ramp = R.hqWallViolet;
    out.tone = h.z > -3 ? -0.2 : -1.4;
    if (h.z > -1.2) {
      out.ramp = h.ny > 0.5 ? R.neonPink : R.neonCyan;
      out.tone = -0.4;
      out.glow = 1;
    }
    return;
  }
  const rug = rugAt(h.x, h.y);
  if (rug) {
    out.ramp = rug.border ? rug.ramp : R.hqPurple;
    out.tone = rug.border ? -0.6 : frac((h.x + h.y) / 4) < 0.5 ? -0.3 : -0.8;
    out.glow = rug.border ? 0.6 : 0;
    return;
  }
  // Cables from every station to the command table.
  const c = { x: (ROOM.x0 + ROOM.x1) / 2, y: (ROOM.y0 + ROOM.y1) / 2 };
  for (const st of STATIONS) {
    const dx = st.x - c.x;
    const dy = st.y - c.y;
    const len = Math.hypot(dx, dy) || 1;
    const t = ((h.x - c.x) * dx + (h.y - c.y) * dy) / (len * len);
    if (t < 0.3 || t > 0.8) continue;
    const off = Math.abs(((h.x - c.x) * dy - (h.y - c.y) * dx) / len - 3 * Math.sin(t * 12));
    if (off < 0.55) {
      out.ramp = R.black;
      out.tone = 0.6;
      if (frac(t * 9) < 0.08) {
        out.ramp = R.neonCyan;
        out.tone = 0;
        out.glow = 1;
      }
      return;
    }
  }
  const size = 12;
  const tx = Math.floor(h.x / size);
  const ty = Math.floor(h.y / size);
  const gx = frac(h.x / size);
  const gy = frac(h.y / size);
  const grout = gx < 0.06 || gy < 0.06;
  const n = hash2(tx * 3 + 7, ty * 5 + 1);
  out.tone = grout ? -1.3 : (tx + ty) % 2 === 0 ? 0.25 : -0.15;
  if (!grout && n > 0.93) out.tone -= 0.5;
  if (!grout && n < 0.04) out.tone += 0.4;
  // Warm pools of light under the wall lamps, stepped in rings like the references.
  for (const lamp of wallLamps()) {
    if (lamp.z > LOFT.z) continue;
    const fx = lamp.x < ROOM.x0 + 3 ? lamp.x + 14 : lamp.x;
    const fy = lamp.x < ROOM.x0 + 3 ? lamp.y : lamp.y + 14;
    const d = Math.hypot((h.x - fx) / 1.3, h.y - fy);
    if (d < 16) {
      out.ramp = R.amber;
      out.tone = (d < 6 ? -2.6 : d < 11 ? -3.1 : -3.5) + (grout ? -0.4 : 0);
      return;
    }
  }
}

/** Wall panels: vertical stripes like wallpaper, a baseboard, a trim and a cap on top. */
function wallPanels(along: "x" | "y", violet: boolean) {
  return (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    out.ramp = violet ? R.hqWallViolet : R.hqWall;
    if (h.nz > 0.5) {
      out.ramp = R.hqPurple;
      out.tone = 0.2;
      return;
    }
    const inside = along === "x" ? h.ny > 0.5 : h.nx > 0.5;
    if (!inside) {
      out.tone = -1;
      return;
    }
    const t = along === "x" ? h.x : h.y;
    if (h.z < 4) {
      out.ramp = R.hqMetal;
      out.tone = h.z > 3.2 ? 0.6 : -0.2;
      return;
    }
    const stripe = Math.floor(t / 6) % 2 === 0;
    out.tone = stripe ? 0.15 : -0.25;
    // A thin trim a third of the way up.
    if (h.z > 21 && h.z < 22.4) out.tone = 0.7;
    if (h.z > ROOM.wall - 2.2) {
      out.ramp = R.hqPurple;
      out.tone = 0;
    }
  };
}

/** A neon tube: always full brightness, its own colour. */
export function neon(rampId: number, tone = 0.6) {
  return (_h: HitInfo, out: ShadeOut) => {
    out.ramp = rampId;
    out.tone = tone;
    out.glow = 1;
    out.dither = 0;
  };
}

/** Metal steps: grated tread with a bright nosing, dark risers. */
function stepMat(h: HitInfo, out: ShadeOut) {
  out.ramp = R.hqMetal;
  out.dither = 0;
  if (h.nz > 0.5) {
    out.tone = frac(h.x / 1.6) < 0.3 ? -0.4 : 0.3;
    return;
  }
  out.tone = h.nx > 0.5 ? -0.6 : -0.9;
}

/** The street: a pavement of slabs along the wall, then the road with dashed amber lane marks. */
function streetMat(h: HitInfo, out: ShadeOut) {
  out.dither = 0;
  out.ramp = R.hqAsphalt;
  if (h.nz < 0.5) {
    out.ramp = R.hqWallViolet;
    out.tone = -0.8;
    return;
  }
  const kerb = ROOM.y0 - 32;
  if (h.y > kerb) {
    out.ramp = R.hqWall;
    const slab = frac(h.x / 10) < 0.08 || frac((h.y - kerb) / 12) < 0.1;
    out.tone = slab ? -0.6 : 0.4;
    if (h.y < kerb + 1.4) out.tone = 1;
    return;
  }
  const lane = ROOM.y0 - 58;
  out.tone = hash2(Math.floor(h.x * 1.3), Math.floor(h.y * 1.3)) > 0.9 ? 0.3 : 0;
  if (Math.abs(h.y - lane) < 0.9 && frac(h.x / 18) < 0.5) {
    out.ramp = R.amber;
    out.tone = 0.2;
  }
  // Puddles catching the signs: pink, aqua and blue streaks.
  const cell = Math.floor(h.x / 34);
  const px = cell * 34 + 8 + hash2(cell, 5) * 18;
  const py = ROOM.y0 - 40 - hash2(cell, 9) * 38;
  const d = Math.hypot((h.x - px) / 6, (h.y - py) / 2.4);
  if (d < 1 && hash2(cell, 2) > 0.25) {
    const ramps = [R.neonPink, R.neonCyan, R.neonBlue];
    out.ramp = ramps[Math.floor(hash2(cell, 3) * 3)];
    out.tone = frac(h.x / 2.2) < 0.5 ? -1.4 : -2;
    out.glow = 0.7;
  }
}

function facadeMat(seed: number, sign: number) {
  return (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    out.ramp = seed % 2 ? R.hqWallViolet : R.hqWall;
    out.tone = h.nz > 0.5 ? 0.4 : h.ny > 0.5 ? 0 : -0.8;
    if (h.ny > 0.5) {
      // Windows: a grid, a few lit warm, a few cyan.
      const wx = frac(h.x / 7);
      const wz = frac(h.z / 9);
      if (wx > 0.25 && wx < 0.75 && wz > 0.3 && wz < 0.8) {
        const n = hash2(Math.floor(h.x / 7) + seed * 11, Math.floor(h.z / 9));
        if (n > 0.55) {
          out.ramp = n > 0.85 ? R.neonCyan : R.amber;
          out.tone = -0.4;
          out.glow = 0.7;
        } else out.tone = -1.2;
      }
    }
    void sign;
  };
}

/** The basement's shell, the stairs and the street. */
export function roomModel(): Model {
  const m = new Model();
  const { x0, y0, x1, y1, wall } = ROOM;
  const t = 8;
  // Floor slab: its top is the floor (z = 0); its cut edges show along the open front.
  m.box((x0 - t + x1) / 2, (y0 - t + y1) / 2, -5, (x1 - x0 + t) / 2, (y1 - y0 + t) / 2, 5, { mat: floorTiles, cast: false });
  // Back walls.
  m.box(x0 - t / 2, (y0 - t + y1) / 2, wall / 2, t / 2, (y1 - y0 + t) / 2, wall / 2, { mat: wallPanels("y", false) });
  m.box((x0 - t + x1) / 2, y0 - t / 2, wall / 2, (x1 - x0 + t) / 2, t / 2, wall / 2, { mat: wallPanels("x", true) });

  // Neon strips along the top of each wall: cyan on the left, magenta on the right.
  m.box(x0 + 0.6, (y0 + y1) / 2 + 20, wall - 6, 0.5, (y1 - y0) / 2 - 30, 0.5, { mat: neon(R.neonCyan), cast: false });
  m.box((x0 + x1) / 2 + 60, y0 + 0.6, wall - 6, (x1 - x0) / 2 - 70, 0.5, 0.5, { mat: neon(R.neonPink), cast: false });
  // Pipes along the left wall under its cap.
  for (const [dz, r] of [
    [wall - 12, 1.6],
    [wall - 16.5, 1.1],
  ] as const) {
    m.cylinder(x0 + 2.4, (y0 + y1) / 2, dz, r, (y1 - y0) / 2, { mat: (h, out) => ((out.ramp = R.hqMetal), (out.tone = h.nz > 0.3 ? 0.8 : 0.1), (out.dither = 0)), rot: rotX(Math.PI / 2) });
  }

  // Stairs down from the street along the right wall: open metal treads on two stringers, the top
  // one at the street's height, a light under every nosing.
  const run = (STAIRS.foot.x - STAIRS.top.x) / STAIRS.steps;
  const angle = Math.atan2(wall, STAIRS.foot.x - STAIRS.top.x);
  const length = Math.hypot(wall, STAIRS.foot.x - STAIRS.top.x);
  for (const side of [-1, 1]) {
    const y = STAIRS.top.y + side * (STAIRS.width / 2 - 0.7);
    m.with(mul(translate((STAIRS.top.x + STAIRS.foot.x) / 2, y, wall / 2 - 1.6), rotY(angle)), () => {
      m.box(0, 0, 0, length / 2, 0.7, 2.2, { mat: (h, out) => ((out.dither = 0), (out.ramp = R.hqMetal), (out.tone = h.ny > 0.5 ? 0.5 : 0)) });
    });
  }
  for (let i = 0; i < STAIRS.steps; i++) {
    const top = wall * (1 - i / STAIRS.steps);
    const cx = STAIRS.top.x + (i + 0.5) * run;
    m.box(cx, STAIRS.top.y, top - 0.7, run / 2 + 0.6, STAIRS.width / 2 - 1.4, 0.7, { mat: stepMat });
    m.box(cx + run / 2 + 0.5, STAIRS.top.y, top - 1.5, 0.12, STAIRS.width / 2 - 2.5, 0.12, { mat: neon(i % 2 ? R.neonCyan : R.neonBlue, 0), cast: false });
  }
  // The landing at the top on four posts, where the street comes in.
  m.box(STAIRS.top.x - 8, STAIRS.top.y, wall - 0.8, 8, STAIRS.width / 2, 0.8, { mat: stepMat });
  for (const dx of [-15, -1]) for (const dy of [-1, 1]) m.box(STAIRS.top.x - 8 + dx + 7, STAIRS.top.y + dy * (STAIRS.width / 2 - 1), wall / 2, 0.7, 0.7, wall / 2, { mat: solid(R.hqMetal, 0.2, 0) });
  // Handrail on the open side, with a cyan glow strip under it.
  const railY = STAIRS.top.y + STAIRS.width / 2 - 0.6;
  m.capsule([STAIRS.top.x, railY, wall + 9], [STAIRS.foot.x, railY, 9], 0.5, { mat: (h, out) => ((out.ramp = R.hqMetal), (out.tone = 0.8), (out.dither = 0)) });
  m.capsule([STAIRS.top.x, railY, wall + 5], [STAIRS.foot.x, railY, 5], 0.35, { mat: neon(R.neonCyan, 0.3), cast: false });
  for (let i = 0; i <= STAIRS.steps; i += 2) {
    const x = STAIRS.top.x + i * run;
    const base = wall * (1 - i / STAIRS.steps);
    m.box(x, railY, base + 4.5, 0.35, 0.35, 4.5, { mat: (h, out) => ((out.ramp = R.hqMetal), (out.tone = 0.3), (out.dither = 0)) });
  }

  wallDecor(m);

  // The street above and behind the right wall: pavement, road and the shop fronts across it.
  const sx0 = Math.min(x0 - t - 30, -70);
  const sx1 = x1 + 180;
  const sy0 = y0 - 104;
  m.box((sx0 + sx1) / 2, (sy0 + y0 - t) / 2, wall - 4, (sx1 - sx0) / 2, (y0 - t - sy0) / 2, 4, { mat: streetMat, cast: false });
  return m;
}

/** A poster on a wall: a neon-framed print, a gradient sky over a skyline (or a big dot). */
function poster(m: Model, x: number, y: number, z: number, onLeft: boolean, w: number, hgt: number, a: number, b: number, seed: number) {
  const th = 0.35;
  const frame = neon(a, -0.2);
  const art = (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    const u = (onLeft ? -h.ly : h.lx) / w;
    const v = h.lz / hgt;
    const skyline = v < -0.1 + 0.35 * hash2(Math.floor((u + 1) * 6) + seed, 1);
    if (seed % 2 && Math.hypot(u, v - 0.15) < 0.45) {
      out.ramp = b;
      out.tone = 0.2;
      out.glow = 0.7;
      return;
    }
    out.ramp = skyline ? R.hqWall : v > 0.3 ? a : b;
    out.tone = skyline ? -0.4 : -1.2 + v;
    out.glow = skyline ? 0 : 0.5;
  };
  if (onLeft) {
    m.box(x + th, y, z, th, w + 0.5, hgt + 0.5, { mat: frame, cast: false });
    m.box(x + 2 * th + 0.05, y, z, 0.05, w, hgt, { mat: art, cast: false });
  } else {
    m.box(x, y + th, z, w + 0.5, th, hgt + 0.5, { mat: frame, cast: false });
    m.box(x, y + 2 * th + 0.05, z, w, 0.05, hgt, { mat: art, cast: false });
  }
}

/** Shelves, posters, lamps, a sign, an air conditioner and cables on the two back walls. */
function wallDecor(m: Model) {
  const { x0, y0, x1, y1 } = ROOM;
  const L = x0 + 0.1;
  const Rw = y0 + 0.1;
  const metal = (tone: number) => (h: HitInfo, out: ShadeOut) => ((out.dither = 0), (out.ramp = R.hqMetal), (out.tone = tone + (h.nz > 0.5 ? 0.6 : 0)));

  // The big SURREEL sign across the left wall, in pink tubes on a dark board.
  const signY = y0 + (y1 - y0) * 0.62;
  m.box(L + 0.4, signY, 70, 0.4, 20, 5.5, { mat: solid(R.black, 0.3, 0), cast: false });
  m.box(L + 0.85, signY, 70, 0.05, 19.4, 4.8, {
    mat: (h, out) => {
      out.dither = 0;
      // Reading left to right on screen runs toward -y along this wall.
      const u = (signY + 18.45 - h.y) / 0.9;
      const v = (74.2 - h.z) / 1.2;
      const col = Math.floor(u);
      const row = Math.floor(v);
      const on = row >= 0 && row < 7 && col >= 0 && col % 6 < 5 && Math.floor(col / 6) < 7 && signPixel("SURREEL"[Math.floor(col / 6)], row, col % 6);
      out.ramp = on ? R.neonPink : R.black;
      out.tone = on ? 0.8 : 0.4;
      out.glow = on ? 1 : 0;
    },
    cast: false,
  });

  // Posters on the left wall, either side of the sign, and on the right wall past the stairs.
  poster(m, L, y0 + (y1 - y0) * 0.86, 62, true, 5, 7, R.neonPink, R.neonBlue, 1);
  poster(m, L, y0 + (y1 - y0) * 0.78, 32, true, 6, 8, R.neonCyan, R.violet, 2);
  poster(m, L, y0 + (y1 - y0) * 0.86, 22, true, 3.5, 4.5, R.amber, R.neonPink, 3);
  poster(m, x0 + (x1 - x0) * 0.74, Rw, 62, false, 6, 8, R.neonBlue, R.neonPink, 4);
  poster(m, x0 + (x1 - x0) * 0.83, Rw, 24, false, 4, 5, R.neonPink, R.neonCyan, 5);

  // A shelf of boxes, books and a glowing cube on the left wall.
  const shelfY = y0 + (y1 - y0) * 0.7;
  for (const z of [26, 34]) {
    m.box(L + 3, shelfY, z, 3, 9, 0.4, { mat: metal(0.4) });
    for (let k = 0; k < 6; k++) {
      const seed = hash2(k, z);
      const h = 2 + seed * 2.5;
      m.box(L + 2.6, shelfY - 7.5 + k * 3, z + 0.4 + h / 2, 1.8, 1.1, h / 2, { mat: k === 3 && z === 34 ? neon(R.neonCyan, 0) : solid([R.neonPink, R.hqPurple, R.neonBlue, R.cream, R.violet, R.amber][k], seed > 0.5 ? -0.6 : -0.2, 0) });
    }
  }

  // The air conditioner high on the right wall, its pipe running down to the floor.
  const acX = x0 + (x1 - x0) * 0.95;
  m.box(acX - 6, Rw + 2.6, 76, 7, 2.4, 3, { mat: (h, out) => ((out.dither = 0), (out.ramp = R.white), (out.tone = h.ny > 0.5 && h.z < 74 ? -1 : -0.4)) });
  m.box(acX - 2, Rw + 5.05, 75.4, 1.2, 0.05, 0.3, { mat: neon(R.jade, 0), cast: false });
  m.capsule([acX + 1.5, Rw + 1.2, 74], [acX + 1.5, Rw + 1.2, 2], 0.45, { mat: metal(0.6) });

  // A wall screen on the right wall with a live chart.
  const scrX = x0 + (x1 - x0) * 0.62;
  m.box(scrX, Rw + 0.6, 30, 7, 0.6, 4.5, { mat: solid(R.black, 0.5, 0) });
  m.box(scrX, Rw + 1.25, 30, 6.4, 0.05, 3.9, {
    mat: (h, out) => {
      out.dither = 0;
      out.glow = 1;
      out.ramp = R.neonCyan;
      const bar = Math.floor((h.x - scrX + 6.4) / 1.6);
      const top = 26.5 + 6 * hash2(bar, 7);
      out.tone = h.z < top && frac((h.x - scrX + 6.4) / 1.6) < 0.7 ? 0.2 : -1.8;
    },
    cast: false,
  });

  // Wall lamps: a bracket and a warm shade.
  for (const lamp of wallLamps()) {
    const left = lamp.x < x0 + 3;
    const dx = left ? 2 : 0;
    const dy = left ? 0 : 2;
    m.box(lamp.x + dx / 2, lamp.y + dy / 2, lamp.z + 1, left ? 1 : 0.4, left ? 0.4 : 1, 0.3, { mat: metal(0.6) });
    m.ellipsoid(lamp.x + dx, lamp.y + dy, lamp.z, 1.6, 1.6, 1.2, { mat: neon(R.amber, 0.6) });
  }

  loft(m);

  // Cable runs along the right wall under its cap.
  m.capsule([x0, Rw + 1.2, wall0() - 12], [x1, Rw + 1.2, wall0() - 12], 0.5, { mat: solid(R.black, 0.8, 0) });
  m.capsule([x0, Rw + 1.9, wall0() - 14], [x1, Rw + 1.9, wall0() - 14], 0.4, { mat: solid(R.neonBlue, -1.4, 0) });
}

const wall0 = () => ROOM.wall;

/**
 * The loft over the back of the room: a deck on steel posts along the left wall with a glass rail
 * lit along its edge, a ladder down at its front end, server racks, a sofa and plants up there, and
 * the analytics wall over it: a big dashboard of the campaign's numbers.
 */
function loft(m: Model) {
  const { x0, y0 } = ROOM;
  const { z, depth, y1 } = LOFT;
  const metal = (tone: number) => (h: HitInfo, out: ShadeOut) => ((out.dither = 0), (out.ramp = R.hqMetal), (out.tone = tone + (h.nz > 0.5 ? 0.6 : 0)));
  const deck = (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    out.ramp = R.hqWallViolet;
    out.tone = h.nz > 0.5 ? (frac(h.y / 6) < 0.08 ? -0.2 : 0.7) : h.nz < -0.5 ? -1 : 0.1;
  };
  const cy = (y0 + y1) / 2;
  const half = (y1 - y0) / 2;
  m.box(x0 + depth / 2, cy, z - 1.2, depth / 2, half, 1.2, { mat: deck });
  // Posts under its front edge, and a beam.
  for (let y = y0 + 14; y < y1; y += 34) m.box(x0 + depth - 1, y, (z - 2.4) / 2, 0.8, 0.8, (z - 2.4) / 2, { mat: metal(0.2) });
  m.box(x0 + depth - 0.6, cy, z - 3.4, 0.6, half, 1, { mat: metal(0.4) });
  // Glass rail along the front and the open end, its top edge a neon line.
  const glass = (_h: HitInfo, out: ShadeOut) => ((out.dither = 0), (out.ramp = R.neonCyan), (out.tone = -2.4), (out.glow = 0.25));
  m.box(x0 + depth - 0.3, cy, z + 3.5, 0.15, half, 3.5, { mat: glass, cast: false });
  m.box(x0 + depth / 2, y1 - 0.3, z + 3.5, depth / 2, 0.15, 3.5, { mat: glass, cast: false });
  m.box(x0 + depth - 0.3, cy, z + 7.1, 0.25, half, 0.15, { mat: neon(R.neonPink, 0.2), cast: false });
  m.box(x0 + depth / 2, y1 - 0.3, z + 7.1, depth / 2, 0.25, 0.15, { mat: neon(R.neonPink, 0.2), cast: false });
  m.box(x0 + depth - 0.3, cy, z - 0.1, 0.2, half, 0.1, { mat: neon(R.neonCyan, 0), cast: false });
  // A ladder down from the open end.
  for (const dx of [-3, 3]) m.box(x0 + depth - 6 + dx, y1 + 1.2, z / 2, 0.35, 0.35, z / 2, { mat: metal(0.8) });
  for (let k = 3; k < z; k += 4) m.box(x0 + depth - 6, y1 + 1.2, k, 3, 0.25, 0.2, { mat: metal(1) });
  // Up there: two server racks, a sofa, a plant and a floor lamp.
  for (const y of [y0 + 10, y0 + 18]) {
    m.box(x0 + 5, y, z + 9, 3.5, 3.5, 9, {
      mat: (h, out) => {
        out.dither = 0;
        out.ramp = R.black;
        out.tone = h.nz > 0.5 ? 1.2 : 0.6;
        if (h.nx > 0.5 && frac(h.z / 1.6) > 0.55 && frac(h.z / 1.6) < 0.7) {
          const on = hash2(Math.floor(h.z / 1.6), Math.floor(h.y)) > 0.45;
          out.ramp = on ? (hash2(Math.floor(h.z), 2) > 0.5 ? R.neonCyan : R.jade) : R.black;
          out.tone = on ? 0.3 : 0.6;
          out.glow = on ? 1 : 0;
        }
      },
    });
  }
  const sofaY = y0 + 44;
  m.box(x0 + 7, sofaY, z + 2, 4, 11, 2, { mat: solid(R.neonPink, -1.2, 0) });
  m.box(x0 + 3.5, sofaY, z + 5, 1.2, 11, 4.5, { mat: solid(R.neonPink, -1.4, 0) });
  for (const dy of [-11, 11]) m.box(x0 + 7, sofaY + dy, z + 3.4, 4, 1.2, 3.4, { mat: solid(R.neonPink, -1.5, 0) });
  m.box(x0 + 7.5, sofaY - 4, z + 4.4, 2, 2, 0.3, { mat: solid(R.cream, 0, 0) });
  m.frustum(x0 + 12, y1 - 8, z + 2, 2, 2.5, 2, { mat: solid(R.hqPurple, 0.5, 0) });
  for (let i = 0; i < 6; i++) {
    const a = i * 1.1;
    m.ellipsoid(x0 + 12 + Math.cos(a) * 2, y1 - 8 + Math.sin(a) * 2, z + 7 + (i % 3) * 1.5, 1.6, 1.6, 2.4, { mat: solid(R.jade, -0.3, 0) });
  }
  m.capsule([x0 + 4, y1 - 16, z], [x0 + 4, y1 - 16, z + 14], 0.3, { mat: metal(0.8) });
  m.ellipsoid(x0 + 4, y1 - 16, z + 14.5, 1.8, 1.8, 1.2, { mat: neon(R.amber, 0.6) });

  // The analytics wall over the loft: a dashboard of bars, a line chart and engagement dots.
  const wy = y0 + 32;
  m.box(x0 + 0.6, wy, z + 26, 0.6, 26, 11, { mat: solid(R.black, 0.4, 0), cast: false });
  m.box(x0 + 1.25, wy, z + 26, 0.05, 25, 10, {
    mat: (h, out) => {
      out.dither = 0;
      out.glow = 1;
      out.ramp = R.neonBlue;
      out.tone = -2.2;
      const u = (wy + 25 - h.y) / 50;
      const v = (h.z - (z + 16)) / 20;
      if (u < 0.45) {
        // Bars for each platform's views.
        const bar = Math.floor(u * 14);
        const top = 0.25 + 0.6 * hash2(bar, 4);
        if (frac(u * 14) < 0.65 && v < top && v > 0.08) {
          out.ramp = [R.neonPink, R.neonCyan, R.neonBlue][bar % 3];
          out.tone = 0.2;
        }
      } else {
        // A rising line, and dots of engagement under it.
        const line = 0.2 + (u - 0.45) * 1.1 + Math.sin(u * 30) * 0.05;
        if (Math.abs(v - line) < 0.035) {
          out.ramp = R.neonPink;
          out.tone = 0.8;
        } else if (v < line && hash2(Math.floor(u * 60), Math.floor(v * 30)) > 0.93) {
          out.ramp = R.neonCyan;
          out.tone = 0.4;
        }
      }
      if (v > 0.88) {
        out.ramp = R.neonCyan;
        out.tone = frac(u * 9) < 0.5 ? -0.4 : -1.6;
      }
    },
    cast: false,
  });
}

const SIGN_GLYPHS: Record<string, string[]> = {
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  N: ["10001", "11001", "10101", "10101", "10011", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
};

function signPixel(letter: string, row: number, col: number) {
  return SIGN_GLYPHS[letter]?.[row]?.[col] === "1";
}

/** The screen (art px) rectangle the room covers, for the camera. */
export const ROOM_SPAN = { w: 2 * (ROOM.x1 - ROOM.x0) + 120, h: (ROOM.x1 - ROOM.x0) + 180 };

// ----------------------------------------------------------------------------------------------
// Motorbikes: the scouts ride them up to the street; the courier zips round the basement on one.

/** Each bike's neon (by the stall's coat index), on a dark frame. */
const BIKE_NEON = [R.neonCyan, R.neonPink, R.amber, R.jade, R.violet];

function tyre(spin: number) {
  return (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    const r = Math.hypot(h.lx, h.ly);
    if (r < 1.2) {
      // The hub: a bright disc with spokes that turn as the wheel rolls.
      const a = Math.atan2(h.ly, h.lx) + spin;
      out.ramp = R.hqMetal;
      out.tone = frac((a / (Math.PI * 2)) * 5) < 0.3 ? 1.6 : 0.6;
      return;
    }
    out.ramp = R.black;
    out.tone = r > 2.2 ? 0.2 : 0.8;
  };
}

/** A sleek motorbike along +x, seat at about z 7. `f` is the wheel frame 0..5, or -1 parked. */
export function motorbike(m: Model, f: number, coatIndex = 0) {
  const glow = BIKE_NEON[coatIndex % BIKE_NEON.length];
  const spin = f < 0 ? 0 : (f / 6) * Math.PI * 2;
  const body = (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    out.ramp = R.black;
    out.tone = h.nz > 0.5 ? 1.4 : 0.7;
  };
  for (const x of [-5.2, 5.4]) m.cylinder(x, 0, 2.7, 2.7, 0.75, { mat: tyre(spin), rot: rotX(Math.PI / 2) });
  // Frame, tank and tail.
  m.box(0, 0, 5.2, 4.6, 0.9, 1.3, { mat: body });
  m.ellipsoid(2.2, 0, 7.0, 2.6, 1.5, 1.4, { mat: body });
  m.box(-3.8, 0, 6.9, 2.4, 0.9, 0.7, { mat: body, rot: [Math.cos(0.25), 0, Math.sin(0.25), 0, 0, 1, 0, 0, -Math.sin(0.25), 0, Math.cos(0.25), 0] });
  // Seat.
  m.box(-1.6, 0, 7.4, 2.2, 1.1, 0.45, { mat: solid(R.hqWall, 0.4, 0) });
  // Forks, bars and the headlight.
  m.capsule([4.2, 0, 7.6], [5.4, 0, 2.7], 0.35, { mat: solid(R.hqMetal, 1.4, 0) });
  m.capsule([4.0, -2, 9.4], [4.0, 2, 9.4], 0.3, { mat: solid(R.hqMetal, 1.2, 0) });
  m.capsule([4.0, 0, 7.8], [4.0, 0, 9.4], 0.35, { mat: solid(R.hqMetal, 1.2, 0) });
  m.box(5.0, 0, 8.0, 0.5, 0.8, 0.5, { mat: (_h, out) => ((out.dither = 0), (out.ramp = R.white), (out.tone = 2), (out.glow = 1)) });
  m.box(-6.0, 0, 7.5, 0.3, 0.6, 0.3, { mat: (_h, out) => ((out.dither = 0), (out.ramp = R.neonPink), (out.tone = 0.8), (out.glow = 1)) });
  // Neon along the frame and under it.
  m.box(0.4, 0, 3.6, 4.0, 0.3, 0.2, { mat: neon(glow, 0.6), cast: false });
  m.box(1.8, 0.95, 6.6, 1.4, 0.08, 0.25, { mat: neon(glow, 0.4), cast: false });
  m.box(1.8, -0.95, 6.6, 1.4, 0.08, 0.25, { mat: neon(glow, 0.4), cast: false });
}

/** The bike bay: a charging rail along y with a glowing socket for every bike. */
export function chargingRail(m: Model) {
  const half = 24;
  for (const y of [-half, half]) m.box(0, y, 4, 0.8, 0.8, 4, { mat: solid(R.hqMetal, 0.6, 0) });
  m.box(0, 0, 7.4, 0.5, half + 0.6, 0.5, { mat: solid(R.hqMetal, 1, 0) });
  for (let y = -half + 3; y <= half - 3; y += 6) m.box(0.6, y, 5.6, 0.2, 0.6, 0.6, { mat: neon(R.neonCyan, 0.4), cast: false });
  // A thin amber line on the floor marks the bay.
  const line = neon(R.amber, -1.2);
  m.box(-7, -half - 2, 0.04, 9, 0.25, 0.04, { mat: line, cast: false });
  m.box(-7, half + 2, 0.04, 9, 0.25, 0.04, { mat: line, cast: false });
  m.box(-16, 0, 0.04, 0.25, half + 2, 0.04, { mat: line, cast: false });
}

// ----------------------------------------------------------------------------------------------
// The HQ's street door (the landing): a narrow building with SURREEL in neon over a roll-up
// shutter. The shutter rolls up as the opening plays, light spills out across the pavement and
// the agents come out. Its pieces are separate sprites, like the horse's body, doors and plank.

/** A 5 x 7 pixel font, just the letters of the sign. */
const GLYPHS: Record<string, string[]> = {
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  N: ["10001", "11001", "10101", "10101", "10011", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
};

/** Lit pixels of a word set in GLYPHS, `u` across and `v` down in glyph pixels. */
function wordPixel(word: string, u: number, v: number) {
  const col = Math.floor(u);
  const row = Math.floor(v);
  if (row < 0 || row > 6 || col < 0) return false;
  const letter = Math.floor(col / 6);
  const x = col % 6;
  if (letter >= word.length || x > 4) return false;
  return GLYPHS[word[letter]]?.[row]?.[x] === "1";
}

const E = ENTRANCE;
const Z = ROOM.wall;
const FRONT = E.y + E.depth;

function entranceWall(h: HitInfo, out: ShadeOut) {
  out.dither = 0;
  out.ramp = R.hqWallViolet;
  out.tone = h.nz > 0.5 ? 0.8 : h.ny > 0.5 ? 0.3 : -0.5;
  if (h.inner) {
    // Inside the doorway: warm light from within.
    out.ramp = R.amber;
    out.tone = h.ny > 0.5 ? -0.8 : 0;
    out.glow = 0.8;
    return;
  }
  if (h.ny > 0.5) {
    // Windows up the front, a few lit.
    const wx = frac((h.x + E.half) / 6);
    const wz = frac((h.z - Z - 22) / 7);
    if (h.z > Z + 22 && h.z < Z + E.tall - 4 && Math.abs(h.x) > 8 && wx > 0.2 && wx < 0.8 && wz > 0.2 && wz < 0.75) {
      const n = hash2(Math.floor((h.x + E.half) / 6), Math.floor((h.z - Z) / 7));
      out.ramp = n > 0.55 ? R.neonCyan : R.black;
      out.tone = n > 0.55 ? -0.4 : 0.8;
      out.glow = n > 0.55 ? 0.8 : 0;
    }
    // Vertical neon strips at the corners.
    if (Math.abs(Math.abs(h.x) - E.half + 0.8) < 0.5) {
      out.ramp = R.neonPink;
      out.tone = 0.4;
      out.glow = 1;
    }
  }
}

/** The HQ's front building, with the doorway carved out and lit inside. */
export function entranceBody() {
  const m = new Model();
  const door = m.hole(0, FRONT, Z + E.doorTall / 2, E.door, 3, E.doorTall / 2);
  m.box(E.x, E.y, Z + E.tall / 2, E.half, E.depth, E.tall / 2, { mat: entranceWall, carve: door });
  // Roof gear: a water tank and an aerial.
  m.cylinder(-9, E.y - 2, Z + E.tall + 4, 3, 4, { mat: solid(R.hqMetal, 0.4, 0) });
  m.capsule([10, E.y, Z + E.tall], [10, E.y, Z + E.tall + 14], 0.25, { mat: solid(R.hqMetal, 1, 0) });
  m.sphere(10, E.y, Z + E.tall + 14.4, 0.6, { mat: neon(R.neonPink, 1) });
  // The sign: SURREEL in pink over HQ in cyan, on a dark board above the door.
  m.box(0, FRONT + 0.6, Z + 38, 17.6, 0.5, 5, { mat: solid(R.black, 0.4, 0) });
  m.box(0, FRONT + 1.15, Z + 38, 16.8, 0.05, 4.6, {
    mat: (h, out) => {
      out.dither = 0;
      const u = (h.x + 16.4) / 0.8;
      const v = (Z + 40.8 - h.z) / 0.8;
      if (wordPixel("SURREEL", u, v)) {
        out.ramp = R.neonPink;
        out.tone = 0.8;
        out.glow = 1;
      } else {
        out.ramp = R.black;
        out.tone = 0.6;
      }
    },
    cast: false,
  });
  m.box(0, FRONT + 0.6, Z + 27, 7, 0.4, 4.4, { mat: solid(R.black, 0.4, 0) });
  m.box(0, FRONT + 1.05, Z + 27, 6.6, 0.05, 4, {
    mat: (h, out) => {
      out.dither = 0;
      const on = wordPixel("HQ", h.x + 5.5, Z + 30.5 - h.z);
      out.ramp = on ? R.neonCyan : R.black;
      out.tone = on ? 0.8 : 0.6;
      out.glow = on ? 1 : 0;
    },
    cast: false,
  });
  // An awning over the door, and a lamp on each side.
  m.box(0, FRONT + 2.4, Z + E.doorTall + 1.2, E.door + 3, 2.6, 0.3, { mat: solid(R.hqPurple, 0.4, 0) });
  m.box(0, FRONT + 5, Z + E.doorTall + 1, E.door + 3, 0.06, 0.25, { mat: neon(R.neonCyan, 0), cast: false });
  for (const x of [-E.door - 3, E.door + 3]) m.box(x, FRONT + 0.7, Z + 12, 0.7, 0.7, 1.2, { mat: neon(R.amber, 0.6) });
  return m;
}

/** The roll-up shutter in the doorway, `open` 0 (down) to 1 (rolled up into its box). */
export function entranceShutter(open: number) {
  const m = new Model();
  const height = E.doorTall * (1 - open);
  if (height > 0.3) {
    m.box(0, FRONT - 0.4, Z + E.doorTall - height / 2, E.door - 0.1, 0.4, height / 2, {
      mat: (h, out) => {
        out.dither = 0;
        out.ramp = R.hqMetal;
        out.tone = frac((h.z - Z) / 1.4) < 0.25 ? -0.2 : 0.9;
        if (Math.abs(h.z - (Z + E.doorTall - height + 1)) < 0.35) {
          out.ramp = R.amber;
          out.tone = 0.4;
          out.glow = 1;
        }
      },
    });
  }
  m.box(0, FRONT + 0.4, Z + E.doorTall + 0.2, E.door + 0.6, 1, 0.9, { mat: solid(R.hqMetal, 0.5, 0) });
  return m;
}

/** Light spilling out of the open door across the pavement: `extend` 0..1 of the way to the road. */
export function entranceLight(extend: number) {
  const m = new Model();
  const reach = Math.max(0.5, (STREET_LANE - FRONT) * extend);
  m.box(0, FRONT + reach / 2, Z + 0.06, E.door - 1, reach / 2, 0.06, {
    mat: (h, out) => {
      out.dither = 0;
      out.ramp = R.amber;
      const d = (h.y - FRONT) / Math.max(1, STREET_LANE - FRONT);
      out.tone = -0.6 - d * 1.6 + (frac(h.y / 3) < 0.15 ? 0.6 : 0);
      out.glow = 1;
    },
    cast: false,
  });
  // Two chevrons pointing the way.
  for (let i = 0; i < 2; i++) {
    const y = FRONT + reach * (0.45 + i * 0.3);
    if (y < FRONT + reach - 1) m.box(0, y, Z + 0.14, 2.2, 0.5, 0.05, { mat: neon(R.neonCyan, 0.2), cast: false });
  }
  return m;
}

/** The slice of street the HQ's door stands on (the landing's ground): pavement and the road. */
export function entranceGround() {
  const m = new Model();
  const y0 = E.y - E.depth - 6;
  const y1 = STREET_LANE + 22;
  m.box(0, (y0 + y1) / 2, Z - 4, 48, (y1 - y0) / 2, 4, {
    mat: (h, out) => {
      out.dither = 0;
      if (h.nz < 0.5) {
        out.ramp = R.hqWallViolet;
        out.tone = -0.6;
        return;
      }
      const kerb = STREET_LANE - 14;
      if (h.y < kerb) {
        out.ramp = R.hqWall;
        out.tone = frac(h.x / 10) < 0.08 || frac(h.y / 12) < 0.1 ? -0.6 : 0.4;
        return;
      }
      out.ramp = R.hqAsphalt;
      out.tone = hash2(Math.floor(h.x * 1.3), Math.floor(h.y * 1.3)) > 0.9 ? 0.3 : 0;
      if (Math.abs(h.y - STREET_LANE) < 0.9 && frac(h.x / 18) < 0.5) {
        out.ramp = R.amber;
        out.tone = 0.2;
      }
      // Puddles catching the sign and the street's lights.
      for (const [px, py, rx, ramp] of [
        [18, STREET_LANE + 9, 7, R.neonPink],
        [-22, STREET_LANE - 6, 5, R.neonCyan],
        [30, STREET_LANE - 14, 4, R.neonBlue],
      ] as const) {
        if (Math.hypot((h.x - px) / rx, (h.y - py) / (rx * 0.42)) < 1) {
          out.ramp = ramp;
          out.tone = frac(h.x / 2.2) < 0.5 ? -1.2 : -1.8;
          out.glow = 0.6;
        }
      }
    },
    cast: false,
  });
  return m;
}
