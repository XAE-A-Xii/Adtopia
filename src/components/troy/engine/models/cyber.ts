import { solid } from "../materials";
import { R } from "../palette";
import { hash2, type HitInfo, Model, mul, rotX, rotY, rotZ, type ShadeOut, translate } from "../tracer";
import { neon } from "./hq";

// The HQ's furniture. Each piece stands in for one of the camp's props and keeps its footprint
// and heights (the lookout's platform, the archive's floor, the podium's top, the seats), so the
// agents' posts and the ladders and steps up to them still line up. Built around the prop's own
// origin on the floor (z = 0), in world units (an agent is about 20 tall).

const frac = (v: number) => v - Math.floor(v);

/** Dark brushed metal: tops brighter, sides darker. */
function metal(tone = 0.6) {
  return (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    out.ramp = R.hqMetal;
    out.tone = tone + (h.nz > 0.5 ? 0.6 : 0);
  };
}

/** Matte dark plastic or lacquer in a ramp. */
const matte = (rampId: number, tone = 0.4) => solid(rampId, tone, 0);

/** Light pouring from a lamp: warm amber, full glow. */
const lamp = neon(R.amber, 0.8);

/**
 * A screen face. `state`: 0 off, 1 working (cyan), 2 done (green), 3 failed (magenta-red).
 * `phase` scrolls lines of "text" so animation frames differ; `kind` picks charts or text.
 */
export function cyberScreen(state: number, phase: number, kind: "text" | "chart" | "feed" = "text") {
  return (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    if (state <= 0) {
      out.ramp = R.black;
      out.tone = 0.9;
      return;
    }
    out.ramp = state === 2 ? R.jade : state === 3 ? R.magenta : R.neonCyan;
    out.glow = 1;
    const u = h.ly;
    const v = h.lz;
    let tone = -0.8;
    if (kind === "chart") {
      // Bars rising across the screen.
      const bar = Math.floor((u + 3) * 1.6);
      const height = 0.4 + frac(hash2(bar, Math.floor(phase * 4)) + phase) * 1.6;
      if (frac((u + 3) * 1.6) < 0.7 && v + 1.2 < height) tone = 0.8;
    } else if (kind === "feed") {
      // Tiles of a social feed scrolling up.
      if (frac(u * 0.7) < 0.85 && frac(v * 0.6 + phase) < 0.8) tone = hash2(Math.floor(u * 0.7), Math.floor(v * 0.6 + phase)) > 0.5 ? 0.6 : -0.2;
    } else if (frac(v * 1.3 + phase) < 0.45 && frac(u * 0.5 + hash2(Math.floor(v * 1.3 + phase), 1)) < 0.75) tone = 0.4;
    out.tone = tone;
  };
}

// ----------------------------------------------------------------------------------------------
// Intelligence desk (scouts)

/** The lookout's mast: a lattice tower to a railed platform at z 24.4, dish and antenna on top. */
export function antennaMast(m: Model) {
  for (const x of [-5, 5]) for (const y of [-5, 5]) m.box(x, y, 12, 0.6, 0.6, 12, { mat: metal(0.4) });
  for (const z of [6, 12, 18]) {
    m.box(0, -5, z, 5, 0.3, 0.3, { mat: metal(0.2) });
    m.box(5, 0, z, 0.3, 5, 0.3, { mat: metal(0.2) });
  }
  // Ladder rungs on the +y face, where the lookout climbs.
  for (let z = 2; z < 24; z += 2.2) m.box(0, 5.4, z, 1.6, 0.15, 0.15, { mat: metal(1) });
  m.box(0, 0, 24.4, 7.2, 7.2, 0.6, { mat: metal(0.8) });
  for (const [x, y, hx, hy] of [
    [0, 7, 7.2, 0.25],
    [7, 0, 0.25, 7.2],
    [0, -7, 7.2, 0.25],
    [-7, 0, 0.25, 7.2],
  ] as const) {
    m.box(x, y, 27.6, hx, hy, 0.25, { mat: metal(0.9) });
    m.box(x, y, 26.2, hx, hy, 0.12, { mat: neon(R.neonCyan, 0.2), cast: false });
  }
  for (const x of [-7, 7]) for (const y of [-7, 7]) m.box(x, y, 26.4, 0.35, 0.35, 2, { mat: metal(0.6) });
  // A dish on a short mast and a whip antenna with a blinking tip.
  m.with(mul(translate(-4, -4, 30), rotY(-0.7)), () => {
    m.ellipsoid(0, 0, 0, 3.4, 3.4, 1.1, { mat: matte(R.white, 0.4), clip: [0, 0, -1, 0.2] });
    m.capsule([0, 0, 0], [0, 0, 2.4], 0.2, { mat: metal(1) });
  });
  m.capsule([-4, -4, 25], [-4, -4, 29], 0.4, { mat: metal(0.6) });
  m.capsule([5, -5, 25], [5, -5, 36], 0.18, { mat: metal(1) });
  m.sphere(5, -5, 36.4, 0.55, { mat: neon(R.neonPink, 1) });
}

/** The scouts' drop bin: a crate where data cubes pile up as research comes in (`fill` 0..1). */
export function dataBin(m: Model, fill: number) {
  m.box(0, 0, 2.2, 3.8, 3.8, 2.2, { mat: metal(0.3) });
  m.box(0, 0, 4.5, 4, 4, 0.2, { mat: neon(R.neonCyan, -0.2), cast: false });
  const count = Math.round(fill * 7);
  for (let i = 0; i < count; i++) {
    const col = i % 4;
    const layer = Math.floor(i / 4);
    m.box(-1.5 + (col % 2) * 3, -1.5 + Math.floor(col / 2) * 3, 5.5 + layer * 2.2, 1.1, 1.1, 1.1, { mat: neon(i % 3 === 1 ? R.neonPink : R.neonCyan, 0.4) });
  }
}

/** A neon arrow sign on a pole (the old signpost). */
export function neonSign(m: Model) {
  m.capsule([0, 0, 0], [0, 0, 12], 0.35, { mat: metal(0.6) });
  m.box(0.3, 2.2, 10.5, 0.3, 3.2, 1.2, { mat: matte(R.black, 0.6) });
  m.box(0.65, 2.2, 10.5, 0.05, 2.6, 0.5, { mat: neon(R.neonPink, 0.6), cast: false });
  m.box(0.3, -1.6, 8, 0.3, 2.6, 1, { mat: matte(R.black, 0.6) });
  m.box(0.65, -1.6, 8, 0.05, 2, 0.4, { mat: neon(R.neonCyan, 0.6), cast: false });
}

// ----------------------------------------------------------------------------------------------
// Reference archive (oracle)

/**
 * A raised archive platform (floor at z 2.8, two steps like the shrine it replaces), server racks
 * at its corners, a wall of monitors along its back and a neon sign on the canopy.
 */
export function archive(m: Model, frame = 0) {
  const deck = (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    out.ramp = R.hqMetal;
    out.tone = h.nz > 0.5 ? (frac(h.x / 2) < 0.15 || frac(h.y / 2) < 0.15 ? 0.2 : 0.9) : 0;
  };
  m.box(0, 0, 0.8, 12.5, 10.5, 0.8, { mat: deck });
  m.box(0, 0, 2.2, 11, 9, 0.6, { mat: deck });
  m.box(0, 10.6, 1.65, 12.5, 0.1, 0.12, { mat: neon(R.neonCyan, 0.2), cast: false });
  m.box(12.6, 0, 1.65, 0.1, 10.5, 0.12, { mat: neon(R.neonCyan, 0.2), cast: false });
  for (const x of [-9, 9]) {
    for (const y of [-7, 7]) {
      m.box(x, y, 9.8, 1.6, 1.6, 7, { mat: rackMat(frame) });
    }
  }
  // Back wall of monitors between the far racks, three rows.
  for (let row = 0; row < 3; row++) {
    for (let k = 0; k < 4; k++) {
      const y = -5.4 + k * 3.6;
      m.box(-10, y, 6.2 + row * 3.6, 0.9, 1.65, 1.6, { mat: matte(R.black, 0.8) });
      m.box(-9.05, y, 6.2 + row * 3.6, 0.06, 1.35, 1.3, { mat: cyberScreen(1, (row * 4 + k) * 0.37 + frame * 0.25, k % 2 ? "feed" : "chart") });
    }
  }
  // Canopy of cable trays with the sign.
  m.box(0, 0, 18.2, 10.8, 8.8, 0.5, { mat: metal(0.3) });
  m.box(0, 9.2, 19.6, 6, 0.3, 1.2, { mat: matte(R.black, 0.4) });
  m.box(0, 9.55, 19.6, 5.2, 0.06, 0.5, { mat: neon(R.neonPink, 0.6), cast: false });
}

/** A server rack: dark, its slots lit in cyan and green; `frame` changes which ones blink on. */
const rackMat = (frame: number) => (h: HitInfo, out: ShadeOut) => rackLights(h, out, frame);

function rackLights(h: HitInfo, out: ShadeOut, frame: number) {
  out.dither = 0;
  out.ramp = R.black;
  out.tone = h.nz > 0.5 ? 1.4 : 0.8;
  if (h.nz < 0.5 && frac(h.z / 1.4) < 0.18) out.tone = 0.2;
  if (h.nz < 0.5 && frac(h.z / 1.4) > 0.5 && frac(h.z / 1.4) < 0.62 && hash2(Math.floor(h.z / 1.4) + frame * 13, Math.floor(h.x + h.y)) > 0.4) {
    out.ramp = hash2(Math.floor(h.z), 3) > 0.5 ? R.neonCyan : R.jade;
    out.tone = 0.4;
    out.glow = 1;
  }
}

/** The monitor on a stand the oracle watches; v = 0 off, else frames of the video it studies. */
export function monitorStand(m: Model, on: number, phase: number) {
  m.capsule([0, 0, 0.2], [0, 0, 8.4], 0.35, { mat: metal(0.8) });
  m.box(0, 0, 0.3, 2.2, 2.2, 0.3, { mat: metal(0.6) });
  m.box(0, 0, 10, 0.8, 3.4, 2.2, { mat: matte(R.black, 0.7) });
  // The screen faces +x (the camera side), where the oracle stands.
  m.box(0.85, 0, 10, 0.06, 3.1, 1.9, { mat: cyberScreen(on ? 1 : 0, phase, "feed") });
}

// ----------------------------------------------------------------------------------------------
// Strategy table and writers' corner (war tent)

/**
 * The planning corner (in place of the war tent): an L of pin-boards at the back, covered in
 * sticky notes and storyboards, a neon strip along their top, and the writers' desk with a lamp.
 */
export function planningCorner(m: Model) {
  const board = (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    out.ramp = R.hqWallViolet;
    out.tone = 0.6;
    const facing = h.nx > 0.5 || h.ny > 0.5;
    if (!facing) return;
    const u = h.nx > 0.5 ? h.y : h.x;
    const cu = Math.floor(u / 3.2);
    const cz = Math.floor(h.z / 3.2);
    const n = hash2(cu * 7 + 3, cz * 13 + 1);
    if (h.z > 3 && h.z < 16 && frac(u / 3.2) > 0.18 && frac(h.z / 3.2) > 0.2 && n > 0.35) {
      out.ramp = n > 0.85 ? R.neonPink : n > 0.7 ? R.amber : n > 0.55 ? R.neonCyan : R.cream;
      out.tone = n > 0.55 ? -0.2 : 0.2;
      out.glow = n > 0.55 ? 0.3 : 0;
    }
  };
  m.box(-11, -1, 9, 0.7, 12, 9, { mat: board });
  m.box(-1, -11, 9, 10, 0.7, 9, { mat: board });
  m.box(-10.2, -1, 18.3, 0.2, 11, 0.25, { mat: neon(R.neonPink, 0.4), cast: false });
  m.box(-1, -10.2, 18.3, 9, 0.2, 0.25, { mat: neon(R.neonCyan, 0.4), cast: false });
  // String lines between the notes, a pinned storyboard strip.
  m.box(-10.55, -1, 12.5, 0.05, 9, 0.08, { mat: matte(R.neonPink, -0.4) });
  // The writers' desk against the board, with a monitor full of script, a lamp and notebooks.
  m.box(-6.5, 4, 6.2, 3, 5, 0.4, { mat: metal(0.5) });
  for (const y of [0, 8]) m.box(-6.5, y, 3, 2.6, 0.3, 3, { mat: metal(0.2) });
  m.box(-8, 4, 9.6, 0.5, 3.2, 2.1, { mat: matte(R.black, 0.6) });
  m.box(-7.45, 4, 9.6, 0.05, 2.9, 1.8, { mat: cyberScreen(1, 0.3, "text") });
  m.capsule([-8, 7.8, 6.6], [-6, 7.8, 11], 0.2, { mat: metal(1) });
  m.ellipsoid(-5.6, 7.8, 10.8, 1.1, 1.1, 0.7, { mat: lamp });
  for (let i = 0; i < 3; i++) m.box(-5.5, 0.8 + i * 0.1, 6.8 + i * 0.35, 1.2, 1.4, 0.16, { mat: matte(i % 2 ? R.neonPink : R.cream, 0.1) });
}

/** The strategy table: a glowing map of the campaign with little holograms standing on it. */
export function holoTable(m: Model, frame = 0) {
  m.box(0, 0, 3.4, 4.6, 3, 3.4, { mat: metal(0.2) });
  m.box(0, 0, 7.1, 6.2, 4.4, 0.35, { mat: metal(0.7) });
  m.box(0, 0, 7.48, 5.6, 3.8, 0.04, {
    mat: (h, out) => {
      out.dither = 0;
      out.ramp = R.neonCyan;
      out.glow = 1;
      const grid = frac(h.x / 1.4) < 0.12 || frac(h.y / 1.4) < 0.12;
      out.tone = grid ? -0.6 : -1.6;
      if (Math.abs(h.ly - Math.sin(h.lx * 0.7) * 1.4) < 0.25) {
        out.ramp = R.neonPink;
        out.tone = 0.2;
      }
    },
    cast: false,
  });
  for (const [x, y, ramp] of [
    [-2.4, -1, R.neonPink],
    [1.5, 1.6, R.neonPink],
    [3.5, -1.8, R.neonCyan],
    [-0.6, 2.4, R.amber],
  ] as const) {
    m.frustum(x, y, 8.6, 0.55, 0.05, 1.0, { mat: neon(ramp, 0.2), cast: false });
  }
  // A hologram of a phone screen over the middle: the video being planned.
  // It bobs and turns as the frames go round.
  const bob = [0, 0.4, 0.6, 0.4][frame % 4];
  m.with(mul(translate(0.6, 0, 11.6 + bob), rotZ((frame % 4) * 0.35)), () => {
    m.box(0, 0, 0, 0.05, 1.3, 2.3, { mat: neon(R.neonCyan, -0.6), cast: false });
    m.box(0.06, 0, 0.6 - (frame % 4) * 0.4, 0.05, 1.1, 0.2, { mat: neon(R.neonPink, 0.4), cast: false });
  });
}

// ----------------------------------------------------------------------------------------------
// Production studio (workshop)

/**
 * An editing desk facing the camera (+x+y), on the same footprint as the old one: two monitors at
 * the back, a keyboard lit from under, and a chair where the editor sits. `state`/`phase` drive the
 * main screen (0 idle, 1 rendering, 2 done, 3 failed).
 */
export function editStation(m: Model, state: number, phase: number) {
  m.with(rotZ(Math.PI / 4), () => {
    m.box(0, 0, 7.6, 3.4, 5.4, 0.4, { mat: metal(0.6) });
    for (const y of [-4.9, 4.9]) m.box(0, y, 3.6, 3, 0.35, 3.6, { mat: metal(0.1) });
    m.box(3.3, 0, 7.6, 0.1, 5.2, 0.12, { mat: neon(state === 3 ? R.magenta : R.neonCyan, -0.2), cast: false });
    // Main monitor, a smaller one beside it turned in.
    m.capsule([-2, 0, 8], [-2, 0, 9.6], 0.3, { mat: metal(0.8) });
    m.box(-2, 0, 11.8, 0.4, 3.2, 2.2, { mat: matte(R.black, 0.5) });
    m.box(-1.55, 0, 11.8, 0.05, 2.9, 1.95, { mat: cyberScreen(state, phase, state === 1 ? "chart" : "text") });
    m.with(mul(translate(-1.4, -4, 11), rotZ(0.6)), () => {
      m.box(0, 0, 0, 0.35, 1.6, 1.3, { mat: matte(R.black, 0.5) });
      m.box(0.38, 0, 0, 0.05, 1.4, 1.1, { mat: cyberScreen(state ? 1 : 0, phase + 0.5, "feed") });
    });
    m.box(1.8, -0.3, 8.1, 0.9, 2.1, 0.15, { mat: (h, out) => ((out.dither = 0), (out.ramp = R.black), (out.tone = h.nz > 0.5 && frac(h.ly * 1.6) < 0.3 ? 0.2 : 1)) });
    m.box(1.8, -0.3, 7.98, 1, 2.2, 0.04, { mat: neon(R.neonPink, -0.6), cast: false });
    m.cylinder(1.4, 3.8, 8.5, 0.5, 0.5, { mat: matte(R.amber, 0.2) });
    // The chair: a seat on a gas lift, a back behind the editor.
    m.capsule([7, 0, 0.4], [7, 0, 2], 0.3, { mat: metal(0.8) });
    m.box(7, 0, 0.3, 1.8, 1.8, 0.2, { mat: metal(0.2) });
    m.cylinder(7, 0, 2.2, 1.7, 0.3, { mat: matte(R.hqPurple, 0.5) });
    m.box(8.9, 0, 5.2, 0.3, 1.7, 2.6, { mat: matte(R.hqPurple, 0.3) });
  });
}

/**
 * The shoot corner (in place of the easel): a small green screen with a camera on a tripod and a
 * monitor facing +x showing the first frame as it is made (`painted` 0..1).
 */
export function shootRig(m: Model, painted: number) {
  // The monitor where the frame comes in, facing the painter at +x.
  m.capsule([0, 0, 0], [0, 0, 6], 0.35, { mat: metal(0.8) });
  m.box(0, 0, 0.25, 2, 2, 0.25, { mat: metal(0.4) });
  m.box(0, 0, 8.6, 0.5, 3.6, 2.8, { mat: matte(R.black, 0.6) });
  m.box(0.55, 0, 8.6, 0.05, 3.3, 2.5, {
    mat: (h, out) => {
      out.dither = 0;
      out.glow = 1;
      // The frame fills in from the bottom: a sunset gradient behind a figure.
      const v = (h.lz + 2.5) / 5;
      if (v > painted) {
        out.ramp = R.black;
        out.tone = 0.8;
        out.glow = 0;
        return;
      }
      const figure = Math.abs(h.ly - 0.6) < 0.7 && h.lz < 0.9;
      out.ramp = figure ? R.hqWall : v > 0.55 ? R.neonPink : R.amber;
      out.tone = figure ? 0.6 : 0.2 - v;
    },
  });
  // The green screen behind, and a light on a stand.
  m.box(-6, -6, 9, 0.3, 5, 8, { mat: (h, out) => ((out.dither = 0), (out.ramp = R.jade), (out.tone = h.nx > 0.5 ? 0.6 : -0.6)) });
  for (const y of [-11, -1]) m.capsule([-6.2, y, 0], [-6.2, y, 18], 0.25, { mat: metal(0.8) });
  m.capsule([-2, 4, 0], [-2, 4, 13], 0.22, { mat: metal(0.8) });
  m.box(-2, 4, 14.2, 1.6, 1.6, 1.3, { mat: matte(R.black, 0.5), rot: rotY(0.4) });
  m.box(-1.1, 4, 13.8, 0.1, 1.4, 1.1, { mat: lamp, rot: rotY(0.4), cast: false });
}

/** Drives stacking up as videos finish (in place of film reels): `count` blocks with status lights. */
export function driveStack(m: Model, count: number) {
  for (let i = 0; i < count; i++) {
    const layer = Math.floor(i / 3);
    const k = i % 3;
    const x = (k - 1) * 3.2 + layer * 1.6;
    const z = 0.6 + layer * 1.25;
    m.box(x, 0, z, 1.4, 1.9, 0.55, { mat: metal(0.4) });
    m.box(x + 1.42, 0.8, z, 0.05, 0.25, 0.2, { mat: neon(i % 2 ? R.jade : R.neonCyan, 0.4), cast: false });
  }
}

// ----------------------------------------------------------------------------------------------
// Approval desk (theatre)

/** One curved row of the review lounge's benches (as the tiers: row 0 innermost and lowest). */
export function loungeRow(m: Model, row: number) {
  const r = 15 + row * 4.4;
  const segments = 5 + row;
  const top = 1.2 * (row + 1);
  for (let i = 0; i < segments; i++) {
    const a = ((i + 0.5) / segments) * (Math.PI / 2);
    const len = (r * (Math.PI / 2)) / segments / 2 + 0.25;
    m.with(mul(translate(Math.cos(a) * r, Math.sin(a) * r, 0), rotZ(a)), () => {
      m.box(0, 0, top / 2 - 0.3, 2.15, len, top / 2 - 0.3, { mat: metal(0) });
      m.box(0, 0, top - 0.3, 2.1, len - 0.15, 0.3, { mat: matte(i % 2 ? R.hqPurple : R.violet, 0.6) });
      if (i === 0) m.box(-2.2, 0, 0.12, 0.08, len, 0.1, { mat: neon(R.amber, -0.2), cast: false });
    });
  }
}

/** The approval screen: a big display in a dark bezel, facing +x+y, with a warm light bar above. */
export const SCREEN = { bottom: 9.5, top: 22.5, half: 11 };

export function approvalScreen(m: Model) {
  m.with(rotZ(Math.PI / 4), () => {
    for (const y of [-SCREEN.half - 0.8, SCREEN.half + 0.8]) m.box(0, y, 12.4, 0.6, 0.6, 12.4, { mat: metal(0.3) });
    m.box(-0.3, 0, (SCREEN.top + SCREEN.bottom) / 2, 0.5, SCREEN.half + 1.4, (SCREEN.top - SCREEN.bottom) / 2 + 1, { mat: matte(R.black, 0.4) });
    m.box(0.2, 0, (SCREEN.top + SCREEN.bottom) / 2, 0.12, SCREEN.half, (SCREEN.top - SCREEN.bottom) / 2, { mat: matte(R.black, 1.2) });
    m.box(0.3, 0, SCREEN.top + 1.6, 0.25, SCREEN.half, 0.3, { mat: lamp, cast: false });
    // The three buttons below: approve, send back, cast a creator.
    for (const [y, ramp] of [
      [-4, R.jade],
      [0, R.magenta],
      [4, R.amber],
    ] as const) m.box(0.5, y, SCREEN.bottom - 1.6, 0.2, 1.4, 0.5, { mat: neon(ramp, 0.2), cast: false });
  });
}

// ----------------------------------------------------------------------------------------------
// Publishing terminal and analytics (agora)

/** The uplink pedestal (in place of the podium): top at z 5.1, a step on +x, an antenna array. */
export function uplink(m: Model, frame = 0) {
  m.box(0, 0, 0.8, 6.4, 6.4, 0.8, { mat: metal(0.2) });
  m.box(0, 0, 3.1, 4.8, 4.8, 1.5, { mat: metal(0.4) });
  m.box(0, 0, 4.85, 5.1, 5.1, 0.25, { mat: metal(1) });
  m.box(0, 0, 4.6, 5.15, 5.15, 0.06, { mat: neon(R.neonPink, 0.2), cast: false });
  m.box(5.6, 0, 1.9, 1.2, 2.4, 0.3, { mat: metal(0.6) });
  // Antennas at the back corners, and a status console.
  for (const [x, y] of [
    [-4.4, -4.4],
    [-4.4, 4.4],
    [4.4, -4.4],
  ] as const) {
    m.capsule([x, y, 5], [x, y, 16], 0.25, { mat: metal(1) });
    m.sphere(x, y, 16.4, 0.5, { mat: neon(R.neonCyan, 0.8) });
  }
  m.box(-3, 0, 7.6, 0.6, 2.4, 2.4, { mat: matte(R.black, 0.6), rot: rotY(-0.3) });
  m.box(-2.5, 0, 7.8, 0.05, 2.1, 1.8, { mat: cyberScreen(1, 0.1 + frame * 0.25, "chart"), rot: rotY(-0.3) });
}

/** A platform's sign on a pole (in place of its banner): a vertical neon panel in its colours. */
export function platformSign(m: Model, colors: [number, number], wave: number) {
  m.capsule([0, 0, 0], [0, 0, 17], 0.35, { mat: metal(0.6) });
  m.box(0, 3.4, 13.6, 0.4, 2.8, 4, { mat: matte(R.black, 0.5) });
  const pulse = 0.3 + Math.sin(wave * Math.PI * 2) * 0.4;
  m.box(0.45, 3.4, 13.6, 0.05, 2.4, 3.6, {
    mat: (h, out) => {
      out.dither = 0;
      out.glow = 1;
      out.ramp = colors[0];
      out.tone = pulse - 0.6;
      if (Math.abs(h.lz) < 1 && Math.abs(h.ly) < 1) {
        out.ramp = colors[1];
        out.tone = pulse;
      }
    },
    cast: false,
  });
}

/** A potted plant with long leaves; the pot rimmed in neon. `seed` varies it. */
export function cyberPlant(m: Model, seed: number) {
  m.frustum(0, 0, 2.2, 2.2, 2.8, 2.2, { mat: matte(R.hqWallViolet, 0.6) });
  m.cylinder(0, 0, 4.45, 2.85, 0.12, { mat: neon(seed % 2 ? R.neonPink : R.neonCyan, 0), cast: false });
  const leaf = (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    out.ramp = R.jade;
    out.tone = -0.4 + (hash2(Math.floor(h.x * 2), Math.floor(h.z * 2)) > 0.7 ? 0.5 : 0);
  };
  const count = 6 + (seed % 3);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + seed;
    const len = 5 + hash2(seed, i) * 5;
    const tip: [number, number, number] = [Math.cos(a) * len * 0.45, Math.sin(a) * len * 0.45, 4.5 + len];
    m.capsule([0, 0, 4.4], tip, 0.75, { mat: leaf });
    m.ellipsoid(tip[0], tip[1], tip[2], 1.2, 1.2, 1.8, { mat: leaf });
  }
}

/** A drum or crate standing about: dark, with a hazard band. */
export function barrel(m: Model) {
  m.cylinder(0, 0, 3.6, 2.2, 3.6, { mat: (h, out) => ((out.dither = 0), (out.ramp = R.hqPurple), (out.tone = Math.abs(h.lz - 1) < 0.5 ? 1.2 : 0.2)) });
  m.cylinder(0, 0, 4.6, 2.25, 0.35, { mat: neon(R.amber, -0.4), cast: false });
}

/** A warm heater drum (in place of the campfire), its top glowing. */
export function heater(m: Model, frame: number) {
  barrel(m);
  m.cylinder(0, 0, 7.3, 1.9, 0.1, { mat: neon(R.amber, 0.4 + (frame % 4) * 0.3), cast: false });
}

// ----------------------------------------------------------------------------------------------
// The street's shop fronts (the lands): one per research source.

type Shop = { sign: number; accent: number; mark: "phone" | "grid" | "play" | "boards" | "bubble" | "orb" | "gem" | "bars" | "houses" | "door" };

export const SHOPS: Record<string, Shop> = {
  phone: { sign: R.neonPink, accent: R.neonCyan, mark: "phone" },
  gallery: { sign: R.neonPink, accent: R.amber, mark: "grid" },
  bigscreen: { sign: R.magenta, accent: R.white, mark: "play" },
  billboards: { sign: R.blue, accent: R.neonCyan, mark: "boards" },
  forum: { sign: R.amber, accent: R.coral, mark: "bubble" },
  orbshrine: { sign: R.jade, accent: R.neonCyan, mark: "orb" },
  crystal: { sign: R.neonCyan, accent: R.violet, mark: "gem" },
  beacon: { sign: R.amber, accent: R.neonPink, mark: "bars" },
  huts: { sign: R.neonCyan, accent: R.blue, mark: "houses" },
  gate: { sign: R.neonPink, accent: R.amber, mark: "door" },
};

/**
 * A shop front along the street, facing the road (+y): a dark building with lit windows, a door
 * and an awning, and over it a neon sign whose mark says which source it is.
 */
export function storefront(m: Model, kind: string) {
  const shop = SHOPS[kind] ?? SHOPS.gate;
  const seed = kind.length * 7 + kind.charCodeAt(0);
  const tall = 26 + (seed % 4) * 6;
  const wall = (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    out.ramp = seed % 2 ? R.hqWallViolet : R.hqWall;
    out.tone = h.nz > 0.5 ? 0.6 : h.ny > 0.5 ? 0.2 : -0.6;
    if (h.ny > 0.5 && h.z > 14) {
      const wx = frac(h.x / 5);
      const wz = frac((h.z - 14) / 6);
      if (wx > 0.2 && wx < 0.8 && wz > 0.25 && wz < 0.8) {
        const n = hash2(Math.floor(h.x / 5) + seed, Math.floor(h.z / 6));
        out.ramp = n > 0.6 ? R.amber : n > 0.4 ? R.neonCyan : R.black;
        out.tone = n > 0.4 ? -0.6 : 0.6;
        out.glow = n > 0.4 ? 0.7 : 0;
      }
    }
  };
  m.box(0, -4, tall / 2, 18, 6, tall / 2, { mat: wall });
  // The shop window and door at street level.
  m.box(-6, 2.05, 5, 7, 0.1, 4, { mat: (h, out) => ((out.dither = 0), (out.ramp = shop.accent), (out.tone = -1 + (frac(h.x / 3) < 0.1 ? 1 : 0)), (out.glow = 0.6)) });
  m.box(7, 2.05, 4.5, 3, 0.1, 4.5, { mat: matte(R.black, 0.6) });
  m.box(7, 2.1, 4.5, 2.6, 0.06, 4.1, { mat: neon(shop.accent, -1.2), cast: false });
  // Awning.
  m.box(0, 4, 10.4, 17, 2.4, 0.3, { mat: (h, out) => ((out.dither = 0), (out.ramp = shop.sign), (out.tone = frac(h.x / 3) < 0.5 ? -1 : -1.8)) });
  m.box(0, 6.35, 10.2, 17, 0.06, 0.25, { mat: neon(shop.sign, 0), cast: false });
  // The sign: a dark board on brackets, and the mark lit on it.
  m.box(0, 2.4, 15.5, 7, 0.4, 3.2, { mat: matte(R.black, 0.5) });
  m.box(0, 2.85, 15.5, 6.4, 0.05, 2.7, { mat: markMat(shop), cast: false });
}

function markMat(shop: Shop) {
  return (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    out.glow = 1;
    out.ramp = shop.sign;
    const u = h.lx;
    const v = h.lz;
    let on = false;
    switch (shop.mark) {
      case "phone":
        on = Math.abs(u) < 1.4 && Math.abs(v) < 2.4 && !(Math.abs(u) < 1 && Math.abs(v) < 1.9);
        break;
      case "grid":
        on = Math.abs(u) < 2.2 && Math.abs(v) < 2.2 && (frac((u + 2.2) / 1.5) < 0.25 || frac((v + 2.2) / 1.5) < 0.25);
        break;
      case "play":
        on = u > -1.6 && u < 2 && Math.abs(v) < (2 - u) * 0.55;
        break;
      case "boards":
        on = Math.abs(v) < 1.6 && frac((u + 6) / 4) < 0.8 && Math.abs(u) < 6;
        break;
      case "bubble":
        on = Math.hypot(u / 1.4, v) < 2 && Math.hypot(u / 1.4, v) > 1.3;
        break;
      case "orb":
        on = Math.hypot(u, v) < 2;
        break;
      case "gem":
        on = Math.abs(u) + Math.abs(v) * 0.8 < 2.2;
        break;
      case "bars":
        on = Math.abs(u) < 3 && frac((u + 3) / 1.5) < 0.6 && v + 2.2 < ((u + 3) / 6) * 4.4;
        break;
      case "houses":
        on = Math.abs(u) < 4.5 && v < 0.6 - Math.abs(frac((u + 4.5) / 3) - 0.5) * 2 && v > -2;
        break;
      case "door":
        on = Math.abs(u) < 1.6 && v > -2.4 && v < 1.6;
        break;
    }
    if (on) out.tone = 0.6;
    else {
      out.ramp = shop.accent;
      out.tone = -2.2;
      out.glow = 0.2;
    }
  };
}

void rotX;

// ----------------------------------------------------------------------------------------------
// The command table in the middle of the room: the orchestrator.

/** Colours of a station's light on the table, by its state code (see HUB_STATES). */
const HUB_LIGHT = [R.hqMetal, R.neonCyan, R.jade, R.magenta, R.hqPurple, R.amber];
/** A station's state, as a digit of the table's variant. */
export const HUB_STATES = ["waiting", "working", "done", "failed", "skipped", "yours"] as const;

/**
 * A round command table with the Surreel mark glowing over it. Round its rim, one light per station in
 * pipeline order: dark while it waits, cyan while it works, green done, amber when it waits on you,
 * magenta when it failed. `states` are the six codes; `blink` dims the working ones for a frame.
 */
export function commandTable(m: Model, states: number[], blink: boolean) {
  m.cylinder(0, 0, 3.4, 6, 3.4, { mat: metal(0.1) });
  m.cylinder(0, 0, 7.2, 15, 0.5, { mat: metal(0.8) });
  m.cylinder(0, 0, 7.75, 13.6, 0.06, {
    mat: (h, out) => {
      out.dither = 0;
      out.ramp = R.hqWall;
      out.tone = 0.2;
      const r = Math.hypot(h.x, h.y);
      // Rings and spokes: the pipeline as a circuit.
      if (Math.abs(r - 9) < 0.35 || Math.abs(r - 5) < 0.3) {
        out.ramp = R.neonCyan;
        out.tone = -1;
        out.glow = 0.6;
      }
    },
    cast: false,
  });
  // The station lights round the rim, starting at the back (where the research desk is) and going round.
  for (let i = 0; i < 6; i++) {
    const a = Math.PI * 0.75 + (i / 6) * Math.PI * 2;
    const state = states[i] ?? 0;
    const lit = !(blink && (state === 1 || state === 5));
    const ramp = HUB_LIGHT[state] ?? R.hqMetal;
    m.with(mul(translate(Math.cos(a) * 12, Math.sin(a) * 12, 7.9), rotZ(a)), () => {
      m.box(0, 0, 0, 1.2, 2.8, 0.25, { mat: state === 0 || !lit ? matte(ramp, -0.2) : neon(ramp, 0.4), cast: false });
    });
  }
  // The projector and the Surreel mark: an N of light over the middle.
  m.cylinder(0, 0, 8.4, 2.2, 0.8, { mat: metal(0.4) });
  m.frustum(0, 0, 12.5, 2.2, 5.5, 3.4, { mat: neon(R.neonCyan, -2), cast: false });
  m.with(rotZ(Math.PI / 4), () => {
    for (const y of [-2.2, 2.2]) m.box(0, y, 18.5, 0.25, 0.55, 3.2, { mat: neon(R.neonPink, 0.6), cast: false });
    m.with(mul(translate(0, 0, 18.5), rotX(-0.6)), () => m.box(0, 0, 0, 0.25, 0.55, 3.6, { mat: neon(R.neonPink, 0.6), cast: false }));
  });
  // Stools round the table.
  for (const a of [0.4, 1.9, 3.4, 4.9]) {
    const x = Math.cos(a) * 19;
    const y = Math.sin(a) * 19;
    m.cylinder(x, y, 2.4, 1.6, 0.35, { mat: matte(R.hqPurple, 0.5) });
    m.capsule([x, y, 0], [x, y, 2.1], 0.3, { mat: metal(0.6) });
  }
}

// ----------------------------------------------------------------------------------------------
// The street's life: lamps along the kerb and hover cars passing.

/** A street lamp on the kerb: a pole, an arm out over the road (+y... toward -y, the road), a lamp. */
export function streetLamp(m: Model, v: number) {
  const ramp = v % 2 ? R.neonCyan : R.neonPink;
  m.capsule([0, 0, 0], [0, 0, 24], 0.45, { mat: metal(0.5) });
  m.box(0, 0, 0.6, 1.2, 1.2, 0.6, { mat: metal(0.3) });
  m.capsule([0, 0, 24], [0, -7, 26], 0.35, { mat: metal(0.8) });
  m.box(0, -7.5, 25.4, 1.6, 2.2, 0.6, { mat: metal(0.6) });
  m.box(0, -7.5, 24.7, 1.3, 1.9, 0.1, { mat: neon(ramp, 0.6), cast: false });
  // A neon ring round the pole at head height.
  m.cylinder(0, 0, 14, 0.65, 0.5, { mat: neon(ramp, 0.2), cast: false });
}

const CAR_COLOURS = [
  [R.hqPurple, R.neonPink],
  [R.navy, R.neonCyan],
  [R.black, R.amber],
  [R.white, R.neonBlue],
] as const;

/** A hover car along +x (`v` picks its paint and its neon), floating over a glow. */
export function hoverCar(m: Model, v: number) {
  const [paint, glow] = CAR_COLOURS[v % CAR_COLOURS.length];
  const body = (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    out.ramp = paint;
    out.tone = h.nz > 0.5 ? 1 : 0.3;
  };
  m.box(0, 0, 3.2, 8, 3.6, 1.4, { mat: body, clip: [1, 0, 0.6, 8.2] });
  // The cabin: tinted glass with a lit edge.
  m.box(-1, 0, 5.4, 4.2, 3, 1.1, {
    mat: (h, out) => {
      out.dither = 0;
      out.ramp = R.neonCyan;
      out.tone = h.nz > 0.5 ? -1.6 : -2.2;
      out.glow = 0.3;
    },
    clip: [1, 0, 1, 4.6],
  });
  // Head- and tail-lights, the skirt glowing underneath.
  m.box(8.1, 0, 3.4, 0.15, 2.8, 0.35, { mat: neon(R.white, 1.4), cast: false });
  m.box(-8.1, 0, 3.4, 0.15, 3, 0.35, { mat: neon(R.magenta, 0.6), cast: false });
  m.box(0, 0, 1.6, 7, 3.2, 0.2, { mat: neon(glow, 0.2), cast: false });
}
