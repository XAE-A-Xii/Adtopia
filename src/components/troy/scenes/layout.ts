import type { Stage as PipelineStage } from "../api";
import type { IslandSpec } from "../engine/grounds";
import type { Point } from "../engine/walker";
import type { PropId } from "./stations";

// Where everything in the camp sits. Stations follow the core pipeline in reading order: the top
// row runs left to right, then the road turns down and the bottom row runs back.

export type StationId = "scouts" | "oracle" | "tent" | "workshop" | "theatre" | "agora";

export type Station = {
  id: StationId;
  stage: PipelineStage;
  name: string;
  role: string;
  /** Centre on the ground, in world units. */
  x: number;
  y: number;
  /** Height of the floor it stands on: the ground floor (0) or the upper floor's deck. */
  z: number;
  /** Its place in the pipeline, 1..6, as the numbers on the floor and its tag say. */
  n: number;
};

/** Ground point under a screen offset (art px) from the horse: x - y = sx, (x + y) / 2 = sy. */
export function ground(sx: number, sy: number): Point {
  return { x: sy + sx / 2, y: sy - sx / 2, z: 0 };
}

/** Screen-space centre of the camp, in art px below the horse. */
export const CAMP_CENTER = { sx: -20, sy: 180 };
const COLUMN = 196;
const ROW_TOP = -76;
const ROW_BOTTOM = 80;

// The camp is one underground HQ on two floors. The basement's back walls run along x = ROOM.x0
// (the left wall on screen) and y = ROOM.y0 (the right wall); the street is above and behind the
// right wall. An L-shaped upper floor (the DECK) runs along both back walls: the "thinking" floor,
// with research, the viral study and strategy. It is built solid, walled down to the ground floor,
// so its two inner faces make a corner of their own in the middle of the room: the green-screen
// studio, with production in front of it. Round it the ground floor is the "making" floor:
// production, review and publishing. Where the L stops short of the right wall's front end, that
// stretch of wall is open from floor to ceiling: the video wall.

/** The middle of the basement, in world units (the camera frames the room around it). */
export const ROOM_CENTER = ground(CAMP_CENTER.sx, CAMP_CENTER.sy);
/** Half the room's inner width. */
export const ROOM_HALF = 150;
export const ROOM = {
  x0: ROOM_CENTER.x - ROOM_HALF,
  y0: ROOM_CENTER.y - ROOM_HALF,
  x1: ROOM_CENTER.x + ROOM_HALF,
  y1: ROOM_CENTER.y + ROOM_HALF,
  /** Height of the walls; the street outside is at this height. */
  wall: 136,
};
/** Kept for older callers: the spacing the stations used to sit at. */
export const CELL = 80;

/**
 * The upper floor: a solid mezzanine at height `z`, `depth` deep along both back walls. Along the
 * left wall it runs from the back corner to `leftY1` (the inner stairs go down from there); along
 * the right wall it stops at `rightX1`, leaving the rest of that wall to the video wall.
 */
export const DECK = { z: 58, depth: 80, leftY1: ROOM.y1 - 62, rightX1: ROOM.x0 + 190 };

/** True for a floor point inside the mezzanine's footprint (solid: nobody stands there on the ground floor). */
export function underDeck(x: number, y: number) {
  return x < ROOM.x0 + DECK.depth || (y < ROOM.y0 + DECK.depth && x < DECK.rightX1);
}

/** The video wall: the open stretch of the right wall, floor to ceiling. */
export const VIDEO_WALL = { x0: DECK.rightX1 + 4, x1: ROOM.x1 - 4, z0: 6, z1: ROOM.wall - 10 };

/**
 * The green-screen studio in the mezzanine's inner corner: its two walls are the cyclorama, `size`
 * out along each from the corner, `tall` high; its floor is the green sweep in front of them.
 */
export const STUDIO = { x: ROOM.x0 + DECK.depth, y: ROOM.y0 + DECK.depth, size: 54, tall: 50 };

/** The big SURREEL sign on the mezzanine's front face over the editing bay (the HQ's tag hangs there). */
export const HQ_SIGN = { x: ROOM.x0 + DECK.depth, y: ROOM.y0 + 196, z: 40 };

/** A cell of the old grid (kept for callers that place things around the middle). */
export function cell(i: number, j: number) {
  return { x: ROOM_CENTER.x + i * CELL, y: ROOM_CENTER.y + j * CELL };
}

function at(id: StationId, stage: PipelineStage, n: number, name: string, role: string, x: number, y: number, z: number): Station {
  return { id, stage, n, name, role, x, y, z };
}

// The pipeline reads like a page: along the upper floor from the street stairs (1, research) round
// the corner (2, the viral study) to the strategy corner (3), down the inner stairs, then on the
// ground floor to production (4, the biggest, in the middle of the room in front of the studio), to
// review in front of the video wall (5) and on to publishing and analytics (6).
export const STATIONS: Station[] = [
  at("scouts", "research", 1, "Research", "Intelligence desk", ROOM.x0 + 150, ROOM.y0 + 46, DECK.z),
  at("oracle", "style", 2, "Viral study", "Reference archive", ROOM.x0 + 46, ROOM.y0 + 56, DECK.z),
  at("tent", "strategy", 3, "Strategy · Scripts", "Strategy table", ROOM.x0 + 44, ROOM.y0 + 165, DECK.z),
  at("workshop", "production", 4, "Production", "Production studio", ROOM.x0 + 146, ROOM.y0 + 142, 0),
  at("theatre", "review", 5, "Review", "Screening and approval", ROOM.x1 - 55, ROOM.y0 + 58, 0),
  at("agora", "live", 6, "Publish · Analytics", "Publishing terminal", ROOM.x1 - 52, ROOM.y1 - 58, 0),
];

export const STATION = Object.fromEntries(STATIONS.map((s) => [s.id, s])) as Record<StationId, Station>;

export const ISLAND_RADIUS = 48;

export function stationIsland(station: Station, index: number): IslandSpec {
  // The scouts' island bulges to the left for the stable and the aisle behind its horses.
  const lobes = station.id === "scouts" ? [{ cx: -42, cy: 0, r: 27 }] : undefined;
  return { cx: 0, cy: 0, rx: ISLAND_RADIUS, ry: ISLAND_RADIUS * 0.94, seed: 11 + index * 7, rim: 12, wobble: 14, grass: 0.22, trodden: 0.8, lobes };
}

/**
 * Sandbars linking the horse to the first station, each station to the next, and the last back to
 * the first: a ring, so nobody walks the long way round to the station below the scouts.
 */
export function sandbars(): Array<{ a: Point; b: Point }> {
  const point = (p: { x: number; y: number }): Point => ({ x: p.x, y: p.y, z: 0 });
  const bars: Array<{ a: Point; b: Point }> = [{ a: { x: 0, y: 62, z: 0 }, b: point(STATIONS[0]) }];
  for (let i = 0; i < STATIONS.length - 1; i++) bars.push({ a: point(STATIONS[i]), b: point(STATIONS[i + 1]) });
  bars.push({ a: point(STATIONS[STATIONS.length - 1]), b: point(STATIONS[0]) });
  return bars;
}

/** The road a messenger rides from one station to another, along the sandbars. */
export function road(from: StationId, to: StationId): Point[] {
  const i = STATIONS.findIndex((s) => s.id === from);
  const j = STATIONS.findIndex((s) => s.id === to);
  const step = i <= j ? 1 : -1;
  const points: Point[] = [];
  for (let k = i; k !== j + step; k += step) points.push({ x: STATIONS[k].x, y: STATIONS[k].y, z: 0 });
  return points;
}

/** Where the horse's road leaves its island, at the foot of the gangplank. */
export const HORSE_GATE: Point = { x: 0, y: 62, z: 0 };

/**
 * The stairs down from the street, along the inside of the right wall: the top step at the street's
 * height near the archive, the foot toward approval. Walkers come in at the foot.
 */
export const STAIRS = { top: { x: ROOM.x0 + 30, y: ROOM.y0 + 13 }, foot: { x: ROOM.x0 + 110, y: ROOM.y0 + 13 }, width: 22, steps: 10, z0: DECK.z };

/**
 * The inner stairs: a quarter-turn stair from the end of the deck down to the ground floor. The
 * first flight runs down along the left wall (+y) to a landing in the room's front corner; there it
 * turns and the second flight runs on down along the front edge (+x) to the foot.
 */
export const INNER = {
  /** The first flight's centre line, along the left wall, and where it starts (the deck's end). */
  x: ROOM.x0 + 13,
  top: DECK.leftY1,
  width: 24,
  /** The landing: a square in the corner, `half` on a side, at height `z`. */
  turn: { x: ROOM.x0 + 13, y: ROOM.y1 - 13, z: 30, half: 13 },
  /** Where the second flight reaches the floor (world x), along the landing's centre line. */
  footX: ROOM.x0 + 84,
  steps1: 5,
  steps2: 6,
};
/** Kept for older callers: the upper floor is now the whole DECK. */
export const LOFT = { z: DECK.z, depth: 0, y1: ROOM.y0 };

/** Where walkers come in off the street stairs, on the deck. */
export const STAIRS_FOOT: Point = { x: STAIRS.foot.x + 10, y: STAIRS.foot.y + 10, z: DECK.z };
/** The top and the foot of the inner stairs. */
export const UPPER: Point = { x: INNER.x, y: INNER.top - 6, z: DECK.z };
export const LOWER: Point = { x: INNER.footX + 8, y: INNER.turn.y - 2, z: 0 };

/** Down (or up) the inner stairs: the first flight, across the landing, the second flight (world points). */
export function innerStairs(down = true): Point[] {
  const t = INNER.turn;
  const points: Point[] = [
    { x: INNER.x, y: INNER.top, z: DECK.z },
    { x: INNER.x, y: t.y - t.half, z: t.z },
    { x: t.x + 2, y: t.y - 2, z: t.z },
    { x: t.x + t.half, y: t.y, z: t.z },
    { x: INNER.footX, y: t.y, z: 0 },
  ];
  return down ? points : points.reverse();
}

/**
 * The bike bay, out on the street's pavement just past the top of the stairs (world, at the
 * street's height): bikes stand in a row along the kerb, facing the road. Scouts walk up the stairs
 * to them and ride the street; nobody rides indoors.
 */
export const BAY = { x: ROOM.x0 + 58, y: ROOM.y0 - 22, z: ROOM.wall };
/** Where the charging rail stands, behind the bikes (world). */
export const STABLE = { x: BAY.x + 24, y: BAY.y - 9 };
/** Where the pavement meets the top of the stairs: everyone going to or from the bikes passes here (world). */
export const STABLE_GATE = { x: ROOM.x0 + 26, y: ROOM.y0 - 12 };

/** A place on the road network: the street stairs ("horse"), a station, or an end of the inner stairs. */
export type Node = StationId | "horse" | "upper" | "lower";

/** The walkways: along the deck in pipeline order, down the inner stairs, round the ground floor. */
const EDGES: Array<[Node, Node]> = [
  ["horse", "scouts"],
  ["scouts", "oracle"],
  ["oracle", "tent"],
  ["tent", "upper"],
  ["upper", "lower"],
  ["lower", "workshop"],
  ["workshop", "theatre"],
  ["theatre", "agora"],
  ["agora", "workshop"],
];

/** The pipeline's path through the HQ, station to station, for the flow line on the floors. */
export function flowPath(): Point[] {
  const p = (id: StationId): Point => ({ x: STATION[id].x, y: STATION[id].y, z: STATION[id].z });
  return [p("scouts"), p("oracle"), p("tent"), UPPER, ...innerStairs(true), LOWER, p("workshop"), p("theatre"), p("agora")];
}

/**
 * Where each station's floating tag points (world): just over the station's heart, its main piece
 * of furniture, so the tag sits right above what it names.
 */
export const TAG_POINT: Record<StationId, Point> = {
  // Over the operators' desk under the wall map.
  scouts: { x: ROOM.x0 + 146, y: ROOM.y0 + 12, z: DECK.z + 26 },
  // Over the format table's holograms.
  oracle: { x: ROOM.x0 + 40, y: ROOM.y0 + 54, z: DECK.z + 30 },
  // Over the writer's desk under the cork board.
  tent: { x: ROOM.x0 + 16, y: ROOM.y0 + 150, z: DECK.z + 26 },
  // Over the studio's camera.
  workshop: { x: ROOM.x0 + 118, y: ROOM.y0 + 120, z: 28 },
  // Over the screening sofas.
  theatre: { x: ROOM.x1 - 62, y: ROOM.y0 + 54, z: 22 },
  // Over the uplink.
  agora: { x: ROOM.x1 - 58, y: ROOM.y1 - 66, z: 22 },
};

/**
 * Where a walker passing through an island goes between the two sandbars, relative to its centre:
 * along the road where it is clear, around the furniture where it isn't (the shrine, the seats, the
 * desks, the podium). Also the meeting point used to leave the stable. Walkers that stop on an
 * island go straight from where the sandbar meets it to their post.
 */
export const HUBS: Record<StationId, Array<{ x: number; y: number }>> = {
  scouts: [{ x: 2, y: -6 }],
  // In front of the format table's corner, clear of its chairs.
  oracle: [{ x: 16, y: 14 }],
  tent: [{ x: 0, y: 24 }],
  // Across the open floor in front of the camera, clear of the editing bay and the studio.
  workshop: [{ x: 8, y: 14 }],
  // Behind the lounge's back row, clear of the benches.
  theatre: [
    { x: -34, y: 18 },
    { x: 12, y: 20 },
  ],
  // Round the uplink on its far side.
  agora: [
    { x: 18, y: -14 },
    { x: 14, y: 22 },
  ],
};

/** How far inside an island a road starts (the sandbar meets the island here). */
const LANDING = 34;

function centre(node: Node): Point {
  if (node === "horse") return STAIRS_FOOT;
  if (node === "upper") return UPPER;
  if (node === "lower") return LOWER;
  const s = STATION[node];
  return { x: s.x, y: s.y, z: s.z };
}

const isStation = (node: Node): node is StationId => node !== "horse" && node !== "upper" && node !== "lower";

/** A node's (first) crossing point in world units. */
export function hub(node: Node): Point {
  if (!isStation(node)) return centre(node);
  const s = STATION[node];
  return { x: s.x + HUBS[node][0].x, y: s.y + HUBS[node][0].y, z: s.z };
}

/** The shortest way between two places on the road network, as the list of places passed. */
export function route(from: Node, to: Node): Node[] {
  const dist = new Map<Node, number>([[from, 0]]);
  const prev = new Map<Node, Node>();
  const open = new Set<Node>(["horse", "upper", "lower", ...STATIONS.map((s) => s.id)]);
  while (open.size) {
    let best: Node | null = null;
    for (const n of open) if (dist.has(n) && (best === null || dist.get(n)! < dist.get(best)!)) best = n;
    if (best === null || best === to) break;
    open.delete(best);
    for (const [a, b] of EDGES) {
      const next = a === best ? b : b === best ? a : null;
      if (!next || !open.has(next)) continue;
      const d = dist.get(best)! + Math.hypot(centre(next).x - centre(best).x, centre(next).y - centre(best).y, centre(next).z - centre(best).z);
      if (d < (dist.get(next) ?? Number.POSITIVE_INFINITY)) {
        dist.set(next, d);
        prev.set(next, best);
      }
    }
  }
  const nodes: Node[] = [to];
  while (nodes[0] !== from) {
    const p = prev.get(nodes[0]);
    if (!p) return [from];
    nodes.unshift(p);
  }
  return nodes;
}

/**
 * The way from one place to another along the sandbars, as world points: from where the first
 * sandbar leaves `from` (its gate, for the horse) to where the last one meets `to`, crossing the
 * islands in between by their crossing points. `lane` shifts the walker sideways on the sandbars
 * (world units) so a column doesn't walk in single file. Empty when `from` is `to`.
 */
export function travel(from: Node, to: Node, lane = 0): Point[] {
  const nodes = route(from, to);
  const points: Point[] = [];
  for (let k = 0; k < nodes.length - 1; k++) {
    const a = centre(nodes[k]);
    const b = centre(nodes[k + 1]);
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const ra = isStation(nodes[k]) ? LANDING : 0;
    const rb = isStation(nodes[k + 1]) ? LANDING : 0;
    // On the inner stairs everyone keeps to the middle of the treads.
    const stairs = !isStation(nodes[k]) && !isStation(nodes[k + 1]);
    const ox = stairs ? 0 : -uy * lane;
    const oy = stairs ? 0 : ux * lane;
    const exit = { x: a.x + ux * ra + ox, y: a.y + uy * ra + oy, z: a.z };
    if (k > 0) points.push(...crossing(nodes[k], points[points.length - 1], exit));
    points.push(exit);
    // The inner stairs turn at their landing: follow the treads round.
    if (stairs) points.push(...innerStairs(nodes[k] === "upper"));
    points.push({ x: b.x - ux * rb + ox, y: b.y - uy * rb + oy, z: b.z });
  }
  return points;
}

/**
 * The way a packet of work flies from one station to the next (world points): station to station
 * along the walkways' route, but only ever parallel to the room's edges, turning at right angles,
 * and round the inner stairs' turn. Each corner is taken on the side that keeps it on its own
 * floor (on the deck upstairs, off the mezzanine's footprint downstairs).
 */
export function flowLine(from: StationId, to: StationId): Point[] {
  const nodes = route(from, to);
  const points: Point[] = [];
  for (let k = 0; k < nodes.length; k++) {
    points.push(centre(nodes[k]));
    if (k < nodes.length - 1 && !isStation(nodes[k]) && !isStation(nodes[k + 1])) points.push(...innerStairs(nodes[k] === "upper"));
  }
  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = out[out.length - 1];
    const b = points[i];
    const level = Math.abs(a.z - b.z) < 0.5;
    if (level && Math.abs(a.x - b.x) > 0.5 && Math.abs(a.y - b.y) > 0.5) {
      const onFloor = (x: number, y: number) => (a.z > 1 ? underDeck(x, y) : !underDeck(x, y));
      out.push(onFloor(b.x, a.y) ? { x: b.x, y: a.y, z: a.z } : { x: a.x, y: b.y, z: a.z });
    }
    out.push(b);
  }
  return out;
}

/** The crossing points of an island, in the order that suits a walker going from `entry` to `exit`. */
function crossing(node: Node, entry: Point, exit: Point): Point[] {
  if (!isStation(node)) return [];
  const s = STATION[node];
  const pts = HUBS[node].map((h) => ({ x: s.x + h.x, y: s.y + h.y, z: s.z }));
  const d = (p: Point, q: Point) => Math.hypot(p.x - q.x, p.y - q.y);
  if (pts.length > 1 && d(entry, pts[0]) + d(pts[pts.length - 1], exit) > d(entry, pts[pts.length - 1]) + d(pts[0], exit)) pts.reverse();
  return pts;
}

// --- The wider world: the lands the scouts ride to -------------------------------------------------
//
// West of the camp a high road runs north and south, with a land on either side of it for each
// website or API the research reads. A road from the scouts' stable joins it at a crossroads.

export type LandId = "site" | "similarweb" | "ahrefs" | "tiktok" | "instagram" | "youtube" | "metaads" | "reddit" | "chatgpt" | "perplexity";

export type Land = {
  id: LandId;
  name: string;
  /** What the scouts bring back from there. */
  what: string;
  prop: PropId;
  /** Its colour, for its label. */
  color: string;
  /** World centre. */
  x: number;
  y: number;
  /** Screen position (art px), for the camera. */
  sx: number;
  sy: number;
  /** The high road's row it sits on. */
  row: number;
};

export const LAND_RADIUS = 30;

/**
 * The lands are shop fronts along the street above the HQ, across the road from the stairs: one
 * per website or API the research reads. Scouts ride up the stairs and along the street to them.
 */
export const LAND_Z = ROOM.wall;
// The street, from the HQ's wall outward (world y): the pavement with the bikes and the stairs, the
// kerb, the bike lane the scouts ride, two lanes of traffic, the parking lane in front of the
// shops, the far kerb and the shops' pavement, then the shops.
/** The kerb between the HQ's pavement and the road. */
export const KERB = ROOM.y0 - 32;
/** The bike lane's middle: the scouts ride along it (world y). */
export const STREET_LANE = ROOM.y0 - 44;
/** The two lanes of traffic, one each way, with room between them for the cars to pass. */
export const CAR_LANES = [
  { y: ROOM.y0 - 62, dir: 1 },
  { y: ROOM.y0 - 81, dir: -1 },
];
/** The kerb on the shops' side; bikes park just off it. */
export const FAR_KERB = ROOM.y0 - 102;
const LAND_ROW_Y = ROOM.y0 - 120;
const LAND_X0 = ROOM.x0 + 34;
const LAND_STEP = 42;

function land(id: LandId, name: string, what: string, prop: PropId, color: string, row: number): Land {
  const x = LAND_X0 + row * LAND_STEP;
  const y = LAND_ROW_Y;
  return { id, name, what, prop, color, x, y, sx: x - y, sy: (x + y) / 2 - 1.2247 * LAND_Z, row };
}

export const LANDS: Land[] = [
  land("site", "The brand's site", "Brand profile and website", "gate", "#f05ccd", 0),
  land("similarweb", "SimilarWeb", "Sites like the brand's", "huts", "#52d9ed", 1),
  land("ahrefs", "Ahrefs", "Domain rating and keywords", "beacon", "#f5b86a", 2),
  land("chatgpt", "ChatGPT", "AI answers about the brand", "orbshrine", "#4dc3a0", 3),
  land("perplexity", "Perplexity", "AI answers about the brand", "crystal", "#52d9ed", 4),
  land("tiktok", "TikTok", "Top videos and ads", "phone", "#f05ccd", 5),
  land("instagram", "Instagram", "Top Reels", "gallery", "#f78ade", 6),
  land("youtube", "YouTube", "Top Shorts", "bigscreen", "#ff5a6e", 7),
  land("metaads", "Meta Ad Library", "Rivals' running ads", "billboards", "#5b93f2", 8),
  land("reddit", "Reddit", "What people say", "forum", "#f5b86a", 9),
];

export const LAND = Object.fromEntries(LANDS.map((l) => [l.id, l])) as Record<LandId, Land>;

/** Which land a research source is fetched from (a run's key, as the core names it). */
export function landFor(runKey: string): LandId {
  if (runKey === "brand" || runKey === "site") return "site";
  if (runKey === "similar") return "similarweb";
  if (runKey.startsWith("seo")) return "ahrefs";
  // The scouting sweep's runs ("scout_tiktok_0") go where the source they scout is.
  if (runKey.startsWith("scout_")) return landFor(runKey.slice("scout_".length));
  if (runKey.startsWith("tiktok")) return "tiktok";
  // Numbered and conversion searches ("reels_0", "reels_conv_0", "shorts_1") too.
  if (runKey.startsWith("reels")) return "instagram";
  if (runKey.startsWith("shorts")) return "youtube";
  if (runKey.startsWith("meta_ads")) return "metaads";
  if (runKey === "reddit") return "reddit";
  if (runKey === "aeo_chatgpt") return "chatgpt";
  if (runKey === "aeo_perplexity") return "perplexity";
  // A source this camp doesn't know yet: the open web, as the brand's neighbours on SimilarWeb.
  return "similarweb";
}

/** The land a scout rides to, from its id: one scout per land ("scout:tiktok"). */
export function scoutLand(agentId: string): LandId {
  const key = agentId.startsWith("scout:") ? agentId.slice(6) : agentId;
  return key in LAND ? (key as LandId) : landFor(key);
}

/** The research runs that a land's scout fetches, in the order the core lists them. */
export function landRuns<T extends { key: string }>(runs: T[], land: LandId): T[] {
  return runs.filter((run) => landFor(run.key) === land);
}

/** Where the street meets the stairs: the top landing (world, at the street's height). */
export const STAIRS_TOP: Point = { x: STAIRS.top.x - 8, y: STAIRS.top.y, z: ROOM.wall };

/**
 * The HQ's street door (where the Trojan horse stood): a shop front across the road from the
 * stairs, at the world's origin. Agents come out of it, cross the road and go down the stairs.
 */
/**
 * The HQ's street door: a building like the shops along the street (as deep, its front in line with
 * theirs, a street floor and two floors of flats), at the world's origin. Agents come out of its
 * door, cross the road and go down the stairs.
 */
export const ENTRANCE = { x: 0, y: LAND_ROW_Y - 20, half: 20, depth: 12, tall: 78, door: 7, doorTall: 24 };

/** Kept for the signpost: where the stairs come out on the pavement. */
export const JUNCTION: Point = { x: STAIRS.top.x - 8, y: ROOM.y0 - 22, z: ROOM.wall };

/** Out of the HQ's door, across the street and down the stairs to their foot (world points). */
export function entrancePath(): Point[] {
  const z = ROOM.wall;
  const front = ENTRANCE.y + ENTRANCE.depth;
  return [
    // In the doorway (the building is drawn behind anyone standing in it), then out onto the pavement.
    { x: 0, y: front - 1.5, z },
    { x: 0, y: front + 2, z },
    { x: 0, y: STREET_LANE, z },
    { x: JUNCTION.x, y: STREET_LANE + 6, z },
    JUNCTION,
    STAIRS_TOP,
    { x: STAIRS.top.x, y: STAIRS.top.y, z },
    { x: STAIRS.foot.x - 4, y: STAIRS.foot.y, z: STAIRS.z0 },
    STAIRS_FOOT,
  ];
}

/** The stable's gate in world units. */
export function stableGate(): Point {
  return { x: STABLE_GATE.x, y: STABLE_GATE.y, z: ROOM.wall };
}

/** Up the street stairs from the deck to the pavement at the bay's gate (world points). */
export function upStairs(): Point[] {
  return [{ x: STAIRS.foot.x - 4, y: STAIRS.foot.y, z: STAIRS.z0 }, { x: STAIRS.top.x, y: STAIRS.top.y, z: ROOM.wall }, STAIRS_TOP, stableGate()];
}

/** The old roads of the wider world: none now, the street is part of the room. */
export function worldTrails(): Array<{ a: Point; b: Point }> {
  return [];
}

/**
 * The way from the scouts' bike bay to a shop front: across the basement to the foot of the stairs,
 * up them, out onto the pavement, along the road and up to the shop (world points).
 */
export function roadToLand(id: LandId): Point[] {
  // From the bay's gate on the pavement: out onto the road, along it, up to the shop.
  const l = LAND[id];
  const z = LAND_Z;
  return [
    { x: STABLE_GATE.x, y: STREET_LANE + 6, z },
    { x: l.x + 10, y: STREET_LANE, z },
    { x: l.x + 10, y: FAR_KERB + 6, z },
  ];
}

export function landIsland(l: Land, index: number): IslandSpec {
  return { cx: 0, cy: 0, rx: LAND_RADIUS, ry: LAND_RADIUS * 0.94, seed: 71 + index * 13, rim: 10, wobble: 10, grass: 0.35, trodden: 0.6 };
}

/** The screen rectangle (art px) that holds the camp and every land, for the camera's view of the world. */
export const WORLD_VIEW = { x0: CAMP_CENTER.sx - 2 * ROOM_HALF - 30, x1: CAMP_CENTER.sx + 2 * ROOM_HALF + 120, y0: CAMP_CENTER.sy - ROOM_HALF - 240, y1: CAMP_CENTER.sy + ROOM_HALF + 20 };

/** The lands and the roads west, out to the scouts' island (the east edge of the scouts' errands). */
export const LANDS_VIEW = { ...WORLD_VIEW };

// --- The expedition: the harbour below the agora, the sea, and the rival's city across it --------
//
// Below the camp the agora's army musters on a quay where four ships lie alongside. They board,
// row out and sail south across the sea to the rival's city, run their ships in bow first at its
// quay, and fight the legion drawn up in the forum before the city's gate. Screen positions (art
// px) lay the harbours out; the battle in the city runs along +x (down and to the right on
// screen): `a` measures along it from the forum's centre, `b` across it.

const SQ = Math.SQRT1_2;

/** The home quay's edge (screen y), its ends (screen x), and the screen x of each ship's berth along it. */
const HOME_QUAY = { sy: 500, sx0: -420, sx1: 190 };
export const BERTHS_SX = [-305, -175, -45, 85];

/** Ships lie alongside heading east (screen right): their port side to the quay, this far out (world). */
const ALONGSIDE = 7.6;
export const BERTH_DIR = 7;

/** Where ship `k` lies at the home quay (world, its centre on the waterline). */
export function homeBerth(k: number): Point {
  return ground(BERTHS_SX[k % BERTHS_SX.length], HOME_QUAY.sy + ALONGSIDE * SQ);
}

/** The home quay as a town's quay (engine/grounds.ts): the water to the south. */
export function homeQuay() {
  const a = ground(HOME_QUAY.sx0, HOME_QUAY.sy);
  const b = ground(HOME_QUAY.sx1, HOME_QUAY.sy);
  return { a, b, water: { x: SQ, y: SQ }, depth: 22 };
}

/** The shore below the agora: a strip of land along the quay. */
export const HOME_SHORE = ground(-110, 466);

export function homeShore(): IslandSpec {
  const lobes = [];
  for (let sx = HOME_QUAY.sx0 + 10; sx <= HOME_QUAY.sx1 - 10; sx += 58) {
    const p = ground(sx, 474);
    lobes.push({ cx: p.x - HOME_SHORE.x, cy: p.y - HOME_SHORE.y, r: 40 });
  }
  return { cx: 0, cy: 0, rx: 42, ry: 42, seed: 131, rim: 14, wobble: 14, grass: 0.5, trodden: 0.3, lobes };
}

/** The road down from the agora to the shore (world), and where it reaches the quay. */
export const SHORE_ROAD = { a: { x: STATION.agora.x + 30, y: STATION.agora.y + 38, z: 0 }, b: { ...ground(-170, 480), z: 0 } };

/**
 * The army's way down from the agora (agora-relative waypoints): past the podium, off the island,
 * down the road to the shore.
 */
export const SHORE_ENTRY = [
  { x: -14, y: 2, z: 0 },
  { x: 8, y: 30, z: 0 },
  { x: SHORE_ROAD.a.x - STATION.agora.x, y: SHORE_ROAD.a.y - STATION.agora.y, z: 0 },
  { x: SHORE_ROAD.b.x - STATION.agora.x, y: SHORE_ROAD.b.y - STATION.agora.y, z: 0 },
];

/** A point given in a moored ship's own frame (along it, across it), in world units. */
export function inShip(centre: { x: number; y: number }, dir: number, along: number, across: number): Point {
  const a = dir * (Math.PI / 4);
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: centre.x + along * c - across * s, y: centre.y + along * s + across * c, z: 0 };
}

// The rival's city. Its forum is the origin of the battle (`a`, `b`).

/** The forum's centre (world), where the battle is fought. */
export const ROME = ground(260, 1030);

/** A point in the city, `a` along the battle (toward the gate) and `b` across it (world). */
export function romePoint(a: number, b: number): Point {
  return { x: ROME.x + a, y: ROME.y + b, z: 0 };
}

/** Where things stand along the battle (`a`, world units from the forum's centre). */
export const ROME_LINES = {
  /** The quay's edge, and where a ship run in bow first lies (its centre). */
  quay: -116,
  ship: -155,
  /** The Greeks form up here off the ships, and wait here for their video's numbers. */
  landing: -92,
  /** Where the two front ranks meet. */
  clash: 12,
  /** The legion's front rank at rest, and the centurion behind it. */
  romans: 40,
  centurion: 57,
  /** The gatehouse's centre, and its outer face, where the routed legion runs for the passage. */
  gate: 114,
  /** A company that routs the legion follows it up to here. */
  pursuit: 74,
  /** A company that comes off worse falls back to here. */
  fallback: -66,
};

/** The berths at the city's quay, across the battle (`b`): ships run in side by side. */
export const ROME_BERTHS_B = [57, 19, -19, -57];

/** The city quay: the water to -x. */
export function romeQuay() {
  return { a: romePoint(ROME_LINES.quay, -210), b: romePoint(ROME_LINES.quay, 205), water: { x: -1, y: 0 }, depth: 26 };
}

/** The city's land: the forum, the walls and the town beyond, cut straight along the quay. */
export function romeLand(): IslandSpec {
  return {
    cx: 70,
    cy: 0,
    rx: 190,
    ry: 215,
    seed: 151,
    rim: 16,
    wobble: 22,
    grass: 0.55,
    trodden: 0.2,
    lobes: [
      { cx: -60, cy: -200, r: 70 },
      { cx: -70, cy: 200, r: 60 },
      { cx: 240, cy: -90, r: 120 },
      { cx: 250, cy: 90, r: 110 },
      { cx: 330, cy: 0, r: 90 },
      // The mole running out to the lighthouse.
      { cx: -150, cy: -205, r: 28 },
      { cx: -185, cy: -210, r: 24 },
    ],
  };
}

/** The city's paving, in battle coordinates: the forum, the streets past the gate, the mole. */
export const ROME_PAVING = {
  forum: { a0: ROME_LINES.quay, a1: 100, b0: -98, b1: 124 },
  /** The main street from the gate, and the cross street. */
  streets: [
    { a0: 100, a1: 340, b0: -13, b1: 13 },
    { a0: 196, a1: 214, b0: -200, b1: 190 },
  ],
  mole: { a0: -205, a1: ROME_LINES.quay, b0: -228, b1: -190 },
};

/** The city wall along `a` = ROME_LINES.gate: its towers (`b`) and the runs between them; the two by the gate carry ballistae. */
export const ROME_WALL = {
  towers: [-196, -118, -28, 28, 118, 196],
  guns: [-28, 28],
  runs: [
    [-185, -129],
    [-107, -39],
    [39, 107],
    [129, 185],
  ] as Array<[number, number]>,
};

/** Something standing in the city or the harbour (world position), as the camp places props. */
export type Standing = { prop: PropId; x: number; y: number; z?: number; v?: number; sort?: number; key?: string };

/** What stands on the islets, placed (world). */
export function isletProps(): Standing[] {
  return ISLETS.flatMap((islet, i) => {
    const c = isletAt(i);
    return islet.props.map((p) => ({ prop: p.prop, x: c.x + p.dx, y: c.y + p.dy, v: p.v ?? 0 }));
  });
}

/** The home harbour's furniture: cranes and cargo on the quay, bollards along its edge, a fire tower at its end. */
export function harborProps(): Standing[] {
  const at = (sx: number, sy: number) => ground(sx, sy);
  const props: Standing[] = [];
  for (const [sx, prop, v] of [
    [-372, "cargo", 0],
    [-238, "crane", 0],
    [-112, "cargo", 1],
    [18, "cargo", 0],
    [140, "crane", 0],
  ] as Array<[number, PropId, number]>)
    props.push({ prop, ...at(sx, 486), v });
  for (let sx = HOME_QUAY.sx0 + 22; sx < HOME_QUAY.sx1 - 10; sx += 65) props.push({ prop: "bollard", ...at(sx, HOME_QUAY.sy - 2.5) });
  props.push({ prop: "firetower", ...at(HOME_QUAY.sx1 + 8, HOME_QUAY.sy - 10), v: 0, key: "firetower" });
  props.push({ prop: "cargo", ...at(-330, 462), v: 2 });
  props.push({ prop: "olive", ...at(-20, 452), v: 3 });
  props.push({ prop: "olive", ...at(-400, 470), v: 1 });
  props.push({ prop: "amphora", ...at(60, 470) });
  return props;
}

/** Everything standing in the rival's city, placed (world). */
export function romeProps(): Standing[] {
  const props: Standing[] = [];
  const put = (prop: PropId, a: number, b: number, v = 0, extra: Partial<Standing> = {}) => props.push({ prop, ...romePoint(a, b), v, ...extra });
  // The wall, the gatehouse and the towers; banners on the gate towers.
  const g = ROME_LINES.gate;
  put("gatehouse", g, 0, 0, { key: "gate" });
  for (const b of ROME_WALL.towers) put("tower", g, b, ROME_WALL.guns.includes(b) ? 0 : 1);
  for (const [b0, b1] of ROME_WALL.runs) {
    // Each run in short pieces, so soldiers near it sort against the right piece.
    const pieces = Math.max(1, Math.round((b1 - b0) / 24));
    const step = (b1 - b0) / pieces;
    for (let i = 0; i < pieces; i++) put("wall", g, b0 + step * (i + 0.5), Math.round(step / 2));
  }
  // The temple over the forum, a column of honour, a fountain; cypresses round the forum.
  put("temple", -24, -152);
  put("column", 66, -84);
  put("fountain", -48, 104, 0, { key: "fountain" });
  for (const a of [-70, 4, 40, 80]) put("cypress", a, -104, Math.abs(a) % 3);
  for (const a of [10, 60]) put("cypress", a, 132, (a / 10) % 3);
  put("pine", -60, -120, 1);
  put("pine", 96, 150, 2);
  // Warehouses along the quay past the forum, cranes and cargo on it, bollards along its edge.
  put("horreum", -84, 168);
  put("crane", -104, 92);
  put("crane", -104, -96);
  put("cargo", -100, 128, 0);
  put("cargo", -100, -128, 1);
  for (let b = -190; b <= 196; b += 38) if (!ROME_BERTHS_B.some((berth) => Math.abs(berth - b) < 12)) put("bollard", ROME_LINES.quay + 2.5, b);
  // The lighthouse at the end of the mole.
  put("pharos", -192, -210, 0, { key: "pharos" });
  // The town beyond the wall: houses along the main street and the cross street, the amphitheatre,
  // the aqueduct striding in behind the temple.
  let n = 0;
  for (const a of [160, 248, 296]) {
    for (const side of [1, -1]) {
      for (let b = 32; b <= 190; b += 34) {
        const bb = side * b;
        if (a > 220 && bb < -50 && bb > -190) continue;
        put("house", a, bb, (n++ * 7 + (a > 200 ? 1 : 0)) % 4);
      }
    }
  }
  put("amphitheatre", 292, -122);
  for (const b of [24, -24]) put("cypress", 182, b, 1);
  put("aqueduct", 60, -262, 108);
  put("aqueduct", 160, -262, 108);
  return props;
}

/** The screen rectangle (art px) that frames the home harbour with the agora above it. */
export const HARBOR_VIEW = { x0: -440, x1: 210, y0: 360, y1: 560 };

/** The screen rectangle (art px) of the city's battle: the ships at the quay, the forum, the gate. */
export const ROME_VIEW = { x0: ROME.x - ROME.y - 290, x1: ROME.x - ROME.y + 290, y0: (ROME.x + ROME.y) / 2 - 220, y1: (ROME.x + ROME.y) / 2 + 140 };

/** World tiles that together cover a world rectangle, `size` on a side. */
function tilesOver(r: { x0: number; y0: number; x1: number; y1: number }, size: number) {
  const tiles: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  for (let x = r.x0; x < r.x1; x += size) for (let y = r.y0; y < r.y1; y += size) tiles.push({ x0: x, y0: y, x1: Math.min(r.x1, x + size), y1: Math.min(r.y1, y + size) });
  return tiles;
}

/** The world rectangle around a screen rectangle. */
function worldAround(v: { x0: number; y0: number; x1: number; y1: number }) {
  const corners = [ground(v.x0, v.y0), ground(v.x1, v.y0), ground(v.x0, v.y1), ground(v.x1, v.y1)];
  return { x0: Math.min(...corners.map((c) => c.x)), y0: Math.min(...corners.map((c) => c.y)), x1: Math.max(...corners.map((c) => c.x)), y1: Math.max(...corners.map((c) => c.y)) };
}

/** The sea, baked in tiles: those that hold some of it. */
export function seaTiles() {
  const box = worldAround({ x0: SEA.cx - SEA.hw - 40, y0: SEA.cy - SEA.hh - 40, x1: SEA.cx + SEA.hw + 40, y1: SEA.cy + SEA.hh + 40 });
  return tilesOver(box, 200).filter((t) => {
    // Keep a tile if any of a grid of its points lies inside the sea's screen box.
    for (let i = 0; i <= 4; i++) {
      for (let j = 0; j <= 4; j++) {
        const x = t.x0 + ((t.x1 - t.x0) * i) / 4;
        const y = t.y0 + ((t.y1 - t.y0) * j) / 4;
        const sx = x - y;
        const sy = (x + y) / 2;
        if (Math.abs(sx - SEA.cx) < SEA.hw + 30 && Math.abs(sy - SEA.cy) < SEA.hh + 30) return true;
      }
    }
    return false;
  });
}

/** The city's land, baked in tiles (each with the shadows of what stands near it). */
export function romeTiles() {
  const land = romeLand();
  const reach = (l: { cx: number; cy: number; r: number }) => ({ x0: l.cx - l.r, y0: l.cy - l.r, x1: l.cx + l.r, y1: l.cy + l.r });
  const parts = [{ x0: land.cx - land.rx, y0: land.cy - land.ry, x1: land.cx + land.rx, y1: land.cy + land.ry }, ...(land.lobes ?? []).map(reach)];
  const pad = (land.wobble ?? 0) + (land.rim ?? 0);
  const box = {
    x0: ROME.x + Math.min(...parts.map((p) => p.x0)) - pad,
    y0: ROME.y + Math.min(...parts.map((p) => p.y0)) - pad,
    x1: ROME.x + Math.max(...parts.map((p) => p.x1)) + pad,
    y1: ROME.y + Math.max(...parts.map((p) => p.y1)) + pad,
  };
  return tilesOver(box, 130);
}

/** Islets in the sea, off the fleet's course (screen positions, world radius), and what stands on each. */
export const ISLETS: Array<{ sx: number; sy: number; r: number; props: Array<{ prop: PropId; dx: number; dy: number; v?: number }> }> = [
  {
    sx: -395,
    sy: 705,
    r: 26,
    props: [
      { prop: "ruin", dx: -2, dy: -4 },
      { prop: "cypress", dx: 12, dy: -10, v: 2 },
      { prop: "rocks", dx: 20, dy: 14, v: 1 },
    ],
  },
  {
    sx: 330,
    sy: 640,
    r: 22,
    props: [
      { prop: "pine", dx: -2, dy: -3, v: 0 },
      { prop: "rocks", dx: 13, dy: 8, v: 2 },
    ],
  },
  {
    sx: -360,
    sy: 985,
    r: 18,
    props: [
      { prop: "rocks", dx: 0, dy: 0, v: 0 },
      { prop: "cypress", dx: -8, dy: -8, v: 1 },
    ],
  },
];

/** An islet's centre (world). */
export function isletAt(i: number): Point {
  return ground(ISLETS[i].sx, ISLETS[i].sy);
}

export function isletIsland(i: number): IslandSpec {
  return { cx: 0, cy: 0, rx: ISLETS[i].r, ry: ISLETS[i].r * 0.9, seed: 181 + i * 17, rim: 8, wobble: 9, grass: 0.7 };
}

/** The sea between the harbours (screen space): a rounded box. */
export const SEA = { cx: 10, cy: 790, hw: 480, hh: 335 };

/** Everywhere the camera may go: the world, down across the sea to the city. */
export const MAP_BOUNDS = { x0: WORLD_VIEW.x0, x1: Math.max(WORLD_VIEW.x1, ROME_VIEW.x1 + 200), y0: WORLD_VIEW.y0, y1: ROME_VIEW.y1 + 120 };
