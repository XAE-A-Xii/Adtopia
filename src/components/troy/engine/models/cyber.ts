import { solid } from "../materials";
import { R } from "../palette";
import { hash2, type HitInfo, Model, mul, rotX, rotY, rotZ, type ShadeOut, translate } from "../tracer";
import { textPixel } from "../font";
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
  // Vertical phone screens, as the viral videos are watched: two rows of five, 9:16.
  for (let row = 0; row < 2; row++) {
    for (let k = 0; k < 5; k++) {
      const y = -6 + k * 3;
      const z = 7 + row * 5.2;
      m.box(-10, y, z, 0.9, 1.25, 2.3, { mat: matte(R.black, 0.8) });
      m.box(-9.05, y, z, 0.06, 1.05, 2.05, { mat: cyberScreen(1, (row * 5 + k) * 0.41 + frame * 0.25, "feed") });
      // A heart and a play mark under each, counting.
      m.box(-9.0, y - 0.5, z - 1.55, 0.05, 0.25, 0.2, { mat: neon(R.neonPink, 0.3), cast: false });
    }
  }
  for (let row = 0; row < 0; row++) {
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

/** An office chair whose sitter faces `dir` (0 +x, 2 +y, 4 -x, 6 -y): seat, gas lift, back behind them. */
function officeChair(m: Model, x: number, y: number, dir: number, ramp: number) {
  const a = (dir * Math.PI) / 4;
  const bx = x - Math.cos(a) * 2;
  const by = y - Math.sin(a) * 2;
  m.capsule([x, y, 0.4], [x, y, 2], 0.3, { mat: metal(0.8) });
  m.box(x, y, 0.3, 1.6, 1.6, 0.2, { mat: metal(0.2) });
  m.cylinder(x, y, 2.2, 1.7, 0.3, { mat: matte(ramp, -1.2) });
  m.box(bx, by, 5, Math.abs(Math.cos(a)) > 0.5 ? 0.3 : 1.6, Math.abs(Math.cos(a)) > 0.5 ? 1.6 : 0.3, 2.4, { mat: matte(ramp, -1.4) });
}

/**
 * The viral study's format table (in place of the reference archive): a long table with a glowing
 * surface, the category's top videos floating over it as three vertical holograms (bright while the
 * study runs, `on`), and four chairs round it: one at each end, one each side.
 */
export function formatTable(m: Model, frame: number, on: boolean) {
  const top = (h: HitInfo, out: ShadeOut) => ((out.dither = 0), (out.ramp = R.woodDark), (out.tone = h.nz > 0.5 ? 0.8 : -0.2));
  m.box(0, 0, 7.1, 12, 7, 0.45, { mat: top });
  for (const x of [-10.4, 10.4]) for (const y of [-5.4, 5.4]) m.box(x, y, 3.4, 0.5, 0.5, 3.4, { mat: metal(0.4) });
  // The table's glass: a grid of light with thumbnails of the videos being broken down.
  m.box(0, 0, 7.6, 11, 6, 0.04, {
    mat: (h, out) => {
      out.dither = 0;
      out.glow = 1;
      out.ramp = R.neonCyan;
      out.tone = frac(h.x / 2) < 0.08 || frac(h.y / 2) < 0.08 ? -1 : -2.2;
      const card = Math.abs(frac((h.x + 11) / 5.5) - 0.5) < 0.3 && Math.abs(h.y) > 2.2 && Math.abs(h.y) < 5;
      if (card) {
        out.ramp = Math.floor((h.x + 11) / 5.5) % 2 ? R.neonPink : R.amber;
        out.tone = -1.2;
      }
    },
    cast: false,
  });
  m.box(0, 7.05, 7.1, 12, 0.06, 0.15, { mat: neon(R.neonPink, -0.2), cast: false });
  // The projector in the middle, and three phone-shaped holograms over it, bobbing in turn.
  m.cylinder(0, 0, 7.9, 1.5, 0.3, { mat: metal(0.6) });
  m.frustum(0, 0, 9.6, 1.4, 6, 1.6, { mat: neon(R.neonCyan, -2.6), cast: false });
  for (let k = -1; k <= 1; k++) {
    const bob = [0, 0.5, 0.8, 0.5][(frame + k + 1) % 4];
    m.box(k * 6, 0, 15 + bob, 2, 0.06, 3.5, {
      mat: (h, out) => {
        out.dither = 0;
        out.glow = 1;
        out.ramp = R.neonCyan;
        const u = (h.lx + 2) / 4;
        const v = (h.lz + 3.5) / 7;
        out.tone = u < 0.08 || u > 0.92 || v < 0.05 || v > 0.95 ? 0 : on ? -1.2 : -2.4;
        if (on && u > 0.15 && u < 0.85 && v > 0.12 && v < 0.88) {
          // A scene in each: a sky, a figure, a caption.
          out.ramp = [R.neonPink, R.amber, R.violet][k + 1];
          out.tone = -1.4 + v;
          if (Math.abs(u - 0.5) < 0.14 && v > 0.3 && v < 0.6) {
            out.ramp = R.cream;
            out.tone = -0.2;
          }
          if (v < 0.22 && Math.floor(u * 6 + frame) % 2) {
            out.ramp = R.white;
            out.tone = -0.8;
          }
        }
      },
      cast: false,
    });
  }
  // The chairs: at each end and on each side.
  officeChair(m, 15, 0, 4, R.neonCyan);
  officeChair(m, -15, 0, 0, R.neonPink);
  officeChair(m, -3, 10.5, 6, R.violet);
  officeChair(m, 3, -10.5, 2, R.neonBlue);
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
 * The writers' desk under the storyboard wall (in place of the war tent): a desk against the wall
 * facing +x with a monitor full of script, a lamp, stacks of notebooks and a chair.
 */
export function planningCorner(m: Model) {
  m.box(-1, 0, 6.2, 3.2, 8, 0.4, { mat: (h, out) => ((out.dither = 0), (out.ramp = R.woodDark), (out.tone = h.nz > 0.5 ? 0.8 : 0)) });
  for (const y of [-7, 7]) m.box(-1, y, 3, 2.8, 0.4, 3, { mat: metal(0.2) });
  // The laptop, open, its screen full of script; a second screen on an arm with the reference.
  m.box(-0.8, 0, 6.75, 1.6, 2.4, 0.15, { mat: matte(R.hqMetal, 0.6) });
  m.box(-2.4, 0, 8.2, 0.12, 2.4, 1.5, { mat: matte(R.hqMetal, 0.4), rot: rotY(-0.25) });
  m.box(-2.25, 0, 8.25, 0.05, 2.2, 1.3, { mat: cyberScreen(1, 0.3, "text"), rot: rotY(-0.25) });
  m.box(-3, 4.6, 10.4, 0.4, 1.6, 2.2, { mat: matte(R.black, 0.6), rot: rotZ(-0.4) });
  m.box(-2.6, 4.7, 10.4, 0.05, 1.4, 2, { mat: cyberScreen(1, 0.7, "feed"), rot: rotZ(-0.4) });
  m.capsule([-3, 6.4, 6.6], [-1.2, 6.4, 11], 0.2, { mat: metal(1) });
  m.ellipsoid(-0.8, 6.4, 10.8, 1.1, 1.1, 0.7, { mat: lamp });
  for (let i = 0; i < 4; i++) m.box(0.4, -6 + (i % 2) * 0.3, 6.8 + i * 0.35, 1.2, 1.4, 0.16, { mat: matte(i % 2 ? R.neonPink : R.cream, 0.1) });
  m.box(1, 1, 6.68, 0.9, 2.1, 0.12, { mat: (h, out) => ((out.dither = 0), (out.ramp = R.black), (out.tone = h.nz > 0.5 && frac(h.ly * 1.6) < 0.3 ? 0.2 : 1)) });
  m.cylinder(1.4, -3.6, 7.1, 0.5, 0.5, { mat: matte(R.amber, 0.2) });
  // The chair at the desk, where the writer sits facing the wall.
  officeChair(m, 6, 1, 4, R.neonPink);
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
 * The frame artist's station (in place of the easel): a big monitor on a stand facing +x, showing
 * the first frame as it is painted (`painted` 0..1), and a drawing tablet on a tall table.
 */
export function shootRig(m: Model, painted: number) {
  m.capsule([0, 0, 0], [0, 0, 7], 0.35, { mat: metal(0.8) });
  m.box(0, 0, 0.25, 2, 2, 0.25, { mat: metal(0.4) });
  m.box(0, 0, 10.6, 0.5, 4.6, 3.6, { mat: matte(R.black, 0.6) });
  m.box(0.55, 0, 10.6, 0.05, 4.3, 3.3, {
    mat: (h, out) => {
      out.dither = 0;
      out.glow = 1;
      // The frame fills in from the bottom: a sunset gradient behind a figure.
      const v = (h.lz + 3.3) / 6.6;
      if (v > painted) {
        out.ramp = R.black;
        out.tone = 0.8;
        out.glow = 0;
        if (frac(h.ly / 1.1) < 0.06 || frac(h.lz / 1.1) < 0.06) out.tone = 0.2;
        return;
      }
      const figure = Math.abs(h.ly - 0.8) < 0.9 && h.lz < 1.2;
      out.ramp = figure ? R.hqWall : v > 0.55 ? R.neonPink : R.amber;
      out.tone = figure ? 0.6 : 0.2 - v;
    },
  });
  // The tablet on its table, its pen glowing.
  m.capsule([2.2, 2.6, 0], [2.2, 2.6, 7], 0.3, { mat: metal(0.6) });
  m.box(2.2, 2.6, 7.5, 1.6, 2, 0.3, { mat: matte(R.black, 0.5), rot: rotY(0.3) });
  m.box(2.35, 2.6, 7.85, 1.3, 1.7, 0.04, { mat: neon(R.neonCyan, -1), rot: rotY(0.3), cast: false });
  m.capsule([2.4, 1.6, 8.2], [3, 3, 8.6], 0.15, { mat: neon(R.neonPink, 0.4), cast: false });
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

/**
 * The review desk (the video wall is the screen): a console facing the lounge (+x+y) with a monitor
 * and the three big buttons a person presses: approve (green), send back (red), cast a creator (amber).
 */
export function approvalScreen(m: Model) {
  m.with(rotZ(Math.PI / 4), () => {
    m.box(0, 0, 4, 3, 9, 4, { mat: metal(0.2) });
    // The slanted panel, its buttons, and a strip of light along its edge.
    m.with(mul(translate(1.2, 0, 8.6), rotY(-0.5)), () => {
      m.box(0, 0, 0, 2.6, 8.6, 0.4, { mat: matte(R.black, 0.6) });
      for (const [y, ramp] of [
        [-4.6, R.jade],
        [0, R.magenta],
        [4.6, R.amber],
      ] as const) {
        m.cylinder(0.4, y, 0.6, 1.5, 0.35, { mat: neon(ramp, 0.4), cast: false });
        m.cylinder(0.4, y, 0.25, 1.8, 0.15, { mat: metal(0.8) });
      }
    });
    m.box(2.9, 0, 8, 0.1, 9, 0.12, { mat: lamp, cast: false });
    // A monitor showing the cut, on an arm.
    m.capsule([-2, 6, 8], [-2, 6, 13], 0.3, { mat: metal(0.8) });
    m.box(-2, 6, 15, 0.4, 2.4, 1.8, { mat: matte(R.black, 0.5) });
    m.box(-1.55, 6, 15, 0.05, 2.1, 1.5, { mat: cyberScreen(1, 0.6, "feed") });
    // A chair for the reviewer.
    m.cylinder(7, 0, 2.2, 1.8, 0.3, { mat: matte(R.amber, -0.6) });
    m.capsule([7, 0, 0.4], [7, 0, 2], 0.3, { mat: metal(0.8) });
    m.box(8.9, 0, 5.2, 0.3, 1.8, 2.6, { mat: matte(R.amber, -0.8) });
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

/** Each shop's platform, spelled down its blade sign. */
const SHOP_NAMES: Record<string, string> = {
  gate: "BRAND",
  huts: "SIMILARWEB",
  beacon: "AHREFS",
  orbshrine: "CHATGPT",
  crystal: "PERPLEXITY",
  phone: "TIKTOK",
  gallery: "INSTAGRAM",
  bigscreen: "YOUTUBE",
  billboards: "META ADS",
  forum: "REDDIT",
};

type Lit = { ramp: number; tone: number } | null;

/** A rounded rectangle's signed distance (negative inside). */
function roundBox(u: number, v: number, hx: number, hy: number, r: number) {
  const qx = Math.abs(u) - hx + r;
  const qy = Math.abs(v) - hy + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** A segment's distance from a point. */
function seg(u: number, v: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((u - ax) * dx + (v - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(u - ax - dx * t, v - ay - dy * t);
}

/** A regular hexagon's distance from its outline (point-up when `turn` is 0). */
function hexRing(u: number, v: number, r: number, turn: number) {
  const a = Math.atan2(v, u) + turn;
  const sector = Math.PI / 3;
  const k = ((a % sector) + sector) % sector - sector / 2;
  return Math.abs(Math.hypot(u, v) * Math.cos(k) - r * Math.cos(Math.PI / 6));
}

/**
 * The platforms' logos as neon on the roofs, drawn in a 24 x 22 square (`u` across, `v` up, from
 * its centre). Simplified marks, recognisable from the street: TikTok's note with its cyan and red
 * echoes, Instagram's camera, YouTube's play button, Reddit's alien, Meta's loop, and so on.
 */
const LOGOS: Record<string, (u: number, v: number) => Lit> = {
  phone: (u, v) => {
    const note = (x: number, y: number) => (Math.abs(x - 1.5) < 1.4 && y > -6 && y < 9) || Math.hypot(x + 2.4, y + 6) < 3.4 || (x > 1.5 && x < 6.5 && y < 9 - (x - 1.5) * 0.5 && y > 6.4 - (x - 1.5) * 1.1);
    const a = note(u + 1, v - 0.8);
    const b = note(u - 1, v + 0.8);
    if (a && b) return { ramp: R.white, tone: 1 };
    if (a) return { ramp: R.neonCyan, tone: 0.4 };
    if (b) return { ramp: R.magenta, tone: 0.6 };
    return null;
  },
  gallery: (u, v) => {
    const t = (u + v + 22) / 44;
    const ramp = t < 0.36 ? R.amber : t < 0.68 ? R.neonPink : R.violet;
    const frame = Math.abs(roundBox(u, v, 10, 10, 4)) < 1.2;
    const lens = Math.abs(Math.hypot(u, v) - 4.6) < 1.2;
    const dot = Math.hypot(u - 5.6, v - 5.6) < 1.2;
    return frame || lens || dot ? { ramp, tone: 0.4 } : null;
  },
  bigscreen: (u, v) => {
    if (roundBox(u, v, 11, 8, 3.5) > 0) return null;
    if (u > -3 && u < 5 && Math.abs(v) < ((5 - u) * 4.4) / 8) return { ramp: R.white, tone: 1.2 };
    return { ramp: R.magenta, tone: 0.2 };
  },
  forum: (u, v) => {
    const r = Math.hypot(u, v);
    if (r > 10.5) return null;
    const face = Math.hypot(u / 6.4, (v + 1.6) / 4.2) < 1;
    const eye = Math.hypot(Math.abs(u) - 2.6, v + 0.8) < 1.2;
    const ear = Math.hypot(Math.abs(u) - 5.8, v - 1.6) < 1.5;
    const antenna = seg(u, v, 0, 2.4, 2.2, 7.4) < 0.6 || Math.hypot(u - 3.6, v - 7.6) < 1.3;
    if (eye) return { ramp: R.coral, tone: 0.8 };
    if (face || ear || antenna) return { ramp: R.white, tone: 1 };
    return { ramp: R.coral, tone: 0.4 };
  },
  billboards: (u, v) => {
    const loop = (cx: number) => Math.abs(Math.hypot((u - cx) / 4.8, v / 4.6) - 1) < 0.28;
    return loop(-4.6) || loop(4.6) ? { ramp: u < 0 ? R.neonBlue : R.neonCyan, tone: 0.5 } : null;
  },
  orbshrine: (u, v) => (hexRing(u, v, 9, 0) < 1.1 || hexRing(u, v, 5, Math.PI / 6) < 1 || (Math.hypot(u, v) < 9 && Math.abs(Math.sin(Math.atan2(v, u) * 3)) < 0.12 && Math.hypot(u, v) > 4) ? { ramp: R.white, tone: 0.8 } : null),
  crystal: (u, v) => {
    const spoke = [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4].some((a) => seg(u, v, -Math.cos(a) * 9, -Math.sin(a) * 9, Math.cos(a) * 9, Math.sin(a) * 9) < 0.75);
    const box = Math.abs(roundBox(u, v, 6.2, 6.2, 0.5)) < 0.75;
    return spoke || box ? { ramp: R.neonCyan, tone: 0.5 } : null;
  },
  beacon: (u, v) => (textPixel("A", (u + 7.5) / 3, (10.5 - v) / 3) ? { ramp: R.amber, tone: 0.6 } : null),
  huts: (u, v) => (textPixel("S", (u + 7.5) / 3, (10.5 - v) / 3) ? { ramp: R.neonBlue, tone: 0.8 } : null),
  gate: (u, v) => {
    const r = Math.hypot(u, v);
    const ring = Math.abs(r - 9.5) < 1;
    const meridian = Math.abs(Math.hypot(u / 4.2, v / 9.5) - 1) < 0.14;
    const lines = r < 9.5 && (Math.abs(v) < 0.6 || Math.abs(Math.abs(v) - 5) < 0.55 || Math.abs(u) < 0.6);
    return ring || meridian || lines ? { ramp: R.neonPink, tone: 0.5 } : null;
  },
};

/** Height of a shop's street floor, and of each floor of flats above it (an agent is about 20 tall). */
export const SHOP_GROUND = 30;
export const SHOP_FLOOR = 24;

/**
 * How many floors of flats a shop's building has (2 to 4, so the logos on the roofs stay in view),
 * its height to the roof, and the letters of the name down its blade sign.
 */
export function storefrontSize(kind: string) {
  const seed = kind.length * 7 + kind.charCodeAt(0);
  const name = SHOP_NAMES[kind] ?? "";
  // Tall enough for its name down the blade sign: from 34 up, a letter every 8.
  const floors = Math.min(4, Math.max(2 + (seed % 2), Math.ceil((name.length * 8 + 46 - SHOP_GROUND) / SHOP_FLOOR)));
  return { floors, tall: SHOP_GROUND + floors * SHOP_FLOOR, letters: name.length };
}

/**
 * A building along the street, facing the road (+y), at the crew's scale: a shop on the street
 * floor (a lit window, a door an agent walks through, an awning and a neon sign whose mark says
 * which source it is) and floors of flats above it, with lit windows, air conditioners, a fire
 * escape, a vertical blade sign spelling the platform, and on the roof its logo in neon, a water
 * tank and an aerial.
 */
export function storefront(m: Model, kind: string) {
  const shop = SHOPS[kind] ?? SHOPS.gate;
  const seed = kind.length * 7 + kind.charCodeAt(0);
  const name = SHOP_NAMES[kind] ?? "";
  const { floors, tall } = storefrontSize(kind);
  const half = 18.5;
  const back = -22;
  const front = 2;
  const G = SHOP_GROUND;
  const F = SHOP_FLOOR;
  m.box(0, (back + front) / 2, tall / 2, half, (front - back) / 2, tall / 2, { mat: buildingWall(seed, half, back) });
  // A cornice and a parapet on top.
  const fe = (h: HitInfo, out: ShadeOut) => ((out.dither = 0), (out.ramp = R.hqMetal), (out.tone = h.nz > 0.5 ? 0.8 : 0.1));
  m.box(0, (back + front) / 2, tall + 0.8, half + 0.6, (front - back) / 2 + 0.6, 0.8, { mat: (h, out) => ((out.dither = 0), (out.ramp = R.hqMetal), (out.tone = h.nz > 0.5 ? 0.6 : 0.2)) });
  m.box(0, front + 0.1, tall - 0.8, half, 0.06, 0.25, { mat: neon(shop.sign, -0.6), cast: false });
  // The street floor: the shop window, the door, the awning over them, the sign over the awning.
  m.box(-6, front + 0.05, 10, 8, 0.1, 8, { mat: (h, out) => ((out.dither = 0), (out.ramp = shop.accent), (out.tone = -1 + (frac(h.x / 4) < 0.08 ? 1 : 0)), (out.glow = 0.6)) });
  m.box(10, front + 0.05, 12, 4.5, 0.1, 12, { mat: matte(R.black, 0.6) });
  m.box(10, front + 0.1, 12, 4, 0.06, 11.5, { mat: neon(shop.accent, -1.2), cast: false });
  m.box(0, front + 2.6, 25.4, 17.5, 3, 0.35, { mat: (h, out) => ((out.dither = 0), (out.ramp = shop.sign), (out.tone = frac(h.x / 4) < 0.5 ? -1 : -1.8)) });
  m.box(0, front + 5.55, 25.2, 17.5, 0.06, 0.3, { mat: neon(shop.sign, 0), cast: false });
  m.box(0, front + 0.4, G + 0.5, 8, 0.4, 3.4, { mat: matte(R.black, 0.5) });
  m.box(0, front + 0.85, G + 0.5, 7.4, 0.05, 2.9, { mat: markMat(shop), cast: false });
  // A blade sign down the corner with the platform's name spelled down it, a letter at a time.
  const bladeBottom = 34;
  const bladeTop = bladeBottom + name.length * 8 + 4;
  const bladeY = front + 4;
  m.box(-half + 1, bladeY, (bladeBottom + bladeTop) / 2, 0.5, 3.8, (bladeTop - bladeBottom) / 2, { mat: matte(R.black, 0.5) });
  m.box(-half + 1.55, bladeY, (bladeBottom + bladeTop) / 2, 0.05, 3.4, (bladeTop - bladeBottom) / 2 - 0.6, {
    mat: (h, out) => {
      out.dither = 0;
      const k = Math.floor((bladeTop - 2 - h.z) / 8);
      const row = bladeTop - 2 - h.z - k * 8;
      const lit = k >= 0 && k < name.length && textPixel(name[k], bladeY + 2.5 - h.y, row);
      out.ramp = lit ? shop.sign : R.black;
      out.tone = lit ? 0.8 : 0.5;
      out.glow = lit ? 1 : 0;
    },
    cast: false,
  });
  m.box(-half + 1.55, bladeY, bladeTop - 0.6, 0.06, 3.6, 0.2, { mat: neon(shop.accent, 0), cast: false });
  m.box(-half + 1.55, bladeY, bladeBottom + 0.6, 0.06, 3.6, 0.2, { mat: neon(shop.accent, 0), cast: false });
  // Air conditioners under some windows, and a fire escape up the right of the front.
  for (let f = 0; f < floors; f++) {
    const ax = ((hash2(seed, f) * 2 - 1) * (half - 8)) | 0;
    m.box(ax, front + 1.6, G + f * F + 4, 2.6, 1.6, 1.8, { mat: (h, out) => ((out.dither = 0), (out.ramp = R.white), (out.tone = h.ny > 0.5 ? -1.4 : -0.8)) });
  }
  for (let f = 0; f < floors; f++) m.box(half - 6, front + 2.6, G + f * F + 0.4, 5.5, 2.6, 0.4, { mat: fe });
  m.capsule([half - 1.5, front + 4.6, G], [half - 1.5, front + 4.6, G + (floors - 1) * F + 8], 0.3, { mat: fe });
  // The roof: the platform's logo in neon on a frame at the front, a water tank and an aerial behind.
  const logo = LOGOS[kind];
  if (logo) {
    const ly = front - 3;
    const lz = tall + 15;
    for (const x of [-10, 10]) m.box(x, ly - 0.6, tall + 2, 0.4, 0.4, 2.4, { mat: fe });
    m.box(0, ly - 0.6, lz, 13, 0.25, 12, {
      mat: (h, out) => {
        out.dither = 0;
        const lit = logo(h.x, h.z - lz);
        if (lit) {
          out.ramp = lit.ramp;
          out.tone = lit.tone;
          out.glow = 1;
          return;
        }
        out.ramp = R.black;
        out.tone = frac(h.x / 3) < 0.12 || frac(h.z / 3) < 0.12 ? 0.3 : -0.6;
      },
      cast: false,
    });
  }
  roofGear(m, seed % 2 ? -12 : 12, tall);
}

/**
 * A street building's walls: on its front, floors of flats over the street floor (a cornice line
 * per floor, windows, most dark, a few lit warm, the odd one cyan); narrow windows down its sides.
 */
export function buildingWall(seed: number, half: number, back: number, frontFrom = SHOP_GROUND) {
  return (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    out.ramp = seed % 2 ? R.hqWallViolet : R.hqWall;
    out.tone = h.nz > 0.5 ? 0.6 : h.ny > 0.5 ? 0.2 : -0.6;
    const level = (h.z - SHOP_GROUND) / SHOP_FLOOR;
    if (h.ny > 0.5 && h.z > frontFrom) {
      if (frac(level) < 0.05) {
        out.tone = 0.8;
        return;
      }
      const col = (h.x + half) / 9.25;
      const wx = frac(col);
      const wz = frac(level);
      if (wx > 0.22 && wx < 0.78 && wz > 0.28 && wz < 0.82) {
        const n = hash2(Math.floor(col) + seed, Math.floor(level));
        out.ramp = n > 0.78 ? R.amber : n > 0.7 ? R.neonCyan : R.hqWall;
        out.tone = n > 0.7 ? -1.1 + (wz > 0.7 ? -0.3 : 0) : -0.9;
        out.glow = n > 0.7 ? 0.5 : 0;
        // Window frames.
        if (wx < 0.27 || wx > 0.73 || wz < 0.33) out.tone += 0.6;
      }
    } else if (Math.abs(h.nx) > 0.5 && h.z > SHOP_GROUND && frac(level) > 0.35 && frac(level) < 0.75 && frac((h.y - back) / 8) < 0.4) {
      const n = hash2(Math.floor(h.y / 8) + seed, Math.floor(level));
      if (n > 0.5) {
        out.ramp = R.amber;
        out.tone = -1;
        out.glow = 0.5;
      }
    }
  };
}

/** A street building's roof gear: a water tank on legs (at `tx`), an aerial with a blinking light. */
export function roofGear(m: Model, tx: number, tall: number) {
  const fe = (h: HitInfo, out: ShadeOut) => ((out.dither = 0), (out.ramp = R.hqMetal), (out.tone = h.nz > 0.5 ? 0.8 : 0.1));
  const wt = (h: HitInfo, out: ShadeOut) => ((out.dither = 0), (out.ramp = R.woodDark), (out.tone = h.nz > 0.5 ? 0.4 : frac(Math.atan2(h.ly, h.lx) * 2) < 0.15 ? -0.8 : 0));
  for (const dx of [-2.5, 2.5]) m.capsule([tx + dx, -16, tall + 1.6], [tx + dx, -16, tall + 6], 0.35, { mat: fe });
  m.cylinder(tx, -16, tall + 10.5, 4.4, 4.5, { mat: wt });
  m.frustum(tx, -16, tall + 16, 4.6, 0.3, 1.2, { mat: fe });
  m.capsule([-tx, -12, tall + 1.6], [-tx, -12, tall + 30], 0.3, { mat: fe });
  m.sphere(-tx, -12, tall + 30.4, 0.7, { mat: neon(R.magenta, 0.8) });
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
 * A round command table with the Adtopia mark glowing over it. Round its rim, one light per station in
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
  // The projector and the Adtopia mark: an N of light over the middle.
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
  m.capsule([0, 0, 0], [0, 0, 41], 0.7, { mat: metal(0.5) });
  m.box(0, 0, 1, 2, 2, 1, { mat: metal(0.3) });
  m.capsule([0, 0, 41], [0, -12, 44], 0.55, { mat: metal(0.8) });
  m.box(0, -12.75, 43.2, 2.7, 3.7, 1, { mat: metal(0.6) });
  m.box(0, -12.75, 42, 2.2, 3.2, 0.15, { mat: neon(ramp, 0.6), cast: false });
  // A neon ring round the pole a little over an agent's head.
  m.cylinder(0, 0, 24, 1.1, 0.8, { mat: neon(ramp, 0.2), cast: false });
}

const CAR_COLOURS = [
  [R.hqPurple, R.neonPink],
  [R.navy, R.neonCyan],
  [R.black, R.amber],
  [R.white, R.neonBlue],
] as const;

/** A hover car along +x (`v` picks its paint and its neon), floating over a glow. */
export function hoverCar(m: Model, v: number) {
  const k = 1.7;
  const [paint, glow] = CAR_COLOURS[v % CAR_COLOURS.length];
  const body = (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    out.ramp = paint;
    out.tone = h.nz > 0.5 ? 1 : 0.3;
  };
  m.box(0, 0, 3.2 * k, 8 * k, 3.6 * k, 1.4 * k, { mat: body, clip: [1, 0, 0.6, 8.2 * k] });
  // The cabin: tinted glass with a lit edge.
  m.box(-1 * k, 0, 5.4 * k, 4.2 * k, 3 * k, 1.1 * k, {
    mat: (h, out) => {
      out.dither = 0;
      out.ramp = R.neonCyan;
      out.tone = h.nz > 0.5 ? -1.6 : -2.2;
      out.glow = 0.3;
    },
    clip: [1, 0, 1, 4.6 * k],
  });
  // Head- and tail-lights, the skirt glowing underneath.
  m.box(8.1 * k, 0, 3.4 * k, 0.2, 2.8 * k, 0.35 * k, { mat: neon(R.white, 1.4), cast: false });
  m.box(-8.1 * k, 0, 3.4 * k, 0.2, 3 * k, 0.35 * k, { mat: neon(R.magenta, 0.6), cast: false });
  m.box(0, 0, 1.6 * k, 7 * k, 3.2 * k, 0.25, { mat: neon(glow, 0.2), cast: false });
}

// ----------------------------------------------------------------------------------------------
// What makes each station readable at a glance.

/**
 * The research desk's city map (research, 1): a huge screen on the right wall (its face at y -9.2,
 * facing +y) with the street drawn on it and a pin for each shop the scouts ride to, blinking in
 * turn; under it the operators' long desk with three monitors and two chairs.
 */
export function mapScreen(m: Model, frame: number) {
  const W = 27;
  const z0 = 12;
  const z1 = 64;
  m.box(0, -9.4, (z0 + z1) / 2, W + 1, 0.4, (z1 - z0) / 2 + 1, { mat: matte(R.black, 0.5) });
  m.box(0, -8.95, (z0 + z1) / 2, W, 0.05, (z1 - z0) / 2, {
    mat: (h, out) => {
      out.dither = 0;
      out.glow = 1;
      out.ramp = R.neonBlue;
      out.tone = -2.2;
      const u = h.lx / 2;
      const v = (h.lz - (z0 + z1) / 2) / 2;
      // Blocks of the city, the street along the middle, side streets.
      if (frac(u / 3) > 0.08 && frac(v / 3) > 0.1 && Math.abs(v + 1.5) > 0.9) out.tone = hash2(Math.floor(u / 3), Math.floor(v / 3)) > 0.5 ? -1.8 : -2.4;
      if (Math.abs(v + 1.5) < 0.5 || Math.abs(frac((u + 13) / 6.5) - 0.5) < 0.05) {
        out.ramp = R.neonCyan;
        out.tone = -1;
      }
      // Ten pins along the street, one lit brighter each frame, with a pulse ring.
      for (let i = 0; i < 10; i++) {
        const px = -12 + i * 2.65;
        const py = 1.6 + (i % 2) * 1.6;
        const d = Math.hypot(u - px, v - py);
        if (d < 0.75) {
          out.ramp = [R.neonPink, R.neonCyan, R.amber][i % 3];
          out.tone = (i + frame) % 4 === 0 ? 1.2 : 0;
        } else if ((i + frame) % 4 === 0 && Math.abs(d - 1.4) < 0.15) {
          out.ramp = R.white;
          out.tone = -0.6;
        }
      }
      // The HQ: a pink square at the left end.
      if (Math.abs(u + 11) < 0.9 && Math.abs(v + 3.6) < 0.9) {
        out.ramp = R.neonPink;
        out.tone = 0.8;
      }
      // A header bar.
      if (v > 11.4) {
        out.ramp = R.neonCyan;
        out.tone = frac(u / 1.2) < 0.5 ? -0.6 : -1.4;
      }
    },
    cast: false,
  });
  m.box(0, -8.9, z1 + 1.6, W, 0.06, 0.2, { mat: neon(R.neonCyan, 0), cast: false });
  // The operators' desk along the wall, its monitors, keyboards and two chairs.
  m.box(0, -4.6, 7.2, W - 2, 3.4, 0.4, { mat: metal(0.6) });
  for (const x of [-W + 3, 0, W - 3]) m.box(x, -4.6, 3.4, 0.4, 3, 3.4, { mat: metal(0.1) });
  m.box(0, -1.15, 7.2, W - 2, 0.06, 0.15, { mat: neon(R.neonBlue, 0), cast: false });
  // Four monitors in a row, the two in the middle on a stand above the others; keyboards and a mouse.
  for (const [x, z, kind] of [
    [-19, 10.4, "chart"],
    [-12, 12.2, "text"],
    [-5, 12.2, "feed"],
    [2, 10.4, "chart"],
    [12, 10.4, "text"],
  ] as const) {
    m.box(x, -6.6, z, 3.2, 0.4, 2.2, { mat: matte(R.black, 0.5) });
    m.box(x, -6.15, z, 2.9, 0.05, 1.9, { mat: cyberScreen(1, frame * 0.25 + x * 0.01, kind) });
  }
  m.capsule([-8.5, -6.8, 7.6], [-8.5, -6.8, 10], 0.35, { mat: metal(0.8) });
  for (const x of [-12, 8]) m.box(x, -3, 7.75, 2.4, 0.8, 0.12, { mat: (h, out) => ((out.dither = 0), (out.ramp = R.black), (out.tone = h.nz > 0.5 && frac(h.lx * 1.6) < 0.3 ? 0.2 : 1)) });
  m.box(-12, -3.05, 7.62, 2.5, 0.9, 0.04, { mat: neon(R.neonPink, -0.6), cast: false });
  // A stack of data boxes and a mug at the desk's left end.
  m.box(-22, -5, 8.6, 1.6, 1.4, 1, { mat: matte(R.amber, -0.6) });
  m.box(-22, -5, 10.3, 1.3, 1.2, 0.7, { mat: matte(R.amber, -0.2) });
  m.cylinder(-17, -2.6, 8.1, 0.5, 0.5, { mat: matte(R.neonCyan, -0.6) });
  // The operator's chair, and a spare one.
  officeChair(m, -12, 2, 6, R.neonBlue);
  officeChair(m, 6, 2.4, 6, R.neonBlue);
}

/**
 * The film set (production, 4), in front of the studio's green walls: a hologram of the AI presenter
 * on its mark, a camera on a dolly track with its red REC light and a monitor, a ring light, and
 * two soft boxes on stands either side. Faces +x+y, toward the room.
 */
export function filmSet(m: Model, frame: number) {
  m.with(rotZ(Math.PI / 4), () => {
    // The mark, and the presenter standing on it: a hologram.
    m.cylinder(0, 0, 0.08, 3.2, 0.08, { mat: neon(R.neonPink, -0.6), cast: false });
    m.capsule([0, 0, 1], [0, 0, 8.6], 1.6, { mat: neon(R.neonCyan, -1.2), cast: false });
    m.sphere(0, 0, 11, 1.8, { mat: neon(R.neonCyan, -0.8), cast: false });
    m.box(0, 0, 6 + (frame % 4) * 1.5, 1.7, 1.7, 0.08, { mat: neon(R.white, 0.4), cast: false });
    // The dolly track and the camera on it, looking at the mark.
    for (const y of [-2.2, 2.2]) m.box(16, y, 0.25, 6, 0.3, 0.25, { mat: metal(0.9) });
    for (let x = 11; x <= 21; x += 2.5) m.box(x, 0, 0.12, 0.3, 2.6, 0.12, { mat: metal(0.2) });
    m.box(15 + (frame % 4) * 0.6, 0, 1.4, 2.6, 2.2, 0.9, { mat: metal(0.4) });
    const cx = 15 + (frame % 4) * 0.6;
    m.capsule([cx, 0, 2.2], [cx, 0, 9], 0.4, { mat: metal(0.8) });
    m.box(cx, 0, 10.8, 2.6, 1.5, 1.7, { mat: matte(R.black, 0.6) });
    m.cylinder(cx - 3.2, 0, 10.8, 1.1, 0.9, { mat: matte(R.black, 1.2), rot: rotY(Math.PI / 2) });
    m.sphere(cx - 0.6, 1.4, 12.8, 0.45, { mat: neon(frame % 2 ? R.magenta : R.black, 0.6) });
    m.box(cx + 2.8, -1.6, 11.6, 0.1, 1.2, 0.9, { mat: cyberScreen(1, frame * 0.25, "feed") });
    // A ring light behind the camera, and soft boxes either side of the mark.
    m.capsule([20, 4, 0], [20, 4, 14], 0.25, { mat: metal(0.8) });
    m.cylinder(20, 4, 16, 2.6, 0.25, { mat: neon(R.white, 0.4), rot: rotY(Math.PI / 2), carve: m.cutter((c) => c.cylinder(20, 4, 16, 1.8, 1, { mat: 0, rot: rotY(Math.PI / 2) })) });
    for (const y of [-11, 11]) {
      m.capsule([7, y, 0], [7, y, 16], 0.25, { mat: metal(0.8) });
      m.box(6.4, y, 17.5, 1.6, 2.6, 2.1, { mat: matte(R.black, 0.5), rot: rotZ(y > 0 ? 0.7 : -0.7) });
      m.box(5.1, y * 0.94, 17.5, 0.1, 2.3, 1.8, { mat: lamp, rot: rotZ(y > 0 ? 0.7 : -0.7), cast: false });
    }
  });
}

/**
 * The render servers (production, 4): a row of five tall racks against the mezzanine's face, their
 * fronts facing +y, lights blinking as they work, a cable tray and a cyan strip along the top.
 */
export function renderFarm(m: Model, frame: number) {
  for (let i = 0; i < 5; i++) m.box(-13.6 + i * 6.8, 0, 19, 3.2, 3, 19, { mat: rackMat(frame + i) });
  m.box(0, 0, 38.6, 17.4, 3.2, 0.6, { mat: metal(0.6) });
  m.box(0, 3.2, 38.6, 17, 0.1, 0.18, { mat: neon(R.neonCyan, 0), cast: false });
  for (let i = 0; i < 5; i++) m.box(-13.6 + i * 6.8, 3.08, 36, 2.6, 0.06, 0.3, { mat: neon(i % 2 ? R.jade : R.neonCyan, 0.2), cast: false });
}

/** The analytics board (publishing, 6): a big screen on legs facing +x+y, a chart climbing. */
export function dashboard(m: Model, frame: number) {
  m.with(rotZ(Math.PI / 4), () => {
    for (const y of [-8, 8]) m.box(0, y, 7, 0.5, 0.5, 7, { mat: metal(0.4) });
    m.box(0, 0, 18, 0.8, 10, 6.5, { mat: matte(R.black, 0.5) });
    m.box(0.85, 0, 18, 0.05, 9.4, 5.9, { mat: cyberScreen(1, frame * 0.25, "chart") });
    m.box(0.9, 0, 25, 0.06, 9.4, 0.2, { mat: neon(R.neonPink, 0), cast: false });
  });
}

/** The broadcast mast (publishing, 6): a tall lattice with three dishes aimed up at the street. */
export function broadcastMast(m: Model, frame: number) {
  for (const x of [-2.5, 2.5]) for (const y of [-2.5, 2.5]) m.capsule([x * 1.4, y * 1.4, 0], [x * 0.4, y * 0.4, 40], 0.35, { mat: metal(0.6) });
  for (let z = 6; z < 40; z += 6) m.box(0, 0, z, 3.2 - z * 0.06, 3.2 - z * 0.06, 0.2, { mat: metal(0.4) });
  for (const [z, a] of [
    [20, -0.6],
    [28, 0.1],
    [35, 0.8],
  ] as const) {
    m.with(mul(mul(translate(0, 0, z), rotZ(a)), rotY(-0.9)), () => {
      m.ellipsoid(-2.5, 0, 0, 2.2, 2.2, 0.8, { mat: matte(R.white, 0.4), clip: [0, 0, -1, 0.1] });
    });
  }
  m.sphere(0, 0, 41, 0.7, { mat: neon(frame % 2 ? R.magenta : R.amber, 0.8) });
}

/** A billboard frame on posts (the platforms' screens on the street): the picture is painted live. */
export function billboard(m: Model) {
  for (const x of [-7.5, 7.5]) m.box(x, 0, 14, 0.5, 0.5, 14, { mat: metal(0.4) });
  m.box(0, 0, 32, 8, 0.6, 11, { mat: matte(R.black, 0.5) });
  m.box(0, 0.65, 43.4, 8, 0.1, 0.25, { mat: neon(R.neonCyan, 0.2), cast: false });
  m.box(0, 0.65, 20.6, 8, 0.1, 0.25, { mat: neon(R.neonCyan, 0.2), cast: false });
}
