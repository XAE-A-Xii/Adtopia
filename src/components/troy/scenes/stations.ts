import { BAY, STABLE, STABLE_GATE, type StationId } from "./layout";

export { STABLE, STABLE_GATE };

// What stands on each island, relative to the island's centre (world units), and where the
// agents work. Props are their own sprites so figures can walk in front of and behind them.

export type PropId =
  | "tower"
  | "basket"
  | "signpost"
  | "shrine"
  | "pavilion"
  | "maptable"
  | "desk"
  | "easel"
  | "reels"
  | "tier"
  | "screen"
  | "podium"
  | "banner"
  | "olive"
  | "amphora"
  | "campfire"
  // The command table in the middle of the HQ, and the bikes' charging rail on the street.
  | "hub"
  | "bikerack"
  // The stations' readable pieces: the city map, the film set, render servers, the analytics board,
  // the broadcast mast, and the platforms' billboards on the street.
  | "mapscreen"
  | "filmset"
  | "renderfarm"
  | "dashboard"
  | "mast"
  | "billboard"
  // The street's lamps and its passing hover cars (v: paint, + 4 heading the other way).
  | "streetlamp"
  | "car"
  | "rail"
  // The lands' landmarks (engine/models/lands.ts).
  | "phone"
  | "gallery"
  | "bigscreen"
  | "billboards"
  | "forum"
  | "orbshrine"
  | "crystal"
  | "beacon"
  | "huts"
  | "gate"
  // The engines of war (engine/models/battle.ts).
  | "catapult"
  | "ballista"
  | "fort"
  // The home harbour (engine/models/ships.ts).
  | "crane"
  | "cargo"
  | "bollard"
  | "firetower"
  // The rival's city (engine/models/rome.ts).
  | "temple"
  | "wall"
  | "tower"
  | "gatehouse"
  | "house"
  | "amphitheatre"
  | "aqueduct"
  | "pharos"
  | "cypress"
  | "pine"
  | "column"
  | "fountain"
  | "horreum"
  | "standard"
  | "rocks"
  | "ruin";

export type Placement = { prop: PropId; x: number; y: number; v?: number; key?: string; sort?: number };

export type Spot = { x: number; y: number; z?: number; dir: number };

/** A point on the way to a post (relative to the island), with the act and heading for that leg. */
export type Waypoint = { x: number; y: number; z: number; act?: "climb" | "march"; dir?: number };

/**
 * Desk slots in the workshop: the editing bay, two rows of three along the mezzanine's wall beside
 * the studio. Desks face the camera; the editor sits at EDITOR_OFFSET from it.
 */
export const DESK_SLOTS: Array<{ x: number; y: number }> = [
  { x: -50, y: 2 },
  { x: -32, y: 2 },
  { x: -50, y: 21 },
  { x: -32, y: 21 },
  { x: -50, y: 40 },
  { x: -32, y: 40 },
];


/** The library ladder against the scripts' bookshelf, where the strategist climbs for a binder (relative to the strategy station). */
export const LADDER = { x: -23, y: 33 };

/**
 * The viral study's format table (relative to the station): the analysts round it, and the two
 * colleagues who sit with the reference analyst (scenery: they work when the station works).
 */
export const FORMAT_TABLE = { x: -6, y: -2 };
export const ORACLE_SEATS: Spot[] = [
  { x: FORMAT_TABLE.x - 3, y: FORMAT_TABLE.y + 10.5, dir: 6 },
  { x: FORMAT_TABLE.x + 3, y: FORMAT_TABLE.y - 10.5, dir: 2 },
];

/** Where an editor sits relative to their desk (on the stool, in front of the screen). */
export const EDITOR_OFFSET = { x: 4.95, y: 4.95, dir: 5 };


export const PROPS: Record<StationId, Placement[]> = {
  scouts: [
    // The intake bin for the scouts' data at the end of the operators' desk.
    { prop: "basket", x: 14, y: -27, v: 0, key: "basket" },
    // The wall map of the street with its operators' desk, against the right wall.
    { prop: "mapscreen", x: -2, y: -36, v: 0, key: "map" },
    { prop: "olive", x: 36, y: -28, v: 1 },
  ],
  oracle: [
    // The format table: the analysts sit round it, the viral videos playing as holograms over it.
    { prop: "shrine", x: FORMAT_TABLE.x, y: FORMAT_TABLE.y, v: 0, key: "shrine" },
    { prop: "olive", x: 12, y: -30, v: 2 },
    { prop: "amphora", x: -32, y: 32 },
    { prop: "amphora", x: -28, y: 37 },
  ],
  tent: [
    // The writer's desk under the cork board; the bookshelf and its ladder are the room's.
    { prop: "pavilion", x: -28, y: -12 },
    { prop: "olive", x: 24, y: -40, v: 3 },
    { prop: "olive", x: 4, y: 22, v: 6 },
  ],
  workshop: [
    // The presenter's mark in the studio, the camera and lights in front of it.
    { prop: "filmset", x: -42, y: -38, v: 0, key: "filmset" },
    // The frame artist's screen beside the studio, the render servers along the mezzanine's wall.
    { prop: "easel", x: -8, y: -50, v: 0, key: "easel" },
    { prop: "renderfarm", x: 24, y: -59, v: 0, key: "farm" },
    { prop: "reels", x: -54, y: 58, v: 0, key: "reels" },
    { prop: "olive", x: -58, y: -8, v: 4 },
    { prop: "olive", x: 50, y: -46, v: 2 },
  ],
  theatre: [
    { prop: "screen", x: -15, y: -15, key: "screen" },
    // Each row of seats is its own sprite so spectators layer between rows (see SPOTS.audience).
    { prop: "tier", x: -15, y: -15, v: 0, sort: 18 },
    { prop: "tier", x: -15, y: -15, v: 1, sort: 24 },
    { prop: "tier", x: -15, y: -15, v: 2, sort: 30 },
    { prop: "olive", x: 26, y: -28, v: 5 },
  ],
  agora: [
    { prop: "podium", x: -6, y: -6, v: 0, key: "podium" },
    { prop: "banner", x: 14, y: -10, v: 0, key: "banner0" },
    { prop: "banner", x: 24, y: -4, v: 4, key: "banner1" },
    { prop: "banner", x: -20, y: 16, v: 8, key: "banner2" },
    { prop: "dashboard", x: -26, y: -26, v: 0, key: "dashboard" },
    { prop: "mast", x: 30, y: -28, v: 0, key: "mast" },
    { prop: "olive", x: -34, y: 22, v: 6 },
    { prop: "amphora", x: 26, y: 18 },
  ],
};

/** Named places where agents stand or sit (relative to the island centre). */
export const SPOTS = {
  /** In the operator's chair at the map desk, facing the wall map. */
  lookout: { x: -14, y: -34, z: 0, dir: 6 },
  queue: (i: number): Spot => ({ x: -6 + (i % 3) * 5, y: 0 + Math.floor(i / 3) * 6 - (i % 3) * 2, dir: 6 }),
  basket: { x: 14, y: -18, dir: 6 },
  /** Where scouts leave the island (toward the outside of the camp) and come back. */
  exits: [
    { x: -38, y: 26, dir: 2 },
    { x: -42, y: -6, dir: 3 },
    { x: -16, y: 38, dir: 2 },
  ] as Spot[],
  /** On the shrine's floor (its top step is at z 2.8), facing the television. */
  /** At the format table's end, facing along it. */
  watcher: { x: FORMAT_TABLE.x + 15, y: FORMAT_TABLE.y, z: 0, dir: 4 },
  /** Up the shrine's two steps from the front. */
  watcherSteps: [
    { x: 5, y: -9, z: 0, dir: 4 },
    { x: -0.3, y: -10, z: 1.6, dir: 4 },
  ] as Waypoint[],
  /** At the cork board, facing it. */
  general: { x: -31, y: -40, dir: 4 },
  /** In the chair at the writer's desk, facing the wall. */
  scribe: { x: -22, y: -11, dir: 4 },
  /** Up the library ladder, a binder open. */
  ladder: { x: LADDER.x - 3.6, y: LADDER.y, z: 24, dir: 4 },
  ladderClimb: [
    { x: LADDER.x + 3, y: LADDER.y, z: 0, dir: 4 },
    { x: LADDER.x - 3.4, y: LADDER.y, z: 23.8, act: "climb", dir: 4 },
  ] as Waypoint[],
  painter: { x: -3.5, y: -50, dir: 4 },
  // Seated on the tiers (centre -15, -15), near the middle of the arc so row sorting holds.
  // `z` is the seat top; seated figures are drawn lower by WATCH_DROP.
  audience: [
    { x: -2.7, y: -6.4, z: 1.2, dir: 5 },
    { x: -6.4, y: -2.7, z: 1.2, dir: 5 },
    { x: 0.6, y: -1.8, z: 2.4, dir: 5 },
    { x: 1.8, y: 3.6, z: 3.6, dir: 5 },
  ] as Spot[],
  herald: { x: -6, y: -6, z: 5.1, dir: 1 },
  /** Onto the podium by its step on the +x side. */
  heraldSteps: [
    { x: 4, y: -6, z: 0, dir: 4 },
    { x: 0.6, y: -6, z: 2.2, dir: 4 },
  ] as Waypoint[],
  /** Where the courier waits between dispatches: by the stable, near his horse. */
  courier: { x: -30, y: 6, dir: 4 },
  /** The inspector's place in the workshop while no shot is in quality check. */
  inspector: { x: -14, y: 8, dir: 5 },
  /** Where the audience waits, standing, until there is a cut to watch. */
  audienceRest: [
    { x: 28, y: -2, dir: 5 },
    { x: 22, y: 4, dir: 5 },
    { x: 32, y: 6, dir: 5 },
    { x: 26, y: 11, dir: 5 },
  ] as Spot[],
};


/**
 * Eight horses tied along the rail, facing it (+x, heads over the rail toward the island), and
 * where a rider stands to mount each one: behind its rump, in the aisle. The last stall, nearest
 * the gate, is the courier's, so dispatches never wait behind the research.
 */
// Eight bikes in a row along the kerb (world points on the pavement), facing the road (-y), and
// where a rider stands to get on each: behind it, toward the wall.
export const STALLS = [0, 1, 2, 3, 4, 5, 6, 7].map((k, i) => ({
  horse: { x: BAY.x + k * 7, y: BAY.y - 3, dir: 6 },
  mount: { x: BAY.x + k * 7, y: BAY.y + 6, dir: 6 },
  /** Its horse's coat (bay, chestnut, dun, grey, black: see COATS), never the same as its neighbour's; the courier's is grey. */
  coat: [0, 1, 4, 2, 0, 1, 2, 3][i],
}));
export const COURIER_STALL = STALLS.length - 1;
/**
 * The aisle behind the horses: everyone walks or rides along it between the gate and a stall, so
 * nobody passes through a tied horse. `south` is where it meets the way to the gate.
 */
export const STABLE_AISLE = { y: BAY.y + 9 };

/**
 * On every land (relative to its centre): its landmark, where scouts stand to gather in front of
 * it, and where they leave their horses meanwhile. Spot `i` goes with horse `i`.
 */
export const LAND_SPOTS = {
  // The shop front stands at the back of its lot, facing the road (+y).
  landmark: { x: 0, y: -10 },
  gather: [
    { x: -6, y: 6, dir: 6 },
    { x: 6, y: 7, dir: 6 },
    { x: -12, y: 10, dir: 6 },
    { x: 12, y: 11, dir: 6 },
  ] as Spot[],
  // Bikes park in the parking lane just off the shops' kerb, clear of the traffic.
  horses: [
    { x: -12, y: 22, dir: 0 },
    { x: 0, y: 22, dir: 0 },
    { x: 12, y: 22, dir: 0 },
    { x: -6, y: 26.5, dir: 0 },
  ] as Spot[],
};

/** Seated spectators sit this far below the seat top (their feet rest on the step below). */
export const WATCH_DROP = 2.4;
