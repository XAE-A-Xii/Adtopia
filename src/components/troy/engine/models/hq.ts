import { solid } from "../materials";
import { R } from "../palette";
import { hash2, type HitInfo, Model, mul, rotX, rotY, rotZ, type ShadeOut, translate } from "../tracer";
import { textPixel, textWidth } from "../font";
import { buildingWall, roofGear } from "./cyber";
import { CAR_LANES, DECK, ENTRANCE, FAR_KERB, HQ_SIGN, INNER, KERB, ROOM, STAIRS, STATION, STREET_LANE, STUDIO, VIDEO_WALL } from "../../scenes/layout";
import { LADDER } from "../../scenes/stations";

// The underground HQ's shell: the basement's floor and its two back walls (the front walls and the
// ceiling are cut away, like a dollhouse), the stairs down from the street, and the slice of the
// street above them. World coordinates, so the room bakes as one ground layer behind everything.

const frac = (v: number) => v - Math.floor(v);

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

/**
 * The street, from the HQ's wall outward: pavement slabs, the kerb, a cyan bike lane with bike
 * marks, two lanes of traffic split by a dashed amber line, a parking lane with bay marks, the far
 * kerb and the shops' pavement.
 */
function streetMat(h: HitInfo, out: ShadeOut) {
  out.dither = 0;
  out.ramp = R.hqAsphalt;
  if (h.nz < 0.5) {
    out.ramp = R.hqWallViolet;
    out.tone = -0.8;
    return;
  }
  const slabs = (y0: number) => {
    out.ramp = R.hqWall;
    const slab = frac(h.x / 10) < 0.08 || frac((h.y - y0) / 12) < 0.1;
    out.tone = slab ? -0.6 : 0.4;
  };
  if (h.y > KERB) {
    slabs(KERB);
    if (h.y < KERB + 1.4) out.tone = 1;
    return;
  }
  if (h.y < FAR_KERB) {
    slabs(FAR_KERB);
    if (h.y > FAR_KERB - 1.4) out.tone = 1;
    return;
  }
  out.tone = hash2(Math.floor(h.x * 1.3), Math.floor(h.y * 1.3)) > 0.9 ? 0.3 : 0;
  const bikeEdge = STREET_LANE - 7;
  if (h.y > bikeEdge) {
    // The bike lane: tinted, its edge a dashed cyan line, a bike mark every 46.
    out.ramp = R.hqWall;
    out.tone = -0.4;
    if (h.y < bikeEdge + 0.8 && frac(h.x / 8) < 0.6) {
      out.ramp = R.neonCyan;
      out.tone = -0.6;
      out.glow = 0.5;
    }
    const mx = frac((h.x + 10) / 46) * 46 - 23;
    const my = h.y - STREET_LANE;
    if (Math.abs(mx) < 4 && Math.abs(my) < 2.2 && (Math.abs(Math.hypot(mx - 2.4, my) - 1.3) < 0.3 || Math.abs(Math.hypot(mx + 2.4, my) - 1.3) < 0.3)) {
      out.ramp = R.neonCyan;
      out.tone = -0.4;
      out.glow = 0.5;
    }
    return;
  }
  // Two lanes: a dashed line down the middle (the bike lane's edge and the parking lane's line
  // mark the sides).
  const middle = (CAR_LANES[0].y + CAR_LANES[1].y) / 2;
  if (Math.abs(h.y - middle) < 0.6 && frac(h.x / 18) < 0.5) {
    out.ramp = R.amber;
    out.tone = 0.2;
  }
  // The parking lane: short white bay marks off the far kerb.
  const parking = CAR_LANES[1].y - 10;
  if (h.y < parking && frac(h.x / 14) < 0.05) {
    out.ramp = R.white;
    out.tone = -1.6;
  }
  if (Math.abs(h.y - parking) < 0.4) {
    out.ramp = R.white;
    out.tone = -1.8;
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


// ----------------------------------------------------------------------------------------------
// The two floors: surfaces and the flow line.

/**
 * Lamps (world points), each with the floor it lights (`fx`, `fy` on the level at `level`): warm
 * pools under them, and glow.
 */
export function wallLamps() {
  const { x0, y0 } = ROOM;
  const up = DECK.z;
  const face = x0 + DECK.depth;
  return [
    // Over the upper floor: between the phone wall and the storyboards, and past the wall map.
    { x: x0 + 1.6, y: y0 + 101, z: up + 40, fx: x0 + 16, fy: y0 + 101, level: up },
    { x: x0 + 184, y: y0 + 1.6, z: up + 40, fx: x0 + 184, fy: y0 + 16, level: up },
    // On the mezzanine's faces over the ground floor: by the editing bay's end, past the servers.
    { x: face + 1.6, y: y0 + 232, z: 50, fx: face + 16, fy: y0 + 232, level: 0 },
    { x: x0 + 189, y: y0 + DECK.depth + 1.6, z: 50, fx: x0 + 189, fy: y0 + DECK.depth + 16, level: 0 },
  ];
}

/** Where the rugs lie, on either floor: under the stations' furniture and in the nook. */
function rugAt(x: number, y: number, z: number): { ramp: number; border: boolean; stripe?: boolean } | null {
  const box = (cx: number, cy: number, hx: number, hy: number) => Math.abs(x - cx) < hx && Math.abs(y - cy) < hy;
  const edge = (cx: number, cy: number, hx: number, hy: number) => !box(cx, cy, hx - 1.4, hy - 1.4);
  const rug = (cx: number, cy: number, hx: number, hy: number, ramp: number, stripe = false) => (box(cx, cy, hx, hy) ? { ramp, border: edge(cx, cy, hx, hy), stripe } : null);
  if (z > 0) {
    const tent = STATION.tent;
    const oracle = STATION.oracle;
    const scouts = STATION.scouts;
    // Under the writer's desk and the cork board, under the format table, in front of the map desk.
    return rug(tent.x - 24, tent.y - 18, 18, 26, R.neonPink, true) ?? rug(oracle.x - 6, oracle.y - 2, 24, 18, R.neonCyan) ?? rug(scouts.x - 2, scouts.y - 22, 30, 16, R.neonBlue, true);
  }
  // Under the screening sofas, the editing bay, the publishing corner (uplink, board and mast) and the coffee nook.
  const lounge = STATION.theatre;
  const bay = STATION.workshop;
  const agora = STATION.agora;
  return (
    rug(lounge.x - 6, lounge.y + 2, 34, 30, R.amber) ??
    rug(bay.x - 41, bay.y + 22, 21, 28, R.neonPink, true) ??
    rug(agora.x - 2, agora.y - 2, 32, 30, R.neonBlue, true) ??
    rug(ROOM.x0 + 72, ROOM.y1 - 46, 22, 12, R.amber, true)
  );
}

/** A warm pool under a lamp on this level, stepped in rings. */
function pool(h: HitInfo, z: number, out: ShadeOut, dark: boolean) {
  for (const lamp of wallLamps()) {
    if (Math.abs(lamp.level - z) > 0.5) continue;
    // The light warms the floor's own colour, brightest under the lamp.
    const d = Math.hypot(h.x - lamp.fx, h.y - lamp.fy);
    if (d < 18) {
      out.tone += (d < 7 ? 0.7 : d < 12 ? 0.45 : 0.2) * (dark ? 0.5 : 1);
      return true;
    }
  }
  return false;
}

/** True inside the studio's green sweep on the ground floor. */
function inStudio(x: number, y: number) {
  return x > STUDIO.x && x < STUDIO.x + STUDIO.size && y > STUDIO.y && y < STUDIO.y + STUDIO.size;
}

/** Chroma green with tracking marks: a small cross every 9 units, in pink. */
function chroma(u: number, v: number, out: ShadeOut, base: number) {
  out.dither = 0;
  out.ramp = R.jade;
  out.tone = base;
  const cu = frac(u / 9);
  const cv = frac(v / 9);
  if ((Math.abs(cu - 0.5) < 0.05 && Math.abs(cv - 0.5) < 0.14) || (Math.abs(cv - 0.5) < 0.05 && Math.abs(cu - 0.5) < 0.14)) {
    out.ramp = R.neonPink;
    out.tone = 0.2;
    out.glow = 0.6;
  }
}

/** The ground floor: dark stained planks, rugs, the studio's green sweep, the flow line. */
function floorTiles(h: HitInfo, out: ShadeOut) {
  out.ramp = R.woodDark;
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
  if (inStudio(h.x, h.y)) {
    // The sweep is lighter where it curves up into the walls.
    const near = Math.min(h.x - STUDIO.x, h.y - STUDIO.y);
    chroma(h.x, h.y, out, near < 4 ? 0.4 : -0.1);
    if (h.x > STUDIO.x + STUDIO.size - 1.2 || h.y > STUDIO.y + STUDIO.size - 1.2) {
      out.ramp = R.white;
      out.tone = -0.4;
    }
    return;
  }
  const rug = rugAt(h.x, h.y, 0);
  if (rug) {
    out.ramp = rug.border ? rug.ramp : R.hqPurple;
    out.tone = rug.border ? -0.6 : rug.stripe && frac((h.x - h.y) / 6) < 0.2 ? -0.1 : frac((h.x + h.y) / 4) < 0.5 ? -0.3 : -0.8;
    out.glow = rug.border ? 0.6 : 0;
    return;
  }
  // Planks along x, staggered joints, a little grain.
  const row = Math.floor(h.y / 5);
  const shift = hash2(row, 3) * 26;
  const board = Math.floor((h.x + shift) / 26);
  const seam = frac(h.y / 5) < 0.14;
  const joint = frac((h.x + shift) / 26) < 0.03;
  const n = hash2(board, row);
  out.tone = seam || joint ? -1.6 : -0.7 + n * 0.6 + (frac(h.x / 3.3 + n * 7) < 0.12 ? -0.25 : 0);
  pool(h, 0, out, seam);
}

/** The mezzanine's top: steel floor plates, rugs at the stations, the flow line; its sides are brick. */
function deckMat(h: HitInfo, out: ShadeOut) {
  out.dither = 0;
  out.ramp = R.hqWallViolet;
  if (h.nz < -0.5) {
    out.tone = -1.4;
    return;
  }
  if (h.nz < 0.5) return mezzanineWall(h, out);
  const rug = rugAt(h.x, h.y, DECK.z);
  if (rug) {
    out.ramp = rug.border ? rug.ramp : R.hqPurple;
    out.tone = rug.border ? -0.6 : rug.stripe && frac((h.x + h.y) / 5) < 0.25 ? -0.1 : -0.6;
    out.glow = rug.border ? 0.6 : 0;
    return;
  }
  const plate = frac(h.x / 16) < 0.04 || frac(h.y / 16) < 0.04;
  out.tone = plate ? -0.6 : 0.4 + (hash2(Math.floor(h.x / 16), Math.floor(h.y / 16)) > 0.8 ? 0.25 : 0);
  pool(h, DECK.z, out, plate);
}

/** The mezzanine's faces down to the ground floor: dark brick, a steel lip with a neon line, a baseboard. */
function mezzanineWall(h: HitInfo, out: ShadeOut) {
  out.dither = 0;
  const u = Math.abs(h.nx) > 0.5 ? h.y : h.x;
  if (h.z > DECK.z - 3) {
    out.ramp = R.hqMetal;
    out.tone = h.z > DECK.z - 0.8 ? 1 : 0.2;
    return;
  }
  if (h.z > DECK.z - 4) {
    out.ramp = R.neonCyan;
    out.tone = -0.2;
    out.glow = 1;
    return;
  }
  if (h.z < 2.4) {
    out.ramp = R.hqMetal;
    out.tone = h.z > 2 ? 0.6 : -0.4;
    return;
  }
  const course = Math.floor(h.z / 3);
  const brick = Math.floor((u + (course % 2) * 4) / 8);
  const mortar = frac(h.z / 3) < 0.16 || frac((u + (course % 2) * 4) / 8) < 0.06;
  out.ramp = R.tile;
  out.tone = mortar ? -3.2 : -2 + hash2(brick, course) * 0.7 - (h.z < 20 ? 0 : (h.z - 20) / 60);
}

// ----------------------------------------------------------------------------------------------
// The shell: floor, walls, the mezzanine, both stairs, the video wall's frame and the street.

/** Open metal stairs between two points: treads on two stringers, a light under every nosing. */
function stairs(m: Model, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, width: number, steps: number, railSide: 1 | -1) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const run = Math.hypot(dx, dy);
  const along = Math.atan2(dy, dx);
  m.with(mul(translate(from.x, from.y, 0), rotZ(along)), () => {
    const rise = to.z - from.z;
    const angle = Math.atan2(-rise, run);
    const length = Math.hypot(rise, run);
    for (const side of [-1, 1]) {
      m.with(mul(translate(run / 2, side * (width / 2 - 0.7), (from.z + to.z) / 2 - 1.6), rotY(angle)), () => {
        m.box(0, 0, 0, length / 2, 0.7, 2.2, { mat: (h, out) => ((out.dither = 0), (out.ramp = R.hqMetal), (out.tone = h.nz > 0.5 ? 0.9 : 0.3)) });
      });
    }
    const tread = run / steps;
    for (let i = 0; i < steps; i++) {
      const top = from.z + (rise * (i + 0.5)) / steps;
      m.box((i + 0.5) * tread, 0, top - 0.7, tread / 2 + 0.6, width / 2 - 1.4, 0.7, { mat: stepMat2 });
      m.box((i + 1) * tread, 0, top - 1.5, 0.12, width / 2 - 2.5, 0.12, { mat: neon(i % 2 ? R.neonCyan : R.neonBlue, 0), cast: false });
    }
    // The handrail on the open side, a glow strip under it, and its posts.
    const ry = railSide * (width / 2 - 0.6);
    m.capsule([0, ry, from.z + 9], [run, ry, to.z + 9], 0.5, { mat: (_h, out) => ((out.ramp = R.hqMetal), (out.tone = 0.9), (out.dither = 0)) });
    m.capsule([0, ry, from.z + 5], [run, ry, to.z + 5], 0.35, { mat: neon(R.neonCyan, 0.3), cast: false });
    for (let i = 0; i <= steps; i += 2) {
      const x = (i / steps) * run;
      const base = from.z + (rise * i) / steps;
      m.box(x, ry, base + 4.5, 0.35, 0.35, 4.5, { mat: (_h, out) => ((out.ramp = R.hqMetal), (out.tone = 0.3), (out.dither = 0)) });
    }
  });
}

function stepMat2(h: HitInfo, out: ShadeOut) {
  out.ramp = R.hqMetal;
  out.dither = 0;
  out.tone = h.nz > 0.5 ? (frac((h.lx + 40) / 1.6) < 0.3 ? -0.2 : 0.5) : h.nz < -0.5 ? -1 : -0.4;
}

/** A built step or landing: concrete faces, a steel nosing, the tread lit at its edge. */
function solidStepMat(h: HitInfo, out: ShadeOut) {
  out.dither = 0;
  out.ramp = R.hqWallViolet;
  if (h.nz > 0.5) {
    out.ramp = R.hqMetal;
    out.tone = frac(h.y / 1.6) < 0.3 ? 0 : 0.6;
    return;
  }
  out.tone = h.nx > 0.5 ? -0.6 : -0.2;
}

/**
 * The inner stairs: the first flight built solid against the left wall, down to a landing in the
 * front corner, then the second flight in open steel along the front edge to the ground floor.
 */
function innerStairsModel(m: Model) {
  const { x, top, width, turn, footX, steps1, steps2 } = INNER;
  const x0 = x - width / 2;
  const x1 = x + width / 2;
  const end = turn.y - turn.half;
  const tread = (end - top) / steps1;
  const drop = (DECK.z - turn.z) / steps1;
  for (let i = 0; i < steps1; i++) {
    const z = DECK.z - drop * (i + 1);
    const y = top + tread * (i + 0.5);
    m.box(x, y, z / 2, width / 2, tread / 2, z / 2, { mat: solidStepMat });
    // A strip of light under each nosing.
    m.box(x1 + 0.05, top + tread * i + 0.4, z - 0.6, 0.05, 0.3, 0.2, { mat: neon(R.neonCyan, 0), cast: false });
    m.box(x, top + tread * (i + 1) - 0.1, z - 1.2, width / 2 - 1, 0.1, 0.15, { mat: neon(i % 2 ? R.neonCyan : R.neonBlue, 0), cast: false });
  }
  // The landing in the corner.
  m.box(turn.x, turn.y, turn.z / 2, turn.half, turn.half, turn.z / 2, { mat: solidStepMat });
  m.box(turn.x + turn.half + 0.05, turn.y - turn.half + 4, turn.z / 2, 0.05, 2.4, turn.z / 2 - 3, { mat: neon(R.neonPink, -1), cast: false });
  // The second flight, open steel, the rail on the room's open front.
  stairs(m, { x: turn.x + turn.half, y: turn.y, z: turn.z }, { x: footX, y: turn.y, z: 0 }, width, steps2, 1);
  // Rails: down the first flight's open side and along the landing's front edge.
  const rail = (_h: HitInfo, out: ShadeOut) => ((out.dither = 0), (out.ramp = R.hqMetal), (out.tone = 0.9));
  m.capsule([x1 - 0.6, top, DECK.z + 9], [x1 - 0.6, end, turn.z + 9], 0.5, { mat: rail });
  m.capsule([x1 - 0.6, top, DECK.z + 5], [x1 - 0.6, end, turn.z + 5], 0.35, { mat: neon(R.neonCyan, 0.3), cast: false });
  for (let i = 0; i <= steps1; i += 2) m.box(x1 - 0.6, top + tread * i, DECK.z - drop * i + 4.5, 0.35, 0.35, 4.5, { mat: rail });
  const fy = ROOM.y1 - 0.6;
  m.capsule([ROOM.x0 + 1, fy, turn.z + 9], [turn.x + turn.half, fy, turn.z + 9], 0.5, { mat: rail });
  m.capsule([ROOM.x0 + 1, fy, turn.z + 5], [turn.x + turn.half, fy, turn.z + 5], 0.35, { mat: neon(R.neonCyan, 0.3), cast: false });
  for (const px of [ROOM.x0 + 2, turn.x + turn.half - 0.5]) m.box(px, fy, turn.z + 4.5, 0.35, 0.35, 4.5, { mat: rail });
}

/**
 * The L-shaped mezzanine, built solid: two blocks along the back walls from the floor to the deck,
 * glass rails with a neon top along every open edge, and fairy lights strung along them.
 */
function deck(m: Model) {
  const { x0, y0 } = ROOM;
  const { z, depth, leftY1, rightX1 } = DECK;
  m.box(x0 + depth / 2, (y0 + leftY1) / 2, z / 2, depth / 2, (leftY1 - y0) / 2, z / 2, { mat: deckMat });
  m.box((x0 + depth + rightX1) / 2, y0 + depth / 2, z / 2, (rightX1 - x0 - depth) / 2, depth / 2, z / 2, { mat: deckMat });
  const glass = (_h: HitInfo, out: ShadeOut) => ((out.dither = 0), (out.ramp = R.neonCyan), (out.tone = -2.4), (out.glow = 0.25));
  const rail = (ax: number, ay: number, bx: number, by: number) => {
    const cx = (ax + bx) / 2;
    const cy = (ay + by) / 2;
    const hx = Math.max(0.15, Math.abs(bx - ax) / 2);
    const hy = Math.max(0.15, Math.abs(by - ay) / 2);
    m.box(cx, cy, z + 3.5, hx, hy, 3.5, { mat: glass, cast: false });
    m.box(cx, cy, z + 7.1, hx + 0.1, hy + 0.1, 0.18, { mat: neon(R.neonPink, 0.2), cast: false });
    // Fairy lights hung in loops under the rail's top.
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.floor(len / 5);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const sag = Math.sin(frac(t * (len / 20)) * Math.PI) * 2;
      m.sphere(ax + (bx - ax) * t, ay + (by - ay) * t, z + 6.4 - sag, 0.42, { mat: neon(i % 3 === 0 ? R.neonPink : R.amber, 0.8), cast: false });
    }
  };
  rail(x0 + depth - 0.3, y0 + depth, x0 + depth - 0.3, leftY1);
  rail(x0 + depth, y0 + depth - 0.3, rightX1, y0 + depth - 0.3);
  rail(rightX1 - 0.3, y0 + STAIRS.width + 4, rightX1 - 0.3, y0 + depth);
  rail(INNER.x + INNER.width / 2 + 1, leftY1 - 0.3, x0 + depth, leftY1 - 0.3);
}

/**
 * The green-screen studio in the mezzanine's inner corner: the two faces hung with chroma green
 * (the floor's sweep is painted with the floor), lights clamped to the deck's edge over it, and an
 * ON AIR sign above.
 */
function studio(m: Model) {
  const { x, y, size, tall } = STUDIO;
  m.box(x + 0.3, y + size / 2, tall / 2, 0.3, size / 2, tall / 2, { mat: (h, out) => chroma(h.y, h.z, out, h.nx > 0.5 ? 0.2 : -1), cast: false });
  m.box(x + size / 2, y + 0.3, tall / 2, size / 2, 0.3, tall / 2, { mat: (h, out) => chroma(h.x, h.z, out, h.ny > 0.5 ? -0.1 : -1), cast: false });
  // The cove where the walls meet the floor, lit a touch brighter.
  m.box(x + 1, y + size / 2, 0.6, 1, size / 2, 0.6, { mat: (h, out) => chroma(h.y, 0, out, 0.6), cast: false });
  m.box(x + size / 2, y + 1, 0.6, size / 2, 1, 0.6, { mat: (h, out) => chroma(h.x, 0, out, 0.4), cast: false });
  // Spotlights on the deck's edge, angled down into the studio.
  const light = (lx: number, ly: number, nx: number, ny: number) => {
    m.box(lx, ly, DECK.z - 1, 0.5, 0.5, 1.2, { mat: solid(R.hqMetal, 0.6, 0) });
    m.box(lx + nx * 1.6, ly + ny * 1.6, DECK.z - 3.2, 1.3, 1.3, 1.1, { mat: matteBlack });
    m.box(lx + nx * 2.95, ly + ny * 2.95, DECK.z - 3.6, nx ? 0.06 : 1, ny ? 0.06 : 1, 0.8, { mat: neon(R.white, 1.2), cast: false });
  };
  for (const ly of [y + 12, y + 30, y + 46]) light(x + 1.2, ly, 1, 0);
  for (const lx of [x + 14, x + 32, x + 48]) light(lx, y + 1.2, 0, 1);
  // ON AIR beside it.
  faceSign(m, "y", y, x + size + 14, 47, "ON AIR", R.magenta, 1);
}

const matteBlack = (h: HitInfo, out: ShadeOut) => ((out.dither = 0), (out.ramp = R.black), (out.tone = h.nz > 0.5 ? 1 : 0.5));

/** The video wall's frame on the open stretch of the right wall: a bezel and a dark screen. */
function videoWallFrame(m: Model) {
  const { x0, x1, z0, z1 } = VIDEO_WALL;
  const y = ROOM.y0;
  m.box((x0 + x1) / 2, y + 0.8, (z0 + z1) / 2, (x1 - x0) / 2 + 2, 0.8, (z1 - z0) / 2 + 2, { mat: solid(R.black, 0.6, 0), cast: false });
  m.box((x0 + x1) / 2, y + 1.65, (z0 + z1) / 2, (x1 - x0) / 2, 0.05, (z1 - z0) / 2, {
    mat: (h, out) => {
      out.dither = 0;
      out.ramp = R.hqWall;
      out.tone = frac(h.z / 2) < 0.5 ? -1.6 : -1.9;
    },
    cast: false,
  });
  // A thin LED rim round it.
  for (const z of [z0 - 1.8, z1 + 1.8]) m.box((x0 + x1) / 2, y + 1.7, z, (x1 - x0) / 2 + 1.8, 0.1, 0.2, { mat: neon(R.neonBlue, 0.2), cast: false });
  for (const x of [x0 - 1.8, x1 + 1.8]) m.box(x, y + 1.7, (z0 + z1) / 2, 0.2, 0.1, (z1 - z0) / 2 + 1.8, { mat: neon(R.neonBlue, 0.2), cast: false });
}

/**
 * A neon sign flat on a face: on the plane x = `plane` facing +x ("x"), or y = `plane` facing +y
 * ("y"); a dark board with its words lit, upright, reading left to right on screen.
 */
function faceSign(m: Model, face: "x" | "y", plane: number, at: number, z: number, text: string, ramp: number, scale = 1) {
  const cols = textWidth(text);
  const half = (cols * scale) / 2 + 1.5;
  const tall = 7 * scale;
  const mat = (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    // On an x face reading left to right on screen runs toward -y; on a y face, +x.
    const u = (face === "x" ? at + (cols * scale) / 2 - h.y : h.x - (at - (cols * scale) / 2)) / scale;
    const v = (z + tall / 2 - h.z) / scale;
    const on = textPixel(text, u, v);
    out.ramp = on ? ramp : R.black;
    out.tone = on ? 0.8 : 0.4;
    out.glow = on ? 1 : 0;
  };
  if (face === "x") {
    m.box(plane + 0.5, at, z, 0.5, half, tall / 2 + 1.5, { mat: solid(R.black, 0.3, 0), cast: false });
    m.box(plane + 1.05, at, z, 0.05, half - 0.5, tall / 2 + 1, { mat, cast: false });
  } else {
    m.box(at, plane + 0.5, z, half, 0.5, tall / 2 + 1.5, { mat: solid(R.black, 0.3, 0), cast: false });
    m.box(at, plane + 1.05, z, half - 0.5, 0.05, tall / 2 + 1, { mat, cast: false });
  }
}

/** The basement's shell on two floors, both stairs, the studio, the video wall's frame and the street. */
export function roomModel(): Model {
  const m = new Model();
  const { x0, y0, x1, y1, wall } = ROOM;
  const t = 8;
  // Floor slab: its top is the ground floor (z = 0); its cut edges show along the open front.
  m.box((x0 - t + x1) / 2, (y0 - t + y1) / 2, -5, (x1 - x0 + t) / 2, (y1 - y0 + t) / 2, 5, { mat: floorTiles, cast: false });
  // Back walls.
  m.box(x0 - t / 2, (y0 - t + y1) / 2, wall / 2, t / 2, (y1 - y0 + t) / 2, wall / 2, { mat: wallPanels("y", false) });
  m.box((x0 - t + x1) / 2, y0 - t / 2, wall / 2, (x1 - x0 + t) / 2, t / 2, wall / 2, { mat: wallPanels("x", true) });
  // Neon strips along the top of each wall: cyan on the left, magenta on the right.
  m.box(x0 + 0.6, (y0 + y1) / 2, wall - 3, 0.5, (y1 - y0) / 2 - 10, 0.5, { mat: neon(R.neonCyan), cast: false });
  m.box((x0 + DECK.rightX1) / 2 + 20, y0 + 0.6, wall - 3, (DECK.rightX1 - x0) / 2 - 30, 0.5, 0.5, { mat: neon(R.neonPink), cast: false });

  deck(m);
  studio(m);
  // The street stairs: from the street's height down onto the deck, along the right wall.
  stairs(m, { x: STAIRS.top.x, y: STAIRS.top.y, z: wall }, { x: STAIRS.foot.x, y: STAIRS.foot.y, z: DECK.z }, STAIRS.width, STAIRS.steps, 1);
  // Its landing at the top, on posts from the deck.
  m.box(STAIRS.top.x - 8, STAIRS.top.y, wall - 0.8, 8, STAIRS.width / 2, 0.8, { mat: stepMat2 });
  for (const dy of [-1, 1]) m.box(STAIRS.top.x - 14, STAIRS.top.y + dy * (STAIRS.width / 2 - 1), (wall + DECK.z) / 2, 0.7, 0.7, (wall - DECK.z) / 2, { mat: solid(R.hqMetal, 0.3, 0) });
  innerStairsModel(m);

  videoWallFrame(m);
  wallDecor(m);
  nook(m);

  // The street above and behind the right wall: pavement, road and the shops' pavement across it.
  const sx0 = Math.min(x0 - t - 30, -70);
  const sx1 = x1 + 160;
  const sy0 = y0 - 172;
  m.box((sx0 + sx1) / 2, (sy0 + y0 - t) / 2, wall - 4, (sx1 - sx0) / 2, (y0 - t - sy0) / 2, 4, { mat: streetMat, cast: false });
  return m;
}

/** A slab of book spines on a shelf: spines of every height and colour, a few glowing data drives. */
function spines(seed: number) {
  const colours = [R.crimson, R.teal, R.amber, R.violet, R.cream, R.jade, R.navy, R.coral, R.hqPurple];
  return (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    out.ramp = R.black;
    out.tone = 0.3;
    if (h.nx < 0.5) return;
    const i = Math.floor(h.y / 1.7);
    const n = hash2(i + seed * 31, seed);
    if (n < 0.06) return; // a gap
    const height = 4.2 + hash2(i, seed + 7) * 4;
    if (h.lz + 4.6 > height) return;
    if (n > 0.93) {
      // A glowing script drive.
      out.ramp = n > 0.965 ? R.neonPink : R.neonCyan;
      out.tone = 0;
      out.glow = 1;
      return;
    }
    out.ramp = colours[Math.floor(hash2(i, seed + 3) * colours.length)];
    out.tone = -0.9 + hash2(i, seed + 5) * 0.8 + (frac(h.y / 1.7) < 0.12 ? -0.8 : 0);
    // A pale label near the top of each spine.
    if (Math.abs(h.lz + 4.6 - height + 1.4) < 0.4) out.tone += 0.9;
  };
}

/**
 * The scripts' library: a bookshelf from the deck to the ceiling along the left wall, every shelf
 * full, with a rolling ladder hooked on a rail at the top (the script room climbs it for a binder).
 */
function bookshelf(m: Model) {
  const x = ROOM.x0;
  const ya = STATION.tent.y - 8;
  const yb = DECK.leftY1 - 6;
  const zb = DECK.z;
  const zt = ROOM.wall - 2;
  const depth = 7;
  const wood = (h: HitInfo, out: ShadeOut) => ((out.dither = 0), (out.ramp = R.woodDark), (out.tone = h.nz > 0.5 ? 0.6 : h.nx > 0.5 ? 0.2 : -0.4));
  const ym = (ya + yb) / 2;
  const hy = (yb - ya) / 2;
  // The back, the sides and a divider.
  m.box(x + 0.4, ym, (zb + zt) / 2, 0.4, hy, (zt - zb) / 2, { mat: solid(R.woodDark, -1, 0) });
  for (const y of [ya, ym, yb]) m.box(x + depth / 2, y, (zb + zt) / 2, depth / 2, 0.7, (zt - zb) / 2, { mat: wood });
  // Shelves every 11, each loaded.
  let k = 0;
  for (let z = zb + 1; z < zt - 6; z += 11, k++) {
    m.box(x + depth / 2, ym, z, depth / 2, hy, 0.5, { mat: wood });
    for (const [a, b] of [
      [ya + 0.7, ym - 0.7],
      [ym + 0.7, yb - 0.7],
    ]) {
      m.box(x + depth / 2 - 0.6, (a + b) / 2, z + 5, depth / 2 - 1, (b - a) / 2, 4.5, { mat: spines(k * 2 + (a > ym ? 1 : 0)), cast: false });
    }
  }
  m.box(x + depth / 2, ym, zt, depth / 2 + 0.4, hy + 0.7, 0.8, { mat: wood });
  m.box(x + depth + 0.45, ym, zt - 1.6, 0.06, hy, 0.25, { mat: neon(R.neonPink, 0.2), cast: false });
  // The ladder's rail along the top, and the ladder hooked on it, its feet on wheels on the deck.
  const rail = (_h: HitInfo, out: ShadeOut) => ((out.dither = 0), (out.ramp = R.bronze), (out.tone = 0.8));
  m.capsule([x + depth + 1.4, ya + 1, zt - 6], [x + depth + 1.4, yb - 1, zt - 6], 0.35, { mat: rail });
  const ly = STATION.tent.y + LADDER.y;
  const lx = STATION.tent.x + LADDER.x;
  const footX = lx + 1;
  const topX = x + depth + 1.6;
  for (const dy of [-2.6, 2.6]) {
    m.capsule([footX, ly + dy, zb + 0.8], [topX, ly + dy, zt - 6], 0.35, { mat: rail });
    m.sphere(footX + 0.4, ly + dy, zb + 0.6, 0.6, { mat: solid(R.black, 0.6, 0) });
  }
  for (let i = 1; i < 14; i++) {
    const t = i / 14;
    m.capsule([footX + (topX - footX) * t, ly - 2.6, zb + 0.8 + (zt - 6.8 - zb) * t], [footX + (topX - footX) * t, ly + 2.6, zb + 0.8 + (zt - 6.8 - zb) * t], 0.22, { mat: rail });
  }
  // A reading lamp clipped to a shelf.
  m.ellipsoid(x + depth + 0.8, ya + 6, zb + 46, 1, 1, 0.8, { mat: neon(R.amber, 0.8) });
}

/** The viral study's wall of phones: a grid of vertical screens playing the category's top videos. */
function phoneWall(m: Model) {
  const x = ROOM.x0;
  const ya = ROOM.y0 + 6;
  const yb = STATION.oracle.y + 42;
  const za = DECK.z + 6;
  const zb = ROOM.wall - 15;
  const feed = [R.neonPink, R.neonCyan, R.amber, R.violet, R.neonBlue, R.coral, R.jade];
  m.box(x + 0.5, (ya + yb) / 2, (za + zb) / 2, 0.5, (yb - ya) / 2 + 1.5, (zb - za) / 2 + 1.5, { mat: solid(R.black, 0.2, 0), cast: false });
  m.box(x + 1.05, (ya + yb) / 2, (za + zb) / 2, 0.05, (yb - ya) / 2, (zb - za) / 2, {
    mat: (h, out) => {
      out.dither = 0;
      out.ramp = R.black;
      out.tone = 0.6;
      const cu = (h.y - ya) / 6;
      const cv = (h.z - za) / 10;
      const u = frac(cu);
      const v = frac(cv);
      if (u < 0.12 || u > 0.88 || v < 0.06 || v > 0.94) return;
      const n = hash2(Math.floor(cu), Math.floor(cv));
      const ramp = feed[Math.floor(n * feed.length)];
      // A scene: a sky, a figure in the middle, a caption bar and a heart.
      out.glow = 0.8;
      out.ramp = ramp;
      out.tone = -1.6 + v * 0.8;
      if (Math.abs(u - 0.5) < 0.12 && v > 0.3 && v < 0.62) {
        out.ramp = R.cream;
        out.tone = -0.4;
      }
      if (v < 0.2 && u > 0.2 && u < 0.7) {
        out.ramp = R.white;
        out.tone = -1.2;
      }
      if (u > 0.74 && u < 0.84 && v > 0.36 && v < 0.44) {
        out.ramp = R.neonPink;
        out.tone = 0.6;
      }
    },
    cast: false,
  });
  faceSign(m, "x", x, (ya + yb) / 2, zb + 7, "TRENDING", R.neonCyan, 1);
}

/** The strategy's storyboard wall: a glass board of sticky notes, three frames and red string. */
function storyboardWall(m: Model) {
  const x = ROOM.x0;
  const ya = STATION.oracle.y + 48;
  const yb = STATION.tent.y - 12;
  const za = DECK.z + 14;
  const zb = DECK.z + 52;
  // A wooden frame round a cork board.
  m.box(x + 0.6, (ya + yb) / 2, (za + zb) / 2, 0.6, (yb - ya) / 2 + 1, (zb - za) / 2 + 1, { mat: solid(R.woodDark, 0.2, 0), cast: false });
  m.box(x + 1.25, (ya + yb) / 2, (za + zb) / 2, 0.05, (yb - ya) / 2, (zb - za) / 2, {
    mat: (h, out) => {
      out.dither = 0;
      out.ramp = R.ochre;
      out.tone = -1.6 + (hash2(Math.floor(h.y * 1.5), Math.floor(h.z * 1.5)) > 0.7 ? -0.4 : 0);
      const u = yb - h.y;
      const v = zb - h.z;
      // Three storyboard frames across the top: hook, demo, payoff.
      if (v > 3 && v < 13) {
        const f = Math.floor((u - 3) / 13);
        const fu = (u - 3) % 13;
        if (f >= 0 && f < 3 && fu < 11) {
          out.ramp = R.cream;
          out.tone = 0.4;
          const su = fu - 5.5;
          const sv = v - 8;
          const sketch = f === 0 ? Math.hypot(su, sv + 1.5) < 1.2 || (Math.abs(su) < 0.3 && sv > -0.3 && sv < 3) : f === 1 ? Math.abs(Math.abs(su) - 1.6) < 0.35 && Math.abs(sv) < 3 : Math.abs(Math.abs(su) * 0.9 - (sv + 1.5)) < 0.5 && sv < 2.5 && sv > -2;
          if (sketch) {
            out.ramp = R.black;
            out.tone = 0.6;
          }
          return;
        }
      }
      // Sticky notes below, in a loose grid.
      const cu = Math.floor(u / 4.5);
      const cv = Math.floor((v - 15) / 4.5);
      if (v > 15) {
        const n = hash2(cu * 5 + 1, cv * 3 + 2);
        if (n > 0.3 && frac(u / 4.5) > 0.15 && frac((v - 15) / 4.5) > 0.15) {
          out.ramp = n > 0.8 ? R.neonPink : n > 0.6 ? R.amber : n > 0.45 ? R.neonCyan : R.cream;
          out.tone = n > 0.45 ? -0.3 : 0.2;
          out.glow = n > 0.45 ? 0.4 : 0;
          return;
        }
      }
      // Red string between the frames and the notes.
      if (Math.abs(v - 14 - Math.sin(u / 5) * 1.5) < 0.25) {
        out.ramp = R.magenta;
        out.tone = 0.2;
      }
    },
    cast: false,
  });
  faceSign(m, "x", x, (ya + yb) / 2, zb + 7, "PLAN", R.neonPink, 1);
}

/**
 * The nook at the foot of the inner stairs, against the mezzanine's end: a vending machine, the
 * coffee counter with its machine and a cat asleep on it, and a COFFEE sign.
 */
function nook(m: Model) {
  const yf = DECK.leftY1;
  const x = ROOM.x0 + INNER.width + 4;
  // The vending machine.
  m.box(x + 6, yf + 3.5, 13, 5.5, 3.5, 13, {
    mat: (h, out) => {
      out.dither = 0;
      out.ramp = R.hqPurple;
      out.tone = h.nz > 0.5 ? 0.8 : 0.2;
      if (h.ny > 0.5 && h.z > 8 && h.z < 24 && Math.abs(h.x - (x + 4.6)) < 3.6) {
        // The lit window of cans, row on row.
        out.ramp = frac(h.z / 3) < 0.25 ? R.black : [R.neonPink, R.neonCyan, R.amber, R.jade][Math.floor(h.x * 0.9 + h.z / 3) & 3];
        out.tone = frac(h.z / 3) < 0.25 ? 0.6 : -0.4;
        out.glow = 0.8;
      }
      if (h.ny > 0.5 && Math.abs(h.x - (x + 10)) < 0.8 && h.z > 10 && h.z < 18) {
        out.ramp = R.neonCyan;
        out.tone = 0.4;
        out.glow = 1;
      }
    },
  });
  // The counter, its stools, the coffee machine and the mugs.
  const cx0 = x + 15;
  const cx1 = ROOM.x0 + DECK.depth - 2;
  m.box((cx0 + cx1) / 2, yf + 4, 4.6, (cx1 - cx0) / 2, 4, 4.6, { mat: (h, out) => ((out.dither = 0), (out.ramp = R.woodDark), (out.tone = h.nz > 0.5 ? 0.9 : frac(h.x / 3) < 0.1 ? -0.8 : 0)) });
  m.box((cx0 + cx1) / 2, yf + 8.05, 8.6, (cx1 - cx0) / 2, 0.06, 0.2, { mat: neon(R.amber, 0.2), cast: false });
  m.box(cx0 + 5, yf + 3.5, 12.4, 2.6, 2.6, 3.2, { mat: (h, out) => ((out.dither = 0), (out.ramp = R.hqMetal), (out.tone = h.nz > 0.5 ? 1.2 : 0.6)) });
  m.box(cx0 + 5, yf + 6.15, 13.4, 1.4, 0.06, 0.6, { mat: neon(R.jade, 0.2), cast: false });
  for (const [mx, ramp] of [
    [cx0 + 11, R.neonPink],
    [cx0 + 13.5, R.white],
  ] as const)
    m.cylinder(mx, yf + 5, 10.1, 0.8, 0.9, { mat: solid(ramp, 0.2, 0) });
  // The cat, curled up at the counter's end.
  const cat = solid(R.amber, -0.6, 0);
  m.ellipsoid(cx1 - 6, yf + 4, 10.3, 2.6, 1.8, 1.2, { mat: cat });
  m.sphere(cx1 - 3.6, yf + 5, 10.6, 1.1, { mat: cat });
  for (const dy of [-0.5, 0.5]) m.frustum(cx1 - 3.4, yf + 5 + dy, 11.8, 0.35, 0.05, 0.5, { mat: cat });
  m.capsule([cx1 - 8.4, yf + 4, 9.8], [cx1 - 7, yf + 6.4, 9.6], 0.4, { mat: cat });
  for (const sx of [cx0 + 6, cx0 + 16]) {
    m.capsule([sx, yf + 12, 0], [sx, yf + 12, 6], 0.3, { mat: solid(R.hqMetal, 0.8, 0) });
    m.cylinder(sx, yf + 12, 6.4, 1.8, 0.4, { mat: solid(R.neonPink, -1.4, 0) });
  }
  faceSign(m, "y", yf, (cx0 + cx1) / 2, 30, "COFFEE", R.amber, 1);
  // A string of warm bulbs across the mezzanine's end above the counter.
  for (let i = 0; i < 9; i++) {
    const bx = cx0 - 10 + i * 5.4;
    m.sphere(bx, yf + 1, 42 - Math.sin((i / 8) * Math.PI) * 4, 0.5, { mat: neon(i % 2 ? R.amber : R.neonPink, 0.8), cast: false });
  }
}

/** The walls' furniture: the library, the phone wall, the storyboards, signs, posters, lamps, cables. */
function wallDecor(m: Model) {
  const { x0, y0, y1 } = ROOM;
  const L = x0 + 0.1;
  const Rw = y0 + 0.1;
  const face = x0 + DECK.depth;
  const metal = (tone: number) => (h: HitInfo, out: ShadeOut) => ((out.dither = 0), (out.ramp = R.hqMetal), (out.tone = tone + (h.nz > 0.5 ? 0.6 : 0)));
  const up = DECK.z;

  phoneWall(m);
  storyboardWall(m);
  bookshelf(m);

  // The big ADTOPIA sign on the mezzanine's face over the editing bay.
  faceSign(m, "x", HQ_SIGN.x, HQ_SIGN.y, HQ_SIGN.z, "ADTOPIA", R.neonPink, 1.3);
  faceSign(m, "x", HQ_SIGN.x, HQ_SIGN.y, HQ_SIGN.z - 13, "HQ", R.neonCyan, 1);

  // Posters: over the landing of the inner stairs, on the mezzanine's end by the video wall, and
  // round the editing bay.
  poster(m, L, y1 - 14, INNER.turn.z + 34, true, 5, 7, R.neonCyan, R.violet, 2);
  poster(m, L, y1 - 36, INNER.turn.z + 46, true, 3.5, 4.5, R.amber, R.neonPink, 3);
  poster(m, DECK.rightX1, y0 + DECK.depth - 18, 30, true, 8, 11, R.neonPink, R.neonBlue, 1);
  poster(m, DECK.rightX1, y0 + DECK.depth - 46, 34, true, 5, 7, R.neonBlue, R.neonPink, 4);
  poster(m, face, STUDIO.y + STUDIO.size + 12, 38, true, 4, 5.5, R.amber, R.neonCyan, 5);

  // Wall lamps: a bracket and a warm shade.
  for (const lamp of wallLamps()) {
    const onX = Math.abs(lamp.fx - lamp.x) > Math.abs(lamp.fy - lamp.y);
    const dx = onX ? 2 : 0;
    const dy = onX ? 0 : 2;
    m.box(lamp.x + dx / 2, lamp.y + dy / 2, lamp.z + 1, onX ? 1 : 0.4, onX ? 0.4 : 1, 0.3, { mat: metal(0.6) });
    m.ellipsoid(lamp.x + dx, lamp.y + dy, lamp.z, 1.6, 1.6, 1.2, { mat: neon(R.amber, 0.6) });
  }

  // Cable runs along the right wall under its cap, and a bundle down the mezzanine's corner.
  m.capsule([x0, Rw + 1.2, wall0() - 12], [DECK.rightX1, Rw + 1.2, wall0() - 12], 0.5, { mat: solid(R.black, 0.8, 0) });
  m.capsule([x0, Rw + 1.9, wall0() - 14], [DECK.rightX1, Rw + 1.9, wall0() - 14], 0.4, { mat: solid(R.neonBlue, -1.4, 0) });
  m.capsule([L + 1.2, y0, wall0() - 10], [L + 1.2, y1, wall0() - 10], 0.5, { mat: solid(R.black, 0.8, 0) });
  // A hanging plant over the deck's corner, trailing down the wall.
  const leaf = (h: HitInfo, out: ShadeOut) => ((out.dither = 0), (out.ramp = R.jade), (out.tone = -0.6 + (hash2(Math.floor(h.y * 2), Math.floor(h.z * 2)) > 0.6 ? 0.5 : 0)));
  for (const [py, len] of [
    [y0 + 99, 10],
    [y0 + 102, 16],
    [y0 + 105, 8],
  ] as const) {
    m.capsule([L + 2, py, wall0() - 8], [L + 3, py + 1, wall0() - 8 - len], 0.9, { mat: leaf });
  }
  m.cylinder(L + 2.6, y0 + 102, wall0() - 7, 3, 1.4, { mat: solid(R.hqPurple, 0.4, 0) });
}

const wall0 = () => ROOM.wall;

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
// The HQ's street door (the landing): a narrow building with ADTOPIA in neon over a roll-up
// shutter. The shutter rolls up as the opening plays, light spills out across the pavement and
// the agents come out. Its pieces are separate sprites, like the horse's body, doors and plank.

/** Lit pixels of a word in the signs' 5 x 7 font, `u` across and `v` down in glyph pixels. */
const wordPixel = textPixel;

const E = ENTRANCE;
const Z = ROOM.wall;
const FRONT = E.y + E.depth;

/**
 * The HQ's walls: the street's building style (floors of flats with their windows over the signs,
 * narrow windows down the sides), the doorway lit warm from within, pink neon up the front corners.
 */
let hqWall: ((h: HitInfo, out: ShadeOut) => void) | null = null;

function entranceWall(h: HitInfo, out: ShadeOut) {
  if (h.inner) {
    out.dither = 0;
    out.ramp = R.amber;
    out.tone = h.ny > 0.5 ? -0.8 : 0;
    out.glow = 0.8;
    return;
  }
  // Made on first use: hq.ts and cyber.ts import each other.
  hqWall ??= buildingWall(1, ENTRANCE.half, ENTRANCE.y - ENTRANCE.depth, 52);
  hqWall(h, out);
  if (h.ny > 0.5 && Math.abs(Math.abs(h.x) - E.half + 0.8) < 0.5) {
    out.ramp = R.neonPink;
    out.tone = 0.4;
    out.glow = 1;
  }
}

/** The HQ's front building, with the doorway carved out and lit inside. */
export function entranceBody() {
  const m = new Model();
  const door = m.hole(0, FRONT, Z + E.doorTall / 2, E.door, 3, E.doorTall / 2);
  m.box(E.x, E.y, Z + E.tall / 2, E.half, E.depth, E.tall / 2, { mat: entranceWall, carve: door });
  // A cornice, and the roof gear the street's buildings have: a water tank and an aerial.
  m.box(E.x, E.y, Z + E.tall + 0.8, E.half + 0.6, E.depth + 0.6, 0.8, { mat: (h, out) => ((out.dither = 0), (out.ramp = R.hqMetal), (out.tone = h.nz > 0.5 ? 0.6 : 0.2)) });
  m.with(translate(0, FRONT - 2, Z), () => roofGear(m, -12, E.tall));
  // The sign: ADTOPIA in pink over HQ in cyan, on a dark board above the door. Its letters are a
  // whole world unit to the pixel, like HQ's (smaller ones lose strokes at the scene's resolution),
  // so the board runs a little past the building's corners.
  m.box(0, FRONT + 0.6, Z + 42, 22.4, 0.5, 5, { mat: solid(R.black, 0.4, 0) });
  m.box(0, FRONT + 1.15, Z + 42, 21.6, 0.05, 4.6, {
    mat: (h, out) => {
      out.dither = 0;
      const u = h.x + textWidth("ADTOPIA") / 2;
      const v = Z + 45.5 - h.z;
      if (wordPixel("ADTOPIA", u, v)) {
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
  m.box(0, FRONT + 0.6, Z + 31, 7, 0.4, 4.4, { mat: solid(R.black, 0.4, 0) });
  m.box(0, FRONT + 1.05, Z + 31, 6.6, 0.05, 4, {
    mat: (h, out) => {
      out.dither = 0;
      const on = wordPixel("HQ", h.x + 5.5, Z + 34.5 - h.z);
      out.ramp = on ? R.neonCyan : R.black;
      out.tone = on ? 0.8 : 0.6;
      out.glow = on ? 1 : 0;
    },
    cast: false,
  });
  // An awning over the door, and a lamp on each side.
  m.box(0, FRONT + 2.4, Z + E.doorTall + 1.2, E.door + 3, 2.6, 0.3, { mat: solid(R.hqPurple, 0.4, 0) });
  m.box(0, FRONT + 5, Z + E.doorTall + 1, E.door + 3, 0.06, 0.25, { mat: neon(R.neonCyan, 0), cast: false });
  for (const x of [-E.door - 3, E.door + 3]) m.box(x, FRONT + 0.7, Z + 14, 0.7, 0.7, 1.2, { mat: neon(R.amber, 0.6) });
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
      if (h.y < FAR_KERB) {
        out.ramp = R.hqWall;
        out.tone = frac(h.x / 10) < 0.08 || frac(h.y / 12) < 0.1 ? -0.6 : 0.4;
        if (h.y > FAR_KERB - 1.4) out.tone = 1;
        return;
      }
      out.ramp = R.hqAsphalt;
      out.tone = hash2(Math.floor(h.x * 1.3), Math.floor(h.y * 1.3)) > 0.9 ? 0.3 : 0;
      // Two lanes: a dashed line down the middle.
      if (Math.abs(h.y - (CAR_LANES[0].y + CAR_LANES[1].y) / 2) < 0.6 && frac(h.x / 18) < 0.5) {
        out.ramp = R.amber;
        out.tone = 0.2;
      }
      if (h.y > STREET_LANE - 7) {
        out.ramp = R.hqWall;
        out.tone = -0.4;
        if (h.y < STREET_LANE - 6.2 && frac(h.x / 8) < 0.6) {
          out.ramp = R.neonCyan;
          out.tone = -0.6;
          out.glow = 0.5;
        }
      }
    },
    cast: false,
  });
  return m;
}
