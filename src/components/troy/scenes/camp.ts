import { type Act, ACT_FRAMES, ACT_RATE, dirFor, type Job, RIDER_FRAMES } from "../engine/jobs";
import { exitPath } from "../engine/models/horse";
import { textPixel, textWidth } from "../engine/font";
import { wallLamps } from "../engine/models/hq";
import { storefrontSize } from "../engine/models/cyber";
import { type GlowSource, GlowLayer, NEON } from "../engine/glow";
import { SCREEN } from "../engine/models/props";
import type { CameraTarget, Entity, Stage } from "../engine/stage";
import { projectX, projectY } from "../engine/tracer";
import type { Point } from "../engine/walker";
import type { AgentPlan, CampPlan } from "./derive";
import type { LandingScene } from "./landing";
import { type Enlisted, Expedition } from "./expedition";
import { SETBACK, VICTORY } from "./battle";
import { BAY, CAMP_CENTER, flowLine, CAR_LANES, DECK, ENTRANCE, FAR_KERB, HQ_SIGN, INNER, KERB, STUDIO, VIDEO_WALL, LAND_Z, LOFT, ROOM, STABLE, stableGate, STREET_LANE, upStairs, ROOM_CENTER, ROOM_HALF, STAIRS, STAIRS_TOP, HARBOR_VIEW, hub, ISLAND_RADIUS, JUNCTION, LAND, type LandId, LANDS, LANDS_VIEW, MAP_BOUNDS, type Node, ROME, ROME_VIEW, roadToLand, sandbars, scoutLand, STATION, type StationId, STATIONS, travel, WORLD_VIEW, worldTrails } from "./layout";
import { COURIER_STALL, DESK_SLOTS, LAND_SPOTS, ORACLE_SEATS, PROPS, SPOTS, STABLE_AISLE, STABLE_GATE, STALLS, type Waypoint } from "./stations";

// The camp: station islands, their furniture and the agents, below the horse. This file owns the
// world; Camp.tsx owns the HTML around it and feeds it plans derived from the live campaign.
//
// Agents are people, not icons: each one comes out of the horse and walks the sandbars to its
// station, walks between its posts as the plan changes, climbs up to the tower or the podium, and
// goes back into the horse when it is no longer needed. Scouts take a horse from the stable and
// ride out to the land of the website or API they fetch from (TikTok, Reddit, the brand's own
// site...), gather there, then ride back with a scroll case and drop it in the basket. A courier
// rides each finished piece of work to the next station. Nobody appears or dissolves in the open.

/**
 * World units per second. Brisk enough that the camp keeps up with the campaign: soldiers march
 * at double time on the roads and riders gallop flat out.
 */
const SPEED = { column: 46, walk: 24, home: 40, run: 54, ride: 135, courier: 92 };

/** Seconds a figure holds still for small moments: mounting, unsaddling, a handover, a drop, the shortest visit to a land. */
const BEAT = { mount: 0.25, dismount: 0.25, gather: 1.2, drop: 0.45, pickup: 0.25, handover: 0.35 };

/** Who speaks for each station when work changes hands (the theatre's is you: the courier talks alone). */
const HEAD: Record<StationId, string | null> = { scouts: "lookout", oracle: "watcher", tent: "general", workshop: "inspector", theatre: null, agora: "herald" };

/** What a scout does at each land while gathering. */
const LAND_ACT: Record<LandId, Act> = {
  site: "inspect",
  similarweb: "inspect",
  ahrefs: "read",
  tiktok: "inspect",
  instagram: "inspect",
  youtube: "inspect",
  metaads: "read",
  reddit: "read",
  chatgpt: "read",
  perplexity: "read",
};

/** World units per full stride cycle: longer strides at speed, so a march becomes a run, not a scurry. */
function strideLength(speed: number) {
  return Math.max(14, speed * 0.42);
}

/** A point to move to, with the act and heading for the leg that ends there. */
type Step = Point & { act?: Act; dir?: number };

/** `coat`: the coat of the horse it rides or last rode (see STALLS). */
type Figure = Entity & { look: number; act: Act; dir: number; coat: number };

type Agent = {
  plan: AgentPlan;
  entity: Figure;
  /** Where the figure is: waiting to come out of the horse, on the move, at its post, gathering at a land, or back inside the horse. */
  where: Where;
  /** A sequence (a walk, a ride) is running; `settle` decides what is next when it ends. */
  busy: boolean;
  /** The island (or the horse) the figure is on, for routing. */
  node: Node;
  /** Steps that took the figure up to its post (a ladder, a step), walked back down to leave. */
  up: Step[] | null;
  /** The plan took this agent away: it goes back into the horse. */
  dismissed: boolean;
  /** Scouts: this run is over for them (the case is in the basket, or they came back empty). */
  finished: boolean;
  /** Scouts: the scroll case is in the basket. */
  delivered: boolean;
  /** The stall whose horse this agent is riding, while mounted. */
  stall: number | null;
  /** Out on a run on foot (every horse was out). */
  onFoot: boolean;
  /** A scout at a land: when it started gathering. */
  gatherSince: number;
  phase: number;
  /** For queued agents: their place in the column (sideways offset on the sandbars). */
  lane: number;
  /** What the figure is doing while on the move or busy (see AgentInfo.doing). */
  doing: string;
  /** The courier: the errand he is on, and how many he has finished. */
  errand: { from: StationId; to: StationId } | null;
  deliveries: number;
  /** A scout's trip, as the camp shows it (it can trail the data by a few seconds). */
  trip: Trip;
  /** A scout at a land: its spot there (and its horse's). */
  slot: number | null;
  /** The frame of its act it was last drawn at (an archer looses on the release frame). */
  frame: number;
};

type Where = "queued" | "moving" | "posted" | "afield" | "home" | "expedition";

/** A scout's trip: in camp, riding out, at the land, riding back, then over (with the case, or empty). */
type Trip = "camp" | "out" | "there" | "back" | "done" | "empty";

type Stall = { steed: Entity; rider: Agent | null };

/** How a station is named in a sentence ("walking over to the war tent"). */
const PLACE: Record<Node, string> = { upper: "the top of the inner stairs", lower: "the foot of the inner stairs", horse: "the street door", scouts: "the research desk", oracle: "the format table", tent: "the writers' corner", workshop: "the production studio", theatre: "the review lounge", agora: "the publishing desk" };

/** What a figure standing at its post looks like it is doing, by its act. */
const ACT_WORDS: Record<Act, string> = {
  stand: "Standing by",
  march: "On the march",
  carry: "Carrying a data package",
  climb: "Climbing",
  type: "Typing at the desk",
  paint: "Making a first frame",
  inspect: "Studying a shot through a lens",
  read: "Taking notes",
  lookout: "Watching the wall map",
  herald: "Sending the posts out from the uplink",
  point: "Pointing out the plan on the cork board",
  cheer: "Cheering",
  sit: "Sitting",
  watch: "Watching the screen",
  fight: "Fighting in the front rank",
  charge: "Charging",
  shoot: "Loosing arrows at the enemy",
  fallen: "Knocked down",
  haul: "Winding the catapult",
};

/** What the camp can say about one agent, for the agent card. */
export type AgentInfo = {
  /** Where the figure is: on the move, at its post, gathering at a land, inside the horse, or away with the fleet. */
  where: Where;
  /** What it is doing right now, in a short sentence. */
  doing: string;
  mounted: boolean;
  /** On the map (the camera can follow it). */
  visible: boolean;
  /** The courier's errand, if any, and how many he has run. */
  errand: { from: StationId; to: StationId } | null;
  deliveries: number;
  /** A scout's trip: still in camp, riding out, at the land, riding back, or over. */
  trip: Trip;
  /** A scout: the land it fetches from. */
  land: LandId | null;
  /** The coat of the horse it rides (or last rode). */
  coat: number;
};

export type CampEvents = {
  /** The courier reached a station with work for it. */
  onArrive?: (station: StationId) => void;
  /**
   * Two agents talk as work changes hands: the station's head gives it to the courier (pickup), and
   * the courier gives it to the next station's head (handover). `key` is the dispatch's.
   */
  onExchange?: (exchange: { key: string; from: StationId; to: StationId; phase: "pickup" | "handover"; speakers: string[] }) => void;
  /** A soldier calls something out: a line over his head for a few seconds. */
  onSay?: (line: { id: string; text: string; seconds: number }) => void;
};

/** What the soldiers call out at the big moments. */
export const LINES = {
  /** The first soldier out of the horse, leading the column into the camp: the brand's men. */
  rollOut: (brand: string | null) => `Team ${brand?.trim() || "Adtopia"}, down to the HQ! Let's roll out!`,
};

/** The shops whose billboards show the posted videos: the three platforms Adtopia posts to. */
const BILLBOARD_LANDS: LandId[] = ["tiktok", "instagram", "youtube"];

/** Where the street's cars drive from and to (world x); they wrap round. */
const CAR_X0 = -62;
const CAR_X1 = ROOM.x1 + 152;

/** The point `t` (0..1) of the way along a path of world points, by distance. */
function alongPath(path: Point[], t: number): Point {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y, path[i].z - path[i - 1].z);
  let left = Math.max(0, Math.min(1, t)) * total;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    if (left <= d || i === path.length - 1) {
      const k = d ? Math.min(1, left / d) : 1;
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k };
    }
    left -= d;
  }
  return { ...path[path.length - 1] };
}

/**
 * The whole map's rectangle on screen (art px): from the basement's left corner to the far end of
 * the street, from the logos on the roofs (and the HQ's aerial) down to the basement's front corner.
 */
function mapView() {
  const roofs = LANDS.map((l) => (l.x - 18 + l.y - 32) / 2 - 1.2247 * (LAND_Z + storefrontSize(l.prop).tall + 32));
  const hq = (ENTRANCE.x - ENTRANCE.half + ENTRANCE.y - ENTRANCE.depth) / 2 - 1.2247 * (ROOM.wall + ENTRANCE.tall + 32);
  // The street's slab: its far right corner is the map's right end.
  const streetEnd = ROOM.x1 + 160 - (ROOM.y0 - 172);
  return { x0: ROOM.x0 - ROOM.y1 - 14, x1: streetEnd + 10, y0: Math.min(hq, ...roofs) - 6, y1: (ROOM.x1 + ROOM.y1) / 2 + 16 };
}

/** "#rrggbb" as "r, g, b". */
function hexRgb(hex: string) {
  const n = Number.parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

export class CampScene {
  readonly grounds: Entity[] = [];
  private readonly props: Entity[] = [];
  private readonly keyed = new Map<string, Entity>();
  private readonly streetLamps: Entity[] = [];
  /** The pedestrians in front of each platform's billboard (shown as the views come in). */
  private readonly crowds = new Map<LandId, Entity[]>();
  /** The viral study's two analysts at the format table with the reference analyst: scenery that works when the station does. */
  private readonly analysts: Array<Entity & { look: number; act: Act }> = [];
  /** The posts' story on the street, from the plan's battle: who is out, the numbers, the result. */
  private street: { sending: boolean; live: string[]; views: number; likes: number; ratio: number | null; illustrative: boolean } = { sending: false, live: [], views: 0, likes: 0, ratio: null, illustrative: false };
  private billboardBuffers = new Map<string, HTMLCanvasElement>();
  /** The video wall's picture, drawn a pixel per world unit and stretched onto the wall. */
  private wallBuffer: HTMLCanvasElement | null = null;
  /** Bigger stills of the finished videos for the wall (36 x 64). */
  private readonly bigPosters = new Map<string, HTMLCanvasElement>();
  /** Until when everyone cheers at the video wall, and why (for the wall's caption). */
  private cheerUntil = -1;
  private cheerWhy = "";
  /** The stations' states last time, to notice the moments worth a celebration. */
  private lastStates: Partial<Record<StationId, string>> = {};
  /** What the video wall shows, from the plan. */
  private wallMode: "idle" | "rendering" | "screening" | "live" = "idle";
  private deskStates: number[] = [];
  /** Packets of work running between stations along the floor (see dispatch). */
  private readonly packets: Array<{ from: StationId; to: StationId; at: number; path: Point[] }> = [];
  private readonly cars: Array<{ entity: Entity; dir: number; rgb: string; lane: number }> = [];
  private readonly glow: GlowLayer;
  private staticGlow: GlowSource[] | null = null;
  /** Whether posts are going out. */
  private uplinkOn = false;
  private readonly desks = new Map<number, Entity & { state: number }>();
  private readonly agents = new Map<string, Agent>();
  /** Agents waiting to come out of the horse, in order. */
  private readonly column: Agent[] = [];
  private readonly stalls: Stall[] = [];
  private readonly dispatches: Array<{ from: StationId; to: StationId; key: string }> = [];
  private readonly posters = new Map<string, HTMLCanvasElement | null>();
  private posterList: CampPlan["posters"] = [];
  private showing = false;
  private revealT = 0;
  /** When (seconds into the reveal) each ground and prop starts to appear; others follow the camp's props. */
  private readonly revealAt = new Map<Entity, number>();
  /** Scouts gathering at each land, by spot; and the horses they left there. */
  private readonly landSpots = new Map<LandId, Array<Agent | null>>();
  private readonly landSteeds = new Map<Agent, Entity>();
  private time = 0;
  private tvOn = false;
  private planned = false;
  /** The column is marching in from the horse: the first plan queues everyone instead of placing them. */
  private entering = false;
  private brandId: string | null = null;
  /** The brand the column fights for, named in the first soldier's call out of the horse. */
  brandName: string | null = null;
  private recruited = 0;
  /** The leader has called the column out of the horse (once per camp). */
  private calledOut = false;
  events: CampEvents = {};
  /** The agent whose card is open, and the one under the pointer. */
  selected: string | null = null;
  hovered: string | null = null;
  /** The expedition below the agora: the harbour, the fleet, the sea, the rival's city and its legion (the Greeks are agents). */
  readonly expedition: Expedition;
  /** The expedition's scenery, baked after the camp's own. */
  private readonly far: Entity[] = [];
  /** `big`: around a rider rather than a soldier on foot. */
  private readonly ring: Entity & { big: boolean };
  private readonly hoverRing: Entity & { big: boolean };
  private readonly marker: Entity & { big: boolean };

  constructor(
    private readonly stage: Stage,
    private readonly landing: LandingScene,
  ) {
    // Grounds appear one after another, grain by grain: the camp's roads and islands, then the
    // roads west and the lands along them (see revealTick).
    const ground = (entity: Entity, at: number) => {
      this.grounds.push(stage.add(entity));
      this.revealAt.set(entity, at);
    };
    ground({ x: 0, y: 0, z: 0, ground: true, job: { k: "room" }, reveal: 0, priority: 6 }, 0);
    // The video wall's picture, drawn on the wall over the room (a ground layer, under everyone).
    stage.add({ x: 0, y: 0, z: 0, ground: true, paint: (ctx, sx, sy, px) => this.paintVideoWall(ctx, sx, sy, px) });
    // Bake the room while the visitor is still on the landing (after the HQ's door, which asks higher).
    void stage.baker.request({ k: "room" }, 3).catch(() => undefined);
    for (const station of STATIONS) {
      for (const placement of PROPS[station.id]) {
        const entity = stage.add({
          x: station.x + placement.x,
          y: station.y + placement.y,
          z: station.z,
          sort: placement.sort ?? 0,
          job: { k: "prop", id: placement.prop, v: placement.v ?? 0 },
          reveal: 0,
          priority: 4,
        });
        this.props.push(entity);
        if (placement.key) this.keyed.set(`${station.id}:${placement.key}`, entity);
      }
    }
    // The analysts at the format table.
    ORACLE_SEATS.forEach((seat, i) => {
      const oracle = STATION.oracle;
      const person: Entity & { look: number; act: Act } = Object.assign(
        stage.add({ x: oracle.x + seat.x, y: oracle.y + seat.y, z: oracle.z, shadowZ: oracle.z, shadow: 4, hidden: true, priority: 3, job: null as Job | null }),
        { look: (i * 3 + 1) % 6, act: "sit" as Act, dir: seat.dir },
      );
      this.analysts.push(person);
    });
    // The light trails out of the uplink.
    stage.add({ x: STATION.agora.x, y: STATION.agora.y, z: 0, sort: 60, paint: (ctx, sx, sy, px, time) => this.paintUplink(ctx, sx, sy, px, time) });
    // The street's lamps along the kerb, and hover cars passing both ways.
    for (let x = -50, i = 0; x < ROOM.x1 + 170; x += 52, i++) {
      if (Math.abs(x - STAIRS_TOP.x) < 16 || Math.abs(x - ENTRANCE.x) < 26 || (x > BAY.x - 6 && x < BAY.x + 56)) continue;
      const lamp = stage.add({ x, y: KERB + 3, z: LAND_Z, job: { k: "prop", id: "streetlamp", v: i % 8 }, reveal: 0, priority: 3.8 });
      this.props.push(lamp);
      this.streetLamps.push(lamp);
    }
    // On the shops' side, in the alleys between the buildings, their arms out over the road (v + 8).
    for (let k = 0; k < LANDS.length; k++) {
      if (k % 2) continue;
      const x = LANDS[k].x + 21;
      const lamp = stage.add({ x, y: FAR_KERB - 3, z: LAND_Z, job: { k: "prop", id: "streetlamp", v: 8 + (k % 8) }, reveal: 0, priority: 3.8 });
      this.props.push(lamp);
      this.streetLamps.push(lamp);
    }
    for (let i = 0; i < 4; i++) {
      const laneIndex = i % 2;
      const lane = CAR_LANES[laneIndex];
      const span = CAR_X1 - CAR_X0;
      // One speed per lane, so cars never catch up with each other; half the street apart.
      const speed = laneIndex ? 26 : 32;
      let lift = 0;
      const car: Entity = stage.add({
        x: CAR_X0 + ((Math.floor(i / 2) * 0.5 + laneIndex * 0.27) % 1) * span,
        y: lane.y,
        z: LAND_Z + 2.4,
        sort: 2,
        // Off the road until the HQ is showing.
        alpha: 0,
        hidden: true,
        job: { k: "prop", id: "car", v: (i % 4) + (lane.dir < 0 ? 4 : 0) },
        priority: 3.6,
        tick: (dt) => {
          // The road is quiet on the landing, until the HQ is showing, and while anyone walks
          // between the HQ's door and the stairs: the cars fade away and wait off the street's
          // ends, then drive back in one after another.
          const quiet = !this.showing || this.revealT < 1.2 || this.quietRoad;
          const alpha = Math.max(0, Math.min(1, (car.alpha ?? 1) + (quiet ? -2 : 2) * dt));
          car.alpha = alpha;
          if (quiet && alpha === 0) {
            const queue = Math.floor(i / 2) * 70;
            car.x = lane.dir > 0 ? CAR_X0 - queue : CAR_X1 + queue;
            lift = 0;
            car.hidden = true;
            return;
          }
          // Cars keep their lanes and their speed: a hover car rises over a scout riding across the
          // road to a shop, and settles back.
          const target = this.crossing(car, lane.dir) ? 27 : 0;
          lift += Math.sign(target - lift) * Math.min(Math.abs(target - lift), (target > lift ? 70 : 24) * dt);
          car.x += lane.dir * speed * dt;
          if (lane.dir > 0 && car.x > CAR_X1) car.x = CAR_X0;
          if (lane.dir < 0 && car.x < CAR_X0) car.x = CAR_X1;
          car.z = LAND_Z + 2.4 + lift + Math.sin(this.time * 2 + i) * 0.4;
          // Waiting their turn off the street's end, they are not there yet.
          car.hidden = car.x < CAR_X0 - 0.5 || car.x > CAR_X1 + 0.5;
        },
      });
      this.cars.push({ entity: car, dir: lane.dir, rgb: [NEON.pink, NEON.cyan, NEON.amber, NEON.blue][i % 4], lane: laneIndex });
    }
    // The platforms' billboards over their shops on the street (TikTok, Instagram, YouTube), each with
    // a crowd that gathers as the posted videos get views.
    for (const id of BILLBOARD_LANDS) {
      const land = LAND[id];
      const at = { x: land.x, y: land.y - 5.5, z: LAND_Z };
      const frame = stage.add({ x: at.x, y: at.y, z: at.z, sort: 1, job: { k: "prop", id: "billboard", v: 0 }, reveal: 0, priority: 3.9 });
      this.props.push(frame);
      stage.add({ x: at.x, y: at.y, z: at.z, sort: 1.5, paint: (ctx, sx, sy, px) => this.paintBillboard(id, ctx, sx, sy, px) });
      const crowd: Entity[] = [];
      for (let i = 0; i < 8; i++) {
        const spot = { x: land.x - 13 + (i % 4) * 8.5 + (i > 3 ? 4 : 0), y: land.y + 10 + (i > 3 ? 7 : 0) };
        const person: Entity & { look: number; act: Act } = Object.assign(stage.add({ x: spot.x, y: spot.y, z: LAND_Z, shadowZ: LAND_Z, shadow: 4, hidden: true, priority: 3, job: null as Job | null }), { look: (i * 5 + id.length) % 6, act: "stand" as Act });
        crowd.push(person);
      }
      this.crowds.set(id, crowd);
    }
    // The light over everything: neon halos that breathe and flicker, and drifting motes.
    this.glow = new GlowLayer(() => this.glowSources(), { x0: ROOM.x0 - 40, y0: ROOM.y0 - 110, x1: ROOM.x1 + 160, y1: ROOM.y1, z: ROOM.wall + 60 });
    this.glow.pixels = () => this.streetPixels();
    // Steam off the coffee on every editing desk (the cup sits at the desk's back right).
    this.glow.steam = () => [...this.desks.values()].filter((d) => (d.reveal ?? 1) > 0.9).map((d) => ({ x: d.x - 1.7, y: d.y + 3.7, z: 9.5 }));
    this.glow.setConfettiArea({ x0: ROOM.x0 + 10, y0: ROOM.y0 + 10, x1: ROOM.x1 - 10, y1: ROOM.y1 - 10, z: ROOM.wall });
    this.glow.addMotes({ x0: -45, y0: ENTRANCE.y - 10, x1: 45, y1: STREET_LANE + 20, z: ROOM.wall + 70, z0: ROOM.wall }, 26, true);
    stage.add({ x: 0, y: 0, z: 0, sort: 100_000, paint: (ctx, sx, sy, px, time) => this.glow.paint(ctx, sx, sy, px, time) });
    // Each land's landmark, and the signpost at the crossroads.
    LANDS.forEach((l, i) => {
      const landmark = stage.add({ x: l.x + LAND_SPOTS.landmark.x, y: l.y + LAND_SPOTS.landmark.y, z: LAND_Z, job: { k: "prop", id: l.prop, v: 0 }, reveal: 0, priority: 3.9 });
      this.props.push(landmark);
      this.revealAt.set(landmark, 2.3 + i * 0.12);
    });
    const signpost = stage.add({ x: JUNCTION.x - 3, y: JUNCTION.y - 3, z: JUNCTION.z, job: { k: "prop", id: "signpost", v: 0 }, reveal: 0, priority: 3.9 });
    this.props.push(signpost);
    this.revealAt.set(signpost, 2);
    // The harbour below the agora, the sea and the rival's city: they appear as you look at them.
    // The HQ has no harbour: the expedition still keeps its books (the agora's panel reads them), but
    // nothing of it is drawn.
    const unseen = Object.create(stage) as Stage;
    unseen.add = <T extends Entity>(entity: T) => {
      entity.hidden = true;
      return stage.add(entity);
    };
    this.expedition = new Expedition(unseen, {
      scenery: (entity) => this.far.push(entity),
      claim: (id) => {
        const agent = this.agents.get(id);
        if (!agent || agent.busy || agent.dismissed || agent.where !== "posted" || !this.atPost(agent)) return null;
        agent.where = "expedition";
        agent.up = null;
        return agent.entity;
      },
      release: (id) => {
        const agent = this.agents.get(id);
        if (!agent || agent.where !== "expedition") return;
        agent.where = "posted";
        agent.node = agent.plan.station;
        this.settle(agent);
      },
      say: (id, text, seconds) => this.say(id, text, seconds),
    });
    // Horses tied at the scouts' rail; they leave with a rider and come back with one.
    // The charging rail behind the bikes on the pavement, then the bikes along the kerb.
    const rack = stage.add({ x: STABLE.x, y: STABLE.y, z: BAY.z, job: { k: "prop", id: "bikerack", v: 0 }, reveal: 0, priority: 3.9 });
    this.props.push(rack);
    for (const stall of STALLS) {
      const steed = stage.add({ x: stall.horse.x, y: stall.horse.y, z: BAY.z, shadowZ: BAY.z, shadow: 8, job: { k: "steed", dir: stall.horse.dir, h: stall.coat }, reveal: 0, priority: 4 });
      this.props.push(steed);
      this.stalls.push({ steed, rider: null });
    }
    // The selected soldier gets a marker over its head and a ring at its feet; a hovered one a ring.
    this.ring = stage.add({ x: 0, y: 0, z: 0, hidden: true, big: false, paint: (ctx, sx, sy, px, time) => this.paintRing(ctx, sx, sy, px, time, false) });
    this.hoverRing = stage.add({ x: 0, y: 0, z: 0, hidden: true, big: false, paint: (ctx, sx, sy, px, time) => this.paintRing(ctx, sx, sy, px, time, true) });
    this.marker = stage.add({ x: 0, y: 0, z: 0, sort: 1e6, hidden: true, big: false, paint: (ctx, sx, sy, px, time) => this.paintMarker(ctx, sx, sy, px, time) });
    // The theatre screen shows finished videos, drawn over the screen prop.
    const screen = this.keyed.get("theatre:screen")!;
    stage.add({ x: screen.x, y: screen.y, z: 0, sort: 0.5, paint: (ctx, sx, sy, px) => this.paintScreen(ctx, sx, sy, px) });
    stage.add({ x: 0, y: 0, z: 0, tick: (dt) => this.tick(dt) });
  }

  /**
   * Someone is walking between the HQ's door and the stairs (the team coming out, or going home),
   * now or in the last two seconds: the road stays clear of cars meanwhile.
   */
  private quietRoad = false;
  private quietUntil = -1;

  private updateQuietRoad() {
    for (const agent of this.agents.values()) {
      const e = agent.entity;
      if (e.hidden || Math.abs(e.z - LAND_Z) > 3 || !this.stage.has(e)) continue;
      if (e.x > ENTRANCE.x - ENTRANCE.half && e.x < ENTRANCE.x + 30 && e.y > ENTRANCE.y && e.y < KERB) {
        this.quietUntil = this.time + 2;
        break;
      }
    }
    this.quietRoad = this.time < this.quietUntil;
  }

  /** True when someone is in the road just ahead of (or under) a car heading `dir`: the car rises over them. */
  private crossing(car: Entity, dir: number) {
    for (const agent of this.agents.values()) {
      const e = agent.entity;
      if (e.hidden || Math.abs(e.z - LAND_Z) > 3 || Math.abs(e.y - car.y) > 11 || !this.stage.has(e)) continue;
      const d = (e.x - car.x) * dir;
      if (d > -18 && d < 40) return true;
    }
    return false;
  }

  /** Starts baking the camp so it is ready when the column arrives, and forgets another brand's camp. */
  prepare(brandId: string) {
    if (this.brandId !== null && this.brandId !== brandId) this.reset();
    this.brandId = brandId;
    // The room first (it is what everyone sees), then the furniture, the street and its shops. The
    // expedition's scenery is never drawn in the HQ, so it is never baked: its sea and city tiles
    // are the biggest sprites there are and would hold up the workers.
    for (const entity of this.grounds) if (entity.job) void this.stage.baker.request(entity.job, 9);
    for (const entity of this.props) if (entity.job && !entity.hidden) void this.stage.baker.request(entity.job, 5);
  }

  /** Someone else (the greeter) calls the crew out: the first agent out says nothing. */
  muteRollOut() {
    this.calledOut = true;
  }

  /** The column is about to march out of the horse: everyone in the first plan walks in. */
  beginEntrance() {
    if (!this.planned) this.entering = true;
  }

  /** A soldier calls out a line (shown over his head by the camp's HTML). */
  say(id: string, text: string, seconds = 3.2) {
    this.events.onSay?.({ id, text, seconds });
  }

  /** Clears every agent, desk and errand (a different camp, or back to the landing). */
  reset() {
    for (const agent of this.agents.values()) this.stage.remove(agent.entity);
    this.agents.clear();
    this.column.length = 0;
    this.dispatches.length = 0;
    for (const desk of this.desks.values()) this.stage.remove(desk);
    this.desks.clear();
    for (const stall of this.stalls) {
      stall.rider = null;
      this.stage.add(stall.steed);
    }
    for (const steed of this.landSteeds.values()) this.stage.remove(steed);
    this.landSteeds.clear();
    this.landSpots.clear();
    this.expedition.reset();
    this.timers.length = 0;
    this.planned = false;
    this.entering = false;
    this.recruited = 0;
    this.calledOut = false;
    this.brandId = null;
    this.brandName = null;
  }

  show(visible: boolean) {
    this.showing = visible;
    if (visible && this.revealT === 0 && this.landing.isOpen) this.revealT = 0.0001;
  }

  /** The camera that frames the whole camp, leaving room for the panels around it. */
  /**
   * The camera on the whole map, centred on screen: the basement from its left corner to its front,
   * the street from end to end, and the buildings along it up to the logos on their roofs.
   */
  camera(insets: { top: number; bottom: number; right: number } = this.insets): CameraTarget {
    return this.fitView(mapView(), insets);
  }

  /** The zoom that fits the basement alone (the stations' close-ups come in from it). */
  private roomCamera(insets: { top: number; bottom: number; right: number } = this.insets): CameraTarget {
    const { width, height } = this.stage.size;
    // The basement from wall to wall, and the street above the right wall.
    const spanX = 2 * (ROOM_HALF * 2 + 16);
    const spanY = ROOM_HALF * 2 + ROOM.wall * 1.22 + 70;
    const usableW = width - insets.right - 24;
    const usableH = height - insets.top - insets.bottom;
    const fit = Math.min(usableW / spanX, usableH / spanY, 3.5);
    const zoom = this.stage.fitZoom(fit);
    const midY = CAMP_CENTER.sy - 108;
    return { x: CAMP_CENTER.sx + insets.right / 2 / zoom, y: midY + (insets.bottom - insets.top) / 2 / zoom, zoom };
  }

  insets = { top: 84, bottom: 72, right: 0 };

  /** The camera that shows the camp and every land around it (while the scouts are out). */
  world(insets: { top: number; bottom: number; right: number } = this.insets): CameraTarget {
    return this.fitView(WORLD_VIEW, insets);
  }

  /**
   * The tour's view of the street while the scouts are out: the shops from the first to the last,
   * their roofs and logos, the road and the bike bay at the top of the stairs, close enough to
   * follow the riders.
   */
  streetView(insets: { top: number; bottom: number; right: number } = this.insets): CameraTarget {
    const first = LANDS[0];
    const last = LANDS[LANDS.length - 1];
    const bay = { sx: BAY.x - BAY.y, sy: (BAY.x + BAY.y) / 2 - 1.2247 * BAY.z };
    return this.fitView({ x0: Math.min(first.sx, bay.sx) - 50, x1: last.sx + 40, y0: Math.min(first.sy, last.sy) - 195, y1: Math.max(last.sy, bay.sy) + 45 }, insets);
  }

  /** The camera on the home harbour, the agora above it, while the army boards (on a phone, close on the middle ships). */
  harborView(insets: { top: number; bottom: number; right: number } = this.insets): CameraTarget {
    if (this.narrow) return this.around({ x: -110, y: 478 }, 1.25, insets);
    return this.fitView(HARBOR_VIEW, insets);
  }

  /** The camera on the rival's city: the ships at its quay, the forum, the gate (on a phone, close on the fighting). */
  romeView(insets: { top: number; bottom: number; right: number } = this.insets): CameraTarget {
    if (this.narrow) return this.around({ x: ROME.x - ROME.y - 40, y: (ROME.x + ROME.y) / 2 - 30 }, 1.25, insets);
    return this.fitView(ROME_VIEW, insets);
  }

  /** A zoom that shows the fleet with the sea round it (the camera follows the ships). */
  fleetZoom(insets: { top: number; bottom: number; right: number } = this.insets) {
    return Math.max(this.fitView({ x0: 0, x1: 560, y0: 0, y1: 380 }, insets).zoom, this.narrow ? this.stage.fitZoom(1) : 0);
  }

  /** A phone-sized screen: the camera frames the action close up instead of fitting whole views. */
  private get narrow() {
    return this.stage.size.width < 700;
  }

  /** A camera on a screen point (art px) at about `zoom`, clear of the panels. */
  private around(p: { x: number; y: number }, zoom: number, insets: { top: number; bottom: number; right: number }): CameraTarget {
    const z = this.stage.fitZoom(zoom);
    return { x: p.x + insets.right / 2 / z, y: p.y + (insets.bottom - insets.top) / 2 / z, zoom: z };
  }

  /** The lands and the roads to them, with the scouts' island: the scouts' errands on a narrow screen. */
  lands(insets: { top: number; bottom: number; right: number } = this.insets): CameraTarget {
    return this.fitView(LANDS_VIEW, insets);
  }

  private fitView(v: { x0: number; y0: number; x1: number; y1: number }, insets: { top: number; bottom: number; right: number }): CameraTarget {
    const { width, height } = this.stage.size;
    const usableW = width - insets.right - 24;
    const usableH = height - insets.top - insets.bottom;
    const fit = Math.min(usableW / (v.x1 - v.x0), usableH / (v.y1 - v.y0), 3.5);
    const zoom = this.stage.fitZoom(fit);
    return { x: (v.x0 + v.x1) / 2 + insets.right / 2 / zoom, y: (v.y0 + v.y1) / 2 + (insets.bottom - insets.top) / 2 / zoom, zoom };
  }

  /** How far the viewer may pan and zoom: around the whole world, from all of it in view to close up. */
  limits(insets: { top: number; bottom: number; right: number } = this.insets) {
    const widest = Math.min(this.world(insets).zoom, this.lands(insets).zoom);
    const { dpr } = this.stage.size;
    return { bounds: { ...MAP_BOUNDS }, zoom: { min: Math.max(1 / dpr, widest * 0.8), max: 6 } };
  }

  /** How many scouts are out on an errand (riding, gathering or riding back). */
  get scoutsOut() {
    let n = 0;
    for (const count of Object.values(this.landsBusy())) n += count ?? 0;
    return n;
  }

  /** Scouts out at each land or on the road to or from it. */
  landsBusy() {
    const busy: Partial<Record<LandId, number>> = {};
    for (const agent of this.agents.values()) {
      if (agent.trip !== "out" && agent.trip !== "there" && agent.trip !== "back") continue;
      const land = this.landOf(agent);
      busy[land] = (busy[land] ?? 0) + 1;
    }
    return busy;
  }

  /** A camera centred on one station (for the station panel). */
  /**
   * The camera on one station. `close`: how much closer than the whole HQ (the tour comes in closer,
   * so the step it explains fills the screen).
   */
  focus(id: StationId, insets = this.insets, close = 1.6): CameraTarget {
    const base = this.roomCamera(insets);
    const station = STATION[id];
    // Close enough to see who is doing what, in whole device pixels.
    const zoom = Math.min(this.stage.fitZoom(Math.max(2, base.zoom * close)), close > 1.6 ? 6 : 4);
    const sx = projectX(station.x, station.y);
    const sy = projectY(station.x, station.y, station.z + 4);
    return { x: sx + insets.right / 2 / zoom, y: sy + (insets.bottom - insets.top) / 2 / zoom, zoom };
  }

  /** Where a station sits on screen (CSS px), for labels. */
  stationPoint(id: StationId) {
    const s = STATION[id];
    return { x: s.x, y: s.y, z: s.z };
  }

  /** How many agents are still waiting to come out of the horse. */
  get waiting() {
    return this.column.length;
  }

  /**
   * Sends the next agent in the column out of the horse (the landing calls this while the doors
   * are open). Returns false when nobody is waiting.
   */
  nextRecruit(): boolean {
    const agent = this.column.shift();
    if (!agent) return false;
    this.arrive(agent);
    return true;
  }

  /** Applies a plan: posts every agent, sets screens, baskets and reels. */
  apply(plan: CampPlan) {
    const instantly = !this.planned && !this.entering;
    this.planned = true;
    for (const [key, value] of Object.entries(plan.props)) {
      // The basket fills as scouts actually drop their scroll cases in it (see updateBasket).
      if (key === "basket") continue;
      for (const station of STATIONS) {
        const entity = this.keyed.get(`${station.id}:${key}`);
        if (entity?.job?.k === "prop") entity.job = { ...entity.job, v: value };
      }
    }
    this.tvOn = plan.tvOn;
    this.posterList = plan.posters;
    for (const poster of plan.posters) this.loadPoster(poster.creativeId, poster.url, poster.video);

    // Desks: one per planned video, set up with the camp.
    const workshop = STATION.workshop;
    const live = new Set<number>();
    for (const desk of plan.desks) {
      live.add(desk.slot);
      let entity = this.desks.get(desk.slot);
      if (!entity) {
        const slot = DESK_SLOTS[desk.slot];
        // Set up with the workshop's island, grain by grain (see tick).
        entity = Object.assign(this.stage.add({ x: workshop.x + slot.x, y: workshop.y + slot.y, z: 0, job: null as Job | null, reveal: 0, priority: 4 }), { state: desk.state });
        this.desks.set(desk.slot, entity);
      }
      entity.state = desk.state;
    }
    for (const [slot, entity] of this.desks) {
      if (!live.has(slot)) {
        this.stage.remove(entity);
        this.desks.delete(slot);
      }
    }

    // Agents.
    const seen = new Set<string>();
    // The battle's companies stay in the plan (the agora's panel reads them), but the HQ sends no
    // army to sea: they never come out of the door.
    for (const agentPlan of plan.agents) {
      if (agentPlan.army) continue;
      seen.add(agentPlan.id);
      this.post(agentPlan, instantly);
    }
    for (const [id, agent] of this.agents) {
      if (seen.has(id) || agent.dismissed) continue;
      agent.dismissed = true;
      const queued = this.column.indexOf(agent);
      if (queued >= 0) {
        // Still inside the horse: it simply stays there.
        this.column.splice(queued, 1);
        this.agents.delete(id);
      } else this.settle(agent);
    }
    this.updateBasket();
    // What the video wall shows, and the moments the whole HQ stops to cheer at it: the cut is
    // ready for review, and the approved videos go out.
    const st = plan.stations;
    this.wallMode = st.agora.state === "working" || st.agora.state === "done" ? "live" : st.theatre.state === "yours" || st.theatre.state === "done" ? "screening" : st.workshop.state === "working" || st.workshop.state === "done" ? "rendering" : "idle";
    this.deskStates = plan.desks.map((d) => d.state);
    const companies = plan.battle.companies;
    this.street = {
      sending: companies.some((c) => c.state === "sent"),
      live: companies.filter((c) => c.state === "engaged").map((c) => c.creativeId),
      views: plan.battle.score?.views ?? 0,
      likes: plan.battle.score?.likes ?? 0,
      ratio: plan.battle.score?.ratio ?? null,
      illustrative: plan.battle.illustrative,
    };
    if (!instantly) {
      if (st.theatre.state === "yours" && this.lastStates.theatre && this.lastStates.theatre !== "yours") this.celebrate(5, "PREMIERE");
      if (st.agora.state === "working" && this.lastStates.agora && this.lastStates.agora !== "working") this.celebrate(6, "APPROVED");
    }
    for (const s of STATIONS) this.lastStates[s.id] = st[s.id].state;
    this.uplinkOn = plan.stations.agora.state === "working";
    const army: Enlisted[] = plan.agents.filter((a) => a.army).map((a) => ({ id: a.id, ...a.army! }));
    this.expedition.apply(plan.battle, army, instantly);
  }

  /**
   * The courier carries work from one station to the next (each stage change, each finished video).
   * `key` names what is handed over, for the exchange the agents have about it (onExchange).
   */
  dispatch(from: StationId, to: StationId, key = `${from}>${to}`) {
    if (from === to) return;
    // A packet of light runs along the walkways from one station to the next, down the stairs if need be.
    this.packets.push({ from, to, at: this.time, path: flowLine(from, to) });
    if (this.packets.length > 6) this.packets.shift();
    const last = this.dispatches[this.dispatches.length - 1];
    if (last && last.from === from && last.to === to) return;
    // A long backlog only delays the picture: keep the latest few.
    if (this.dispatches.length >= 3) this.dispatches.shift();
    this.dispatches.push({ from, to, key });
    const courier = this.agents.get("courier");
    if (courier) this.settle(courier);
  }

  // --- Agents: what each one does next ----------------------------------------------------------

  private post(plan: AgentPlan, instantly: boolean) {
    let agent = this.agents.get(plan.id);
    if (!agent) {
      agent = this.create(plan);
      this.agents.set(plan.id, agent);
      if (instantly) this.place(agent);
      else {
        agent.lane = (((this.recruited++ * 7) % 5) - 2) * 1.7;
        this.column.push(agent);
      }
      return;
    }
    const previous = agent.plan;
    agent.plan = plan;
    if (agent.dismissed) agent.dismissed = false;
    // A scout whose run starts over (the demo stepping back) is a scout again.
    if (previous.returning && !plan.returning) {
      agent.finished = false;
      agent.delivered = false;
      agent.trip = "camp";
    }
    if (agent.where !== "queued") this.settle(agent);
  }

  private create(plan: AgentPlan): Agent {
    const entity: Figure = { x: 0, y: 0, z: 0, look: plan.look, act: plan.act, dir: plan.dir, coat: 0, sort: plan.sort ?? 0, shadow: 5, priority: 3, job: null };
    return { plan, entity, where: "queued", busy: false, node: "horse", up: null, dismissed: false, finished: false, delivered: false, stall: null, onFoot: false, gatherSince: 0, phase: Math.random() * 10, lane: 0, doing: "Waiting at the street door", errand: null, deliveries: 0, trip: "camp", slot: null, frame: -1 };
  }

  /** Puts an agent straight at its post (opening a camp directly, not through the march). */
  private place(agent: Agent) {
    const plan = agent.plan;
    if (plan.returning) {
      // Came back before we were watching: already home.
      agent.finished = true;
      agent.delivered = plan.returning === "scroll";
      agent.trip = agent.delivered ? "done" : "empty";
      agent.where = "home";
      return;
    }
    if (plan.away) {
      // Out on a run before we were watching: already gathering at the land, its horse waiting.
      const land = this.landOf(agent);
      const slot = this.claimSpot(land, agent);
      const stall = this.freeStall(agent);
      if (stall >= 0) {
        this.stalls[stall].rider = agent;
        this.stage.remove(this.stalls[stall].steed);
        agent.stall = stall;
        agent.entity.coat = STALLS[stall].coat;
        this.tieUp(agent, land, slot, 0);
      } else agent.onFoot = true;
      const spot = LAND_SPOTS.gather[slot];
      const p = this.landPoint(land, spot);
      Object.assign(agent.entity, { x: p.x, y: p.y, z: p.z, shadowZ: p.z, dir: spot.dir, act: LAND_ACT[land], reveal: 0, alpha: 1, shadow: 5 });
      agent.where = "afield";
      agent.node = "scouts";
      agent.trip = "there";
      agent.gatherSince = this.time - 10;
      agent.doing = `Gathering at ${LAND[land].name}: ${this.source(agent)}`;
      this.stage.add(agent.entity);
      return;
    }
    const post = this.postPoint(plan);
    // Appears with its island, grain by grain (see tick).
    const floor = STATION[plan.station].z;
    Object.assign(agent.entity, { x: post.x, y: post.y, z: post.z, shadowZ: floor, dir: plan.dir, act: plan.act, reveal: 0, alpha: 1 });
    agent.entity.shadow = post.z - floor < 1 ? 5 : 0;
    agent.up = plan.via ? this.viaSteps(plan) : null;
    agent.node = plan.station;
    agent.where = "posted";
    this.stage.add(agent.entity);
  }

  /** Decides what an agent does next, once it is free. */
  private settle(agent: Agent) {
    if (agent.busy) return;
    const plan = agent.plan;
    // Queued in the horse, or away with the expedition (which moves them).
    if (agent.where === "queued" || agent.where === "expedition") return;

    if (agent.dismissed) {
      if (agent.where === "home") this.agents.delete(plan.id);
      else if (agent.trip === "there") this.headBack(agent);
      else this.goHome(agent);
      return;
    }
    // Back inside the horse but needed again: out it comes.
    if (agent.where === "home") {
      if (plan.returning && agent.finished) return;
      agent.where = "queued";
      this.column.push(agent);
      return;
    }

    if (plan.id === "courier" && this.dispatches.length) {
      this.courierRun(agent);
      return;
    }

    if (plan.id.startsWith("scout:")) {
      if (plan.away) {
        // Back already, but its land has another source to fetch: out again.
        if (agent.trip === "done" || agent.trip === "empty") {
          agent.finished = false;
          agent.trip = "camp";
        }
        // Off on the errand, or already gathering: carry on.
        if (agent.trip === "camp") this.rideOut(agent);
        return;
      }
      if (plan.returning) {
        if (agent.finished) return this.goHome(agent);
        if (agent.trip === "there") return this.headBack(agent);
        // The run ended before this scout even left: there and straight back.
        if (agent.trip === "camp") return this.rideOut(agent);
        return;
      }
      // Waiting again (the demo stepped back): come back from the land first.
      if (agent.trip === "there") return this.headBack(agent);
    }

    if (this.atPost(agent)) {
      agent.where = "posted";
      agent.entity.dir = plan.dir;
      agent.entity.act = plan.act;
      return;
    }
    this.toPost(agent);
  }

  /** Out of the horse, down the plank and along the sandbars to the post. */
  private arrive(agent: Agent) {
    const e = agent.entity;
    const out = exitPath();
    Object.assign(e, { x: out[0].x, y: out[0].y, z: out[0].z, alpha: 0, reveal: 1, act: "march" as Act });
    this.stage.add(e);
    // The first one out leads the column, and says so.
    if (!this.calledOut && this.entering) {
      this.calledOut = true;
      this.say(agent.plan.id, LINES.rollOut(this.brandName), 3.6);
    }
    const route = travel("horse", agent.plan.station, agent.lane);
    const steps: Step[] = [...out.slice(1), ...route, ...this.approach(agent.plan)];
    agent.node = agent.plan.station;
    agent.doing = `Heading down into the HQ to ${PLACE[agent.plan.station]}`;
    this.run(
      agent,
      steps,
      SPEED.column,
      () => {
        agent.up = agent.plan.via ? this.viaSteps(agent.plan) : null;
      },
      "march",
      "in",
    );
  }

  /** Walks to the post: down from where it was, along the roads if it is on another island, up to it. */
  private toPost(agent: Agent) {
    const plan = agent.plan;
    // Out on the pavement: down the stairs first (this moves its node to the stairs).
    const off: Step[] = this.atStable(agent) && !agent.up?.length ? this.descend(agent) : [];
    const far = agent.node !== plan.station;
    // Already in by the same way (a soldier moving up on the battlefield): straight to the new post.
    if (!off.length && !far && agent.up && plan.via && this.sameWay(agent.up, this.viaSteps(plan))) {
      agent.doing = "Moving up";
      this.run(agent, [{ ...this.postPoint(plan), dir: plan.dir }], plan.act === "fight" || plan.act === "cheer" ? SPEED.run : SPEED.walk, () => undefined);
      return;
    }
    const steps: Step[] = [...off, ...this.descend(agent)];
    if (far) steps.push(...travel(agent.node, plan.station));
    steps.push(...this.approach(plan));
    agent.node = plan.station;
    agent.doing = far ? `Walking over to ${PLACE[plan.station]}` : plan.via ? "Climbing up to the post" : "Taking up the post";
    this.run(agent, steps, far ? SPEED.home : SPEED.walk, () => {
      agent.up = plan.via ? this.viaSteps(plan) : null;
    });
  }

  /** Back along the sandbars, up the plank and into the horse. */
  private goHome(agent: Agent) {
    const steps: Step[] = [...this.descend(agent), ...travel(agent.node, "horse"), ...exitPath().reverse()];
    agent.node = "horse";
    agent.doing = agent.finished ? "Job done: heading back up to the street" : "Heading back up to the street";
    this.run(
      agent,
      steps,
      SPEED.home,
      () => {
        this.stage.remove(agent.entity);
        agent.where = "home";
      },
      "march",
      "home",
    );
  }

  /** A scout takes a horse from the stable (or runs, when every horse is out) to the land of its source. */
  private rideOut(agent: Agent) {
    const land = this.landOf(agent);
    const name = LAND[land].name;
    const stall = agent.stall ?? this.freeStall(agent);
    agent.trip = "out";
    if (stall < 0) {
      agent.onFoot = true;
      agent.doing = `Every bike is out: running to ${name} for ${this.source(agent)}`;
      const out: Step[] = this.atStable(agent) ? [this.gate()] : [...this.descend(agent), ...(agent.node !== "horse" ? travel(agent.node, "horse") : []), ...upStairs()];
      agent.node = "horse";
      this.run(agent, [...out, ...roadToLand(land)], SPEED.run, () => this.reachLand(agent));
      return;
    }
    agent.onFoot = false;
    this.stalls[stall].rider = agent;
    agent.stall = stall;
    agent.doing = "Hurrying to the bike bay";
    this.run(agent, this.toStall(agent, stall), SPEED.run, () => {
      agent.doing = "Saddling up";
      this.mount(agent, stall, () => {
        agent.doing = `Riding up to ${name} for ${this.source(agent)}`;
        this.ride(agent, [...this.outOfStable(agent), ...roadToLand(land)], SPEED.ride, 0, () => this.reachLand(agent));
      });
    });
  }

  /** At the land: the horse is tied by the shore and the scout walks up to the landmark to gather. */
  private reachLand(agent: Agent) {
    const land = this.landOf(agent);
    const slot = this.claimSpot(land, agent);
    const spot = LAND_SPOTS.gather[slot];
    const walkUp = () => this.run(agent, [{ ...this.landPoint(land, spot), dir: spot.dir }], SPEED.walk, () => this.gather(agent));
    agent.trip = "there";
    if (agent.onFoot) return walkUp();
    const horse = LAND_SPOTS.horses[slot];
    this.ride(agent, [{ ...this.landPoint(land, horse), dir: horse.dir }], SPEED.walk * 1.6, 0, () => {
      agent.doing = `Parking the bike at ${LAND[land].name}`;
      this.pause(agent, BEAT.dismount, () => {
        this.tieUp(agent, land, slot, 1);
        // Down from the saddle, beside the horse.
        const e = agent.entity;
        const p = this.landPoint(land, { x: horse.x - 3, y: horse.y - 3 });
        Object.assign(e, { x: p.x, y: p.y, z: p.z, shadow: 5, act: "march" });
        e.job = { k: "soldier", look: e.look, act: "march", dir: e.dir, f: 0 };
        walkUp();
      });
    });
  }

  /** The horse a scout rode out on waits at the land's shore, in the scout's spot there. */
  private tieUp(agent: Agent, land: LandId, slot: number, reveal: number) {
    const horse = LAND_SPOTS.horses[slot];
    const p = this.landPoint(land, horse);
    this.landSteeds.set(agent, this.stage.add({ x: p.x, y: p.y, z: p.z, shadowZ: p.z, shadow: 8, job: { k: "steed", dir: horse.dir, h: agent.entity.coat } as Job, reveal, priority: 3 }));
  }

  /** Gathering at the landmark, for as long as the run lasts (and a moment at least, so it reads). */
  private gather(agent: Agent) {
    const land = this.landOf(agent);
    agent.where = "afield";
    agent.gatherSince = this.time;
    agent.entity.act = LAND_ACT[land];
    agent.doing = `Gathering at ${LAND[land].name}: ${this.source(agent)}`;
    this.later(BEAT.gather, () => this.settle(agent));
  }

  /** Back from the land: to the horse, home along the roads, and the case into the basket. */
  private headBack(agent: Agent) {
    const wait = BEAT.gather - (this.time - agent.gatherSince);
    if (wait > 0) {
      this.pause(agent, wait, () => this.settle(agent));
      return;
    }
    const land = this.landOf(agent);
    const name = LAND[land].name;
    const carrying = !agent.dismissed && agent.plan.returning === "scroll";
    const home: Step[] = roadToLand(land).reverse();
    const slot = this.releaseSpot(land, agent);
    agent.trip = "back";
    const basket = { ...this.rel("scouts", SPOTS.basket.x, SPOTS.basket.y, 0), dir: SPOTS.basket.dir };
    const deliver = () => {
      agent.busy = true;
      agent.doing = "Dropping the data package in the intake bin";
      agent.entity.act = "stand";
      this.later(BEAT.drop, () => {
        agent.delivered = true;
        agent.finished = true;
        agent.trip = "done";
        this.updateBasket();
        agent.busy = false;
        this.settle(agent);
      });
    };
    // Back without a case: the errand is over if the run is, or it waits to set out again.
    const backEmpty = () => {
      if (agent.plan.returning && !agent.dismissed) {
        agent.finished = true;
        agent.trip = "empty";
      } else agent.trip = "camp";
    };
    // Down the stairs from the pavement and along the deck to the intake bin.
    const indoors: Step[] = [...this.downStairs(), ...travel("horse", "scouts"), basket];
    if (agent.onFoot || agent.stall === null) {
      agent.onFoot = false;
      agent.doing = carrying ? `Running back from ${name} with a data package` : `Running back from ${name}`;
      agent.node = "scouts";
      if (carrying) return this.run(agent, [...home, this.gate(), ...indoors], SPEED.run, deliver, "carry");
      backEmpty();
      agent.node = "horse";
      return this.run(agent, [...home, this.gate(), ...this.downStairs()], SPEED.run, () => undefined);
    }
    const steed = this.landSteeds.get(agent);
    const horse = LAND_SPOTS.horses[slot ?? 0];
    const at = steed ? { x: steed.x, y: steed.y, z: steed.z } : this.landPoint(land, horse);
    agent.doing = "Going back to the bike";
    this.run(agent, [{ x: at.x - 3, y: at.y - 3, z: at.z }], SPEED.walk, () => {
      if (steed) this.stage.remove(steed);
      this.landSteeds.delete(agent);
      const e = agent.entity;
      Object.assign(e, { x: at.x, y: at.y, z: at.z, shadow: 9 });
      e.job = { k: "rider", look: e.look, dir: e.dir, f: -1, c: carrying ? 1 : 0, h: e.coat };
      this.pause(agent, BEAT.mount, () => {
        agent.doing = carrying ? `Riding back from ${name} with a data package` : agent.dismissed ? "Called back to the HQ" : `Riding back from ${name} empty-handed`;
        this.ride(agent, [...home, ...this.intoStable(agent.stall!, "horse")], SPEED.ride, carrying ? 1 : 0, () => {
          agent.doing = "Parking the bike";
          this.dismount(agent, carrying, () => {
            if (agent.dismissed) return this.settle(agent);
            if (!carrying) {
              backEmpty();
              return this.settle(agent);
            }
            // Down the stairs and into the intake bin with it.
            agent.entity.act = "carry";
            agent.doing = "Carrying the data package down to the intake bin";
            agent.node = "scouts";
            this.run(agent, [...this.outOfStable(agent), ...indoors], SPEED.run, deliver, "carry");
          });
        });
      });
    });
  }

  /** The courier walks to where the work is, takes it, and carries it on to the station that needs it. */
  private courierRun(agent: Agent) {
    this.courierLeg(agent);
  }

  private courierLeg(agent: Agent) {
    const job = this.dispatches.shift();
    if (!job) {
      // Nothing more to carry: back to the post.
      agent.errand = null;
      agent.entity.act = "march";
      this.toPost(agent);
      return;
    }
    const lead: Step[] = [...this.descend(agent)];
    const pickup: Step[] = [...lead, ...travel(agent.node, job.from)];
    agent.node = job.from;
    agent.errand = { from: job.from, to: job.to };
    agent.doing = `Walking to ${PLACE[job.from]} to collect the finished work`;
    // Who talks at each end: the station's head and the courier.
    const talk = (phase: "pickup" | "handover", station: StationId) => {
      const head = HEAD[station];
      const speakers = phase === "pickup" ? [head, "courier"] : ["courier", head];
      this.events.onExchange?.({ key: job.key, from: job.from, to: job.to, phase, speakers: speakers.filter((id): id is string => Boolean(id && this.agents.has(id))) });
    };
    this.run(agent, pickup, SPEED.run, () => {
      agent.doing = `Collecting the work at ${PLACE[job.from]}`;
      talk("pickup", job.from);
      this.pause(agent, BEAT.pickup, () => {
        agent.node = job.to;
        agent.doing = `Carrying the work to ${PLACE[job.to]}`;
        this.run(
          agent,
          [hub(job.from), ...travel(job.from, job.to)],
          SPEED.run,
          () => {
            this.events.onArrive?.(job.to);
            talk("handover", job.to);
            agent.deliveries++;
            agent.doing = `Handing the work over at ${PLACE[job.to]}`;
            agent.entity.act = "stand";
            this.pause(agent, BEAT.handover, () => this.courierLeg(agent));
          },
          "carry",
        );
      });
    });
  }

  /** Swaps the walker for a rider on the stall's horse, standing a moment before moving off. */
  private mount(agent: Agent, stall: number, then: () => void) {
    const at = STALLS[stall];
    const steed = this.stalls[stall].steed;
    this.stage.remove(steed);
    const e = agent.entity;
    Object.assign(e, { x: steed.x, y: steed.y, z: steed.z, shadowZ: steed.z, dir: at.horse.dir, shadow: 9 });
    e.coat = at.coat;
    e.job = { k: "rider", look: e.look, dir: e.dir, f: -1, c: agent.plan.id === "courier" ? 1 : 0, h: e.coat };
    agent.busy = true;
    this.later(BEAT.mount, () => {
      agent.busy = false;
      then();
    });
  }

  /** Ties the horse back at its stall and steps down beside it. */
  private dismount(agent: Agent, carrying: boolean, then: () => void) {
    const stall = agent.stall!;
    const at = STALLS[stall];
    const e = agent.entity;
    agent.busy = true;
    e.job = { k: "rider", look: e.look, dir: at.horse.dir, f: -1, c: carrying ? 1 : agent.plan.id === "courier" ? 1 : 0, h: e.coat };
    this.later(BEAT.dismount, () => {
      const steed = this.stalls[stall].steed;
      this.stalls[stall].rider = null;
      agent.stall = null;
      this.stage.add(steed);
      Object.assign(e, { x: at.mount.x, y: at.mount.y, z: BAY.z, shadowZ: BAY.z, dir: at.mount.dir, shadow: 5, act: carrying ? "carry" : "stand" });
      e.job = { k: "soldier", look: e.look, act: e.act, dir: e.dir, f: 0 };
      agent.busy = false;
      then();
    });
  }

  private pause(agent: Agent, seconds: number, then: () => void) {
    agent.busy = true;
    this.later(seconds, () => {
      agent.busy = false;
      then();
    });
  }

  // --- Moving -------------------------------------------------------------------------------------

  /** Walks a figure through steps; when it gets there, `done` runs and the agent settles. */
  private run(agent: Agent, steps: Step[], speed: number, done: () => void, act: Act = "march", door?: "in" | "home") {
    agent.busy = true;
    agent.where = "moving";
    const e = agent.entity;
    this.stage.add(e);
    let leg = 0;
    let travelled = 0;
    const stride = strideLength(speed);
    e.tick = (dt) => {
      // Stepping out of the dark doorway.
      if (door !== "home" && (e.alpha ?? 1) < 1) e.alpha = Math.min(1, (e.alpha ?? 0) + dt * 4);
      let remaining = speed * dt;
      let legAct: Act = act;
      while (remaining > 0 && leg < steps.length) {
        const b = steps[leg];
        legAct = b.act ?? act;
        const dx = b.x - e.x;
        const dy = b.y - e.y;
        const dz = b.z - e.z;
        // Walk facing the way you go; on a ladder, face the ladder.
        if (b.act === "climb" && b.dir !== undefined) e.dir = b.dir;
        else if (Math.hypot(dx, dy) > 0.05) e.dir = dirFor(dx, dy);
        const left = Math.hypot(dx, dy, dz);
        if (left <= remaining) {
          e.x = b.x;
          e.y = b.y;
          e.z = b.z;
          remaining -= left;
          travelled += left;
          leg++;
        } else {
          const k = remaining / left;
          e.x += dx * k;
          e.y += dy * k;
          e.z += dz * k;
          travelled += remaining;
          remaining = 0;
        }
      }
      // Back up the plank: fade into the dark of the doorway.
      if (door === "home" && e.z > 40 && leg >= steps.length - 1) e.alpha = Math.max(0, (e.alpha ?? 1) - dt * 5);
      // A shadow underfoot on the floor, the stairs or the street; none while climbing a ladder.
      e.shadowZ = e.z;
      e.shadow = legAct === "climb" ? 0 : 5;
      e.act = legAct;
      const frames = ACT_FRAMES[legAct];
      e.job = { k: "soldier", look: e.look, act: legAct, dir: e.dir, f: frames > 1 ? Math.floor((travelled / stride) * frames) % frames : 0 };
      if (leg >= steps.length) {
        const last = steps[steps.length - 1];
        if (last?.dir !== undefined) e.dir = last.dir;
        e.tick = undefined;
        agent.busy = false;
        agent.where = "posted";
        done();
        // `done` may have started the agent's next errand.
        if (!agent.busy) this.settle(agent);
      }
    };
  }

  /** Gallops a rider through steps. `carry` 1 holds the scroll case. */
  private ride(agent: Agent, steps: Step[], speed: number, carry: number, done: () => void) {
    agent.busy = true;
    agent.where = "moving";
    const e = agent.entity;
    this.stage.add(e);
    let leg = 0;
    let travelled = 0;
    e.shadow = 9;
    e.tick = (dt) => {
      let remaining = speed * dt;
      while (remaining > 0 && leg < steps.length) {
        const b = steps[leg];
        const dx = b.x - e.x;
        const dy = b.y - e.y;
        const dz = b.z - e.z;
        const flat = Math.hypot(dx, dy);
        const left = Math.hypot(dx, dy, dz);
        if (flat > 0.05) e.dir = dirFor(dx, dy);
        if (left <= remaining) {
          e.x = b.x;
          e.y = b.y;
          e.z = b.z;
          remaining -= left;
          travelled += left;
          leg++;
          if (leg === steps.length && b.dir !== undefined) e.dir = b.dir;
        } else {
          e.x += (dx / left) * remaining;
          e.y += (dy / left) * remaining;
          e.z += (dz / left) * remaining;
          travelled += remaining;
          remaining = 0;
        }
      }
      // The shadow rides along on whatever is underfoot: the floor, the stairs, the street.
      e.shadowZ = e.z;
      e.job = { k: "rider", look: e.look, dir: e.dir, f: Math.floor((travelled / 7) % RIDER_FRAMES), c: carry, h: e.coat };
      if (leg >= steps.length) {
        e.tick = undefined;
        e.job = { k: "rider", look: e.look, dir: e.dir, f: -1, c: carry, h: e.coat };
        agent.busy = false;
        done();
        // `done` may have started the agent's next errand.
        if (!agent.busy) this.settle(agent);
      }
    };
  }

  // --- Looking at agents ---------------------------------------------------------------------------

  /** The agent under a point on the canvas (CSS pixels): the one drawn in front if several overlap. */
  pick(cssX: number, cssY: number): string | null {
    const zoom = this.stage.camera.zoom;
    let best: { id: string; depth: number } | null = null;
    for (const agent of this.agents.values()) {
      const e = agent.entity;
      if (!this.stage.has(e) || (e.alpha ?? 1) < 0.5 || (e.reveal ?? 1) < 0.5) continue;
      const s = this.stage.toScreen(e.x, e.y, e.z);
      const mounted = e.job?.k === "rider";
      // At least 24 CSS pixels wide, so a small figure is still easy to hit (on a phone too).
      const half = Math.max((mounted ? 13 : 7) * zoom, 12);
      const top = (mounted ? 36 : 28) * zoom;
      if (cssX < s.x - half || cssX > s.x + half || cssY < s.y - top || cssY > s.y + 4 * zoom) continue;
      const depth = e.x + e.y + (e.sort ?? 0);
      if (!best || depth > best.depth) best = { id: agent.plan.id, depth };
    }
    return best?.id ?? null;
  }

  /** Where an agent is on the map, or null while it is inside the horse. */
  position(id: string): Point | null {
    const agent = this.agents.get(id);
    if (!agent || !this.stage.has(agent.entity)) return null;
    return { x: agent.entity.x, y: agent.entity.y, z: agent.entity.z };
  }

  /** What an agent is up to, for its card. */
  info(id: string): AgentInfo | null {
    const agent = this.agents.get(id);
    if (!agent) return null;
    const e = agent.entity;
    const posted = agent.where === "posted" && !agent.busy;
    const away = agent.where === "expedition" ? (this.expedition.doing(id) ?? "With the expedition") : null;
    const doing = away ?? (agent.where === "home" ? (agent.finished ? "Back up on the street, the job done" : "On the street, about to head down") : agent.where === "queued" ? "Waiting at the street door" : posted ? ACT_WORDS[e.act] : agent.doing);
    return { where: agent.where, doing, mounted: e.job?.k === "rider", visible: this.stage.has(e), errand: agent.errand, deliveries: agent.deliveries, trip: agent.trip, land: agent.plan.id.startsWith("scout:") ? this.landOf(agent) : null, coat: e.coat };
  }

  /** "the brand profile", for a scout's errand. */
  /** What a scout fetches at its land, for sentences ("galloping to TikTok for top videos and ads"). */
  private source(agent: Agent) {
    const what = LAND[this.landOf(agent)].what;
    return what.charAt(0).toLowerCase() + what.slice(1);
  }

  /** Keeps the marker and rings on the selected and hovered soldiers. */
  private placeMarkers() {
    const put = (marker: Entity & { big: boolean }, id: string | null, below: boolean) => {
      const agent = id ? this.agents.get(id) : undefined;
      const e = agent?.entity;
      if (!e || !this.stage.has(e)) {
        marker.hidden = true;
        return;
      }
      marker.hidden = false;
      marker.x = e.x;
      marker.y = e.y;
      marker.z = e.z;
      // Rings sit just under the figure in the depth order; the marker is drawn over everything.
      if (below) marker.sort = (e.sort ?? 0) - 0.05;
      marker.big = e.job?.k === "rider";
    };
    put(this.ring, this.selected, true);
    put(this.hoverRing, this.hovered && this.hovered !== this.selected ? this.hovered : null, true);
    put(this.marker, this.selected, false);
  }

  /** An elliptical ring of dashes at a soldier's feet; the selected one's dashes march round. */
  private paintRing(ctx: CanvasRenderingContext2D, sx: number, sy: number, px: number, time: number, hover: boolean) {
    const entity = hover ? this.hoverRing : this.ring;
    const r = entity.big ? 11 : 7;
    const dots = entity.big ? 26 : 18;
    const unit = Math.max(1, Math.round(px));
    const spin = hover ? 0 : time * 0.6;
    ctx.fillStyle = hover ? "rgba(43, 29, 20, 0.45)" : "#b73a31";
    for (let i = 0; i < dots; i++) {
      if (i % 3 === 2) continue;
      const a = (i / dots + spin) * Math.PI * 2;
      ctx.fillRect(Math.round(sx + Math.cos(a) * r * px), Math.round(sy + Math.sin(a) * r * 0.5 * px), unit, unit);
    }
  }

  /** A bobbing pixel arrow over the selected soldier's head. */
  private paintMarker(ctx: CanvasRenderingContext2D, sx: number, sy: number, px: number, time: number) {
    const head = this.marker.big ? 44 : 34;
    const bob = Math.round(Math.sin(time * 5) * 1.5);
    const rows = ["0111110", "0111110", "1111111", "0111110", "0011100", "0001000"];
    const unit = Math.max(1, Math.round(px));
    const x0 = Math.round(sx - 3.5 * unit);
    const y0 = Math.round(sy - (head - bob) * px);
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        if (row[x] !== "1") continue;
        // Ink outline around a crimson arrow.
        ctx.fillStyle = "#2b1d14";
        ctx.fillRect(x0 + (x - 1) * unit, y0 + y * unit, unit * 3, unit * 2);
      }
    });
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        if (row[x] !== "1") continue;
        ctx.fillStyle = y < 2 ? "#d65a45" : "#b73a31";
        ctx.fillRect(x0 + x * unit, y0 + y * unit, unit, unit);
      }
    });
  }

  // --- Places ----------------------------------------------------------------------------------

  /** On foot to the stall's mounting spot, around the end of the rail. */
  /** On foot to the stall's bike: up the street stairs to the pavement, along to the bike. */
  private toStall(agent: Agent, stall: number): Step[] {
    // Already out on the pavement (just back from a ride, say): along the aisle to the bike.
    if (this.atStable(agent)) return this.intoStable(stall, "mount").slice(1);
    const steps: Step[] = [...this.descend(agent)];
    if (agent.node !== "horse") steps.push(...travel(agent.node, "horse"));
    steps.push(...upStairs(), ...this.intoStable(stall, "mount").slice(1));
    agent.node = "horse";
    return steps;
  }

  /** On the pavement at the top of the stairs. */
  private gate(): Point {
    return stableGate();
  }

  /** From the bikes back along the aisle to the top of the stairs. */
  private outOfStable(agent: Agent): Step[] {
    return [{ x: agent.entity.x, y: STABLE_AISLE.y, z: BAY.z }, this.gate()];
  }

  /** From the top of the stairs along the aisle to a stall: its bike (riding in) or behind it (to get on). */
  private intoStable(stall: number, to: "horse" | "mount"): Step[] {
    const spot = STALLS[stall][to];
    return [this.gate(), { x: spot.x, y: STABLE_AISLE.y, z: BAY.z }, { x: spot.x, y: spot.y, z: BAY.z, dir: spot.dir }];
  }

  /** Down the street stairs from the top to the deck. */
  private downStairs(): Step[] {
    return upStairs().reverse();
  }

  /** Out on the pavement by the bikes (not on a land's lot, not indoors). */
  private atStable(agent: Agent) {
    const e = agent.entity;
    return Math.abs(e.z - BAY.z) < 1 && e.y > BAY.y - 10 && e.y < ROOM.y0 - 4 && e.x > STABLE_GATE.x - 6 && e.x < BAY.x + 60;
  }

  private rel(station: StationId, x: number, y: number, z: number): Point {
    const s = STATION[station];
    return { x: s.x + x, y: s.y + y, z: s.z + z };
  }

  private postPoint(plan: AgentPlan): Point {
    return this.rel(plan.station, plan.x, plan.y, plan.z);
  }

  private viaSteps(plan: AgentPlan): Step[] {
    return (plan.via ?? []).map((w: Waypoint) => ({ ...this.rel(plan.station, w.x, w.y, w.z), act: w.act, dir: w.dir }));
  }

  private sameWay(a: Step[], b: Step[]) {
    return a.length === b.length && a.every((p, i) => Math.abs(p.x - b[i].x) < 0.01 && Math.abs(p.y - b[i].y) < 0.01 && Math.abs(p.z - b[i].z) < 0.01);
  }

  /** From the island's hub up to the post: any waypoints (ladder, step), then the post itself. */
  private approach(plan: AgentPlan): Step[] {
    return [...this.viaSteps(plan), { ...this.postPoint(plan), dir: plan.dir }];
  }

  /** Back down the way the figure came up (down the ladder, off the podium), or out of the stable. */
  private descend(agent: Agent): Step[] {
    const up = agent.up;
    agent.up = null;
    if (!up?.length) {
      if (!this.atStable(agent)) return [];
      agent.node = "horse";
      return [...this.outOfStable(agent), ...this.downStairs()];
    }
    const steps: Step[] = [];
    for (let i = up.length - 1; i >= 0; i--) {
      const leg = up[i + 1];
      steps.push({ x: up[i].x, y: up[i].y, z: up[i].z, act: leg?.act, dir: leg?.act ? leg.dir : undefined });
    }
    return steps;
  }

  private atPost(agent: Agent) {
    const p = this.postPoint(agent.plan);
    const e = agent.entity;
    return agent.node === agent.plan.station && this.stage.has(e) && Math.hypot(e.x - p.x, e.y - p.y) < 0.6 && Math.abs(e.z - p.z) < 0.4;
  }

  /** A stall with its horse in, for this rider (the courier has his own). */
  private freeStall(agent: Agent) {
    if (agent.plan.id === "courier") return this.stalls[COURIER_STALL].rider ? -1 : COURIER_STALL;
    return this.stalls.findIndex((s, i) => i !== COURIER_STALL && !s.rider);
  }

  /** The land a scout's source is fetched from. */
  private landOf(agent: Agent): LandId {
    return scoutLand(agent.plan.id);
  }

  private landPoint(land: LandId, at: { x: number; y: number }): Point {
    const l = LAND[land];
    return { x: l.x + at.x, y: l.y + at.y, z: LAND_Z };
  }

  /** A spot at the land for this scout (its own if it has one); four, shared beyond that. */
  private claimSpot(land: LandId, agent: Agent) {
    const spots = this.landSpots.get(land) ?? Array<Agent | null>(LAND_SPOTS.gather.length).fill(null);
    this.landSpots.set(land, spots);
    let slot = spots.indexOf(agent);
    if (slot < 0) slot = spots.indexOf(null);
    if (slot < 0) slot = (agent.slot ?? [...agent.plan.id].reduce((n, c) => n + c.charCodeAt(0), 0)) % spots.length;
    else spots[slot] = agent;
    agent.slot = slot;
    return slot;
  }

  private releaseSpot(land: LandId, agent: Agent) {
    const spots = this.landSpots.get(land);
    const slot = agent.slot;
    if (spots && slot !== null && spots[slot] === agent) spots[slot] = null;
    agent.slot = null;
    return slot;
  }

  private updateBasket() {
    const scouts = [...this.agents.values()].filter((a) => a.plan.id.startsWith("scout:"));
    const delivered = scouts.filter((a) => a.delivered).length;
    const basket = this.keyed.get("scouts:basket");
    if (basket?.job?.k === "prop") basket.job = { ...basket.job, v: scouts.length ? Math.round((delivered / scouts.length) * 7) : 0 };
  }

  /**
   * While posts go out, packets of light leave the uplink's antennas for the street: one trail per
   * platform (TikTok, Instagram, YouTube) in its colour.
   */
  private paintUplink(ctx: CanvasRenderingContext2D, sx: number, sy: number, px: number, time: number) {
    if (!this.uplinkOn && !this.street.sending) return;
    // From the broadcast mast's dishes up through the ceiling to the three platforms' billboards.
    const from = { x: 30, y: -28, z: 36 };
    const colours = ["#f05ccd", "#f78ade", "#ff5a6e"];
    const agora = STATION.agora;
    for (let k = 0; k < 3; k++) {
      const land = LAND[BILLBOARD_LANDS[k]];
      const to = { x: land.x - agora.x, y: land.y - 5.5 - agora.y, z: LAND_Z + 32 };
      for (let j = 0; j < 4; j++) {
        const t = (time * 0.6 + j / 4 + k * 0.13) % 1;
        const x = from.x + (to.x - from.x) * t;
        const y = from.y + (to.y - from.y) * t;
        const z = from.z + (to.z - from.z) * t + Math.sin(t * Math.PI) * 20;
        const ox = (x - y) * px;
        const oy = ((x + y) / 2 - 1.2247 * z) * px;
        ctx.globalAlpha = 1 - t * 0.7;
        ctx.fillStyle = colours[k];
        const size = Math.max(1, Math.round(px * 2));
        ctx.fillRect(Math.round(sx + ox), Math.round(sy + oy), size, size);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Every light in the HQ for the glow layer: the fixed ones (built once) and the cars. */
  private glowSources(): GlowSource[] {
    if (!this.staticGlow) this.staticGlow = this.fixedGlow();
    const moving: GlowSource[] = [];
    this.cars.forEach((car, i) => {
      if (car.entity.hidden) return;
      const e = car.entity;
      moving.push({ a: { x: e.x + car.dir * 14, y: e.y, z: e.z + 5.8 }, rgb: NEON.white, r: 18, strength: 0.5, pulse: 0, phase: i, always: true });
      moving.push({ a: { x: e.x, y: e.y, z: e.z + 2.7 }, rgb: car.rgb, r: 22, strength: 0.45, pulse: 0.1, phase: i + 0.5, always: true });
    });
    // Packets: a bright core with a halo, along the walkways from one station to the next.
    for (const p of this.packets) {
      const t = (this.time - p.at) / 3.2;
      if (t < 0 || t > 1) continue;
      const at = alongPath(p.path, t);
      at.z += 2;
      moving.push({ a: at, rgb: NEON.white, r: 6, strength: 0.9, pulse: 0, phase: 0 });
      moving.push({ a: at, rgb: t < 0.5 ? NEON.cyan : NEON.pink, r: 20, strength: 0.6, pulse: 0, phase: 0 });
    }
    // Numbers coming home: packets from each billboard down to the analytics board.
    if (this.street.live.length && this.street.views > 0) {
      const board = { x: STATION.agora.x - 26, y: STATION.agora.y - 26, z: 22 };
      BILLBOARD_LANDS.forEach((id, k) => {
        const land = LAND[id];
        const top = { x: land.x, y: land.y - 5.5, z: LAND_Z + 32 };
        for (let j = 0; j < 3; j++) {
          const t = (this.time * 0.35 + j / 3 + k * 0.17) % 1;
          moving.push({ a: { x: top.x + (board.x - top.x) * t, y: top.y + (board.y - top.y) * t, z: top.z + (board.z - top.z) * t + Math.sin(t * Math.PI) * 30 }, rgb: NEON.cyan, r: 7, strength: 0.7, pulse: 0, phase: k + j });
        }
      });
    }
    if (this.uplinkOn) moving.push({ a: { x: STATION.agora.x - 6, y: STATION.agora.y - 6, z: 16 }, rgb: NEON.cyan, r: 26, strength: 0.55, pulse: 0.6, phase: 3 });
    return [...this.staticGlow, ...moving];
  }

  private fixedGlow(): GlowSource[] {
    const { x0, y0, x1, y1, wall } = ROOM;
    const out: GlowSource[] = [];
    const add = (src: Omit<GlowSource, "phase">) => out.push({ ...src, phase: out.length * 0.37 });
    // The tubes along the tops of the walls, and the kerb lights round the floor's open edges.
    add({ a: { x: x0 + 0.6, y: y0 + 30, z: wall - 6 }, b: { x: x0 + 0.6, y: y1 - 10, z: wall - 6 }, rgb: NEON.cyan, r: 18, strength: 0.38, flicker: 0.01 });
    add({ a: { x: x0 + 130, y: y0 + 0.6, z: wall - 6 }, b: { x: x1 - 10, y: y0 + 0.6, z: wall - 6 }, rgb: NEON.pink, r: 18, strength: 0.38, flicker: 0.015 });
    add({ a: { x: x1, y: y0, z: -1 }, b: { x: x1, y: y1, z: -1 }, rgb: NEON.cyan, r: 10, strength: 0.3 });
    add({ a: { x: x0, y: y1, z: -1 }, b: { x: x1, y: y1, z: -1 }, rgb: NEON.pink, r: 10, strength: 0.3 });
    // The street stairs (street to deck) and the inner stairs (deck to ground floor): rails and treads.
    add({ a: { x: STAIRS.top.x, y: STAIRS.top.y + STAIRS.width / 2, z: wall + 5 }, b: { x: STAIRS.foot.x, y: STAIRS.top.y + STAIRS.width / 2, z: DECK.z + 5 }, rgb: NEON.cyan, r: 12, strength: 0.35 });
    add({ a: { x: STAIRS.top.x, y: STAIRS.top.y, z: wall - 2 }, b: { x: STAIRS.foot.x, y: STAIRS.top.y, z: DECK.z + 2 }, rgb: NEON.blue, r: 10, strength: 0.3 });
    const turn = INNER.turn;
    add({ a: { x: INNER.x + INNER.width / 2, y: INNER.top, z: DECK.z + 5 }, b: { x: INNER.x + INNER.width / 2, y: turn.y - turn.half, z: turn.z + 5 }, rgb: NEON.cyan, r: 12, strength: 0.35 });
    add({ a: { x: turn.x + turn.half, y: y1, z: turn.z + 5 }, b: { x: INNER.footX, y: y1, z: 5 }, rgb: NEON.cyan, r: 12, strength: 0.35 });
    add({ a: { x: turn.x + turn.half, y: turn.y, z: turn.z - 2 }, b: { x: INNER.footX, y: turn.y, z: 2 }, rgb: NEON.blue, r: 10, strength: 0.3 });
    // The deck's edges and rails.
    add({ a: { x: x0 + DECK.depth, y: y0 + DECK.depth, z: DECK.z + 7 }, b: { x: x0 + DECK.depth, y: DECK.leftY1, z: DECK.z + 7 }, rgb: NEON.pink, r: 9, strength: 0.28 });
    add({ a: { x: x0 + DECK.depth, y: y0 + DECK.depth, z: DECK.z + 7 }, b: { x: DECK.rightX1, y: y0 + DECK.depth, z: DECK.z + 7 }, rgb: NEON.pink, r: 9, strength: 0.28 });
    add({ a: { x: x0 + DECK.depth, y: y0 + DECK.depth, z: DECK.z - 1 }, b: { x: x0 + DECK.depth, y: DECK.leftY1, z: DECK.z - 1 }, rgb: NEON.cyan, r: 8, strength: 0.3 });
    add({ a: { x: x0 + DECK.depth, y: y0 + DECK.depth, z: DECK.z - 1 }, b: { x: DECK.rightX1, y: y0 + DECK.depth, z: DECK.z - 1 }, rgb: NEON.cyan, r: 8, strength: 0.3 });
    // The ADTOPIA sign, the walls' screens and signs, the lamps, the coffee nook.
    add({ a: { x: HQ_SIGN.x + 1, y: HQ_SIGN.y, z: HQ_SIGN.z }, rgb: NEON.pink, r: 40, strength: 0.5, pulse: 0.35, flicker: 0.02 });
    add({ a: { x: HQ_SIGN.x + 1, y: HQ_SIGN.y, z: HQ_SIGN.z - 13 }, rgb: NEON.cyan, r: 16, strength: 0.4 });
    for (const lamp of wallLamps()) add({ a: lamp, rgb: NEON.amber, r: 30, strength: 0.55, pulse: 0.15 });
    add({ a: { x: x0 + 2, y: y0 + 30, z: DECK.z + 50 }, b: { x: x0 + 2, y: STATION.oracle.y + 30, z: DECK.z + 50 }, rgb: NEON.pink, r: 22, strength: 0.32, pulse: 0.4 });
    add({ a: { x: x0 + 2, y: y0 + 30, z: DECK.z + 22 }, b: { x: x0 + 2, y: STATION.oracle.y + 30, z: DECK.z + 22 }, rgb: NEON.cyan, r: 20, strength: 0.28, pulse: 0.5 });
    add({ a: { x: x0 + 2, y: STATION.oracle.y + 70, z: DECK.z + 34 }, rgb: NEON.cyan, r: 22, strength: 0.3 });
    add({ a: { x: x0 + 8, y: STATION.tent.y, z: ROOM.wall - 4 }, b: { x: x0 + 8, y: DECK.leftY1 - 8, z: ROOM.wall - 4 }, rgb: NEON.pink, r: 10, strength: 0.3 });
    add({ a: { x: x0 + 8, y: STATION.tent.y - 2, z: DECK.z + 46 }, rgb: NEON.amber, r: 14, strength: 0.5, pulse: 0.2 });
    add({ a: { x: x0 + INNER.width + 9, y: DECK.leftY1 + 5, z: 16 }, rgb: NEON.pink, r: 18, strength: 0.4, pulse: 0.3 });
    add({ a: { x: x0 + 60, y: DECK.leftY1 + 1, z: 30 }, rgb: NEON.amber, r: 22, strength: 0.45, flicker: 0.01 });
    add({ a: { x: x0 + 40, y: DECK.leftY1 + 1, z: 40 }, b: { x: x0 + 80, y: DECK.leftY1 + 1, z: 40 }, rgb: NEON.amber, r: 10, strength: 0.4, pulse: 0.3 });
    add({ a: { x: x0 + 1, y: y1 - 14, z: INNER.turn.z + 34 }, rgb: NEON.cyan, r: 14, strength: 0.3 });
    add({ a: { x: DECK.rightX1 + 1, y: y0 + DECK.depth - 18, z: 30 }, rgb: NEON.pink, r: 16, strength: 0.35 });
    // The studio: its lights pouring down on the green, and ON AIR beside it.
    add({ a: { x: STUDIO.x + 14, y: STUDIO.y + 14, z: 30 }, rgb: NEON.white, r: 34, strength: 0.32, pulse: 0.1 });
    add({ a: { x: STUDIO.x + STUDIO.size + 9, y: STUDIO.y + 1, z: 47 }, rgb: NEON.pink, r: 14, strength: 0.55, flicker: 0.03 });
    // The video wall's rim.
    add({ a: { x: VIDEO_WALL.x0, y: y0 + 2, z: VIDEO_WALL.z0 }, b: { x: VIDEO_WALL.x1, y: y0 + 2, z: VIDEO_WALL.z0 }, rgb: NEON.blue, r: 10, strength: 0.3 });
    add({ a: { x: VIDEO_WALL.x0, y: y0 + 2, z: VIDEO_WALL.z1 }, b: { x: VIDEO_WALL.x1, y: y0 + 2, z: VIDEO_WALL.z1 }, rgb: NEON.blue, r: 10, strength: 0.3 });
    // The stations: the archive's sign and monitors, the editing bay, the servers, the review desk,
    // the writers' desk and the strategy table, the wall map, the mast's light, the uplink.
    const st = (id: StationId, dx: number, dy: number, z: number) => ({ x: STATION[id].x + dx, y: STATION[id].y + dy, z: STATION[id].z + z });
    add({ a: st("oracle", -6, -2, 15), rgb: NEON.cyan, r: 26, strength: 0.45, pulse: 0.5 });
    add({ a: st("oracle", -6, -2, 8), rgb: NEON.pink, r: 12, strength: 0.3 });
    add({ a: st("workshop", -41, 20, 12), rgb: NEON.cyan, r: 30, strength: 0.4, pulse: 0.3 });
    add({ a: st("workshop", 24, -57, 20), rgb: NEON.jade, r: 20, strength: 0.32, pulse: 0.4 });
    add({ a: st("workshop", -8, -48, 10), rgb: NEON.amber, r: 12, strength: 0.35 });
    add({ a: st("theatre", -15, -15, 24), rgb: NEON.amber, r: 30, strength: 0.45 });
    add({ a: st("tent", -27, -6, 11), rgb: NEON.amber, r: 18, strength: 0.45, pulse: 0.2 });
    add({ a: st("tent", -30, -12, 9), rgb: NEON.cyan, r: 10, strength: 0.4 });
    add({ a: st("scouts", -2, -44, 38), rgb: NEON.blue, r: 40, strength: 0.4, pulse: 0.3 });
    add({ a: st("scouts", -6, -42, 11), rgb: NEON.cyan, r: 20, strength: 0.4, pulse: 0.4 });
    add({ a: st("agora", -6, -6, 16), rgb: NEON.cyan, r: 12, strength: 0.4, pulse: 0.6 });
    // The street: the HQ's sign and door, the shops' signs and awnings, the lamps.
    const front = ENTRANCE.y + ENTRANCE.depth;
    add({ a: { x: 0, y: front + 1.2, z: wall + 42 }, rgb: NEON.pink, r: 40, strength: 0.6, pulse: 0.3, flicker: 0.03, always: true });
    add({ a: { x: 0, y: front + 1.2, z: wall + 31 }, rgb: NEON.cyan, r: 18, strength: 0.5, flicker: 0.01, always: true });
    add({ a: { x: 0, y: front + 4, z: wall + 6 }, rgb: NEON.amber, r: 22, strength: 0.45, always: true });
    for (const side of [-1, 1]) {
      add({ a: { x: side * (ENTRANCE.half - 0.8), y: front, z: wall + 2 }, b: { x: side * (ENTRANCE.half - 0.8), y: front, z: wall + ENTRANCE.tall }, rgb: NEON.pink, r: 10, strength: 0.35, always: true });
      add({ a: { x: side * (ENTRANCE.door + 3), y: front + 0.7, z: wall + 14 }, rgb: NEON.amber, r: 12, strength: 0.45, always: true });
    }
    add({ a: { x: 12, y: front - 14, z: wall + ENTRANCE.tall + 30.4 }, rgb: NEON.pink, r: 8, strength: 0.8, pulse: 0.9, always: true });
    for (const land of LANDS) {
      const rgb = hexRgb(land.color);
      add({ a: { x: land.x, y: land.y - 7, z: LAND_Z + 30.5 }, rgb, r: 26, strength: 0.5, pulse: 0.3, flicker: 0.012 });
      add({ a: { x: land.x - 16, y: land.y - 4.5, z: LAND_Z + 25.4 }, b: { x: land.x + 16, y: land.y - 4.5, z: LAND_Z + 25.4 }, rgb, r: 10, strength: 0.3 });
      // The name down the blade sign, and the logo on the roof.
      const size = storefrontSize(land.prop);
      add({ a: { x: land.x - 16.5, y: land.y - 4, z: LAND_Z + 36 }, b: { x: land.x - 16.5, y: land.y - 4, z: LAND_Z + 34 + size.letters * 8 }, rgb, r: 12, strength: 0.4, pulse: 0.4, flicker: 0.01 });
      add({ a: { x: land.x, y: land.y - 11, z: LAND_Z + size.tall + 15 }, rgb, r: 30, strength: 0.55, pulse: 0.3, flicker: 0.01 });
    }
    for (const lamp of this.streetLamps) {
      const v = lamp.job?.k === "prop" ? lamp.job.v : 0;
      const arm = v >= 8 ? 12.75 : -12.75;
      add({ a: { x: lamp.x, y: lamp.y + arm, z: lamp.z + 42 }, rgb: v % 2 === 1 ? NEON.cyan : NEON.pink, r: 26, strength: 0.45, pulse: 0.15, flicker: 0.008 });
    }
    return out;
  }

  /** How many people stand at each billboard: more as the views grow; few if the videos fall short. */
  private crowdSize() {
    const { live, views, ratio } = this.street;
    if (!live.length) return 0;
    let n = views > 0 ? Math.round(Math.log10(views + 1) * 1.6) : 2;
    if (ratio !== null && ratio < SETBACK) n = Math.max(1, n - 4);
    return Math.max(1, Math.min(8, n));
  }

  /** Hearts rising off the crowds as likes come in, and fireworks over the billboards when the videos win. */
  private streetPixels() {
    const out: Array<{ p: { x: number; y: number; z: number }; rgb: string; a: number; size?: number }> = [];
    if (!this.showing || !this.street.live.length) return out;
    const hearts = this.street.likes > 0 ? Math.min(3, 1 + Math.floor(Math.log10(this.street.likes + 1))) : 0;
    for (const crowd of this.crowds.values()) {
      crowd.forEach((person, i) => {
        if (person.hidden) return;
        for (let k = 0; k < hearts; k++) {
          const t = (this.time * 0.5 + i * 0.29 + k / hearts) % 1;
          out.push({ p: { x: person.x + Math.sin(this.time * 2 + i + k) * 1.2, y: person.y, z: person.z + 18 + t * 18 }, rgb: "255, 92, 180", a: 1 - t, size: 2 });
        }
      });
    }
    if (this.street.ratio !== null && this.street.ratio >= VICTORY) {
      BILLBOARD_LANDS.forEach((id, k) => {
        const land = LAND[id];
        const t = ((this.time + k * 0.7) % 2.2) / 2.2;
        const centre = { x: land.x, y: land.y - 5.5, z: LAND_Z + 60 + k * 4 };
        const colours = ["245, 184, 106", "240, 92, 205", "82, 217, 237"];
        for (let j = 0; j < 14; j++) {
          const a = (j / 14) * Math.PI * 2;
          out.push({ p: { x: centre.x + Math.cos(a) * t * 12, y: centre.y + Math.sin(a) * t * 4, z: centre.z + Math.sin(a) * t * 10 - t * t * 6 }, rgb: colours[k % 3], a: 1 - t, size: 2 });
        }
      });
    }
    return out;
  }

  /**
   * A platform's billboard: its brand while idle, an upload bar while the posts go out, then the
   * posted videos themselves; a gold frame when they beat the top videos, dimmed when they fall short.
   */
  private paintBillboard(id: LandId, ctx: CanvasRenderingContext2D, sx: number, sy: number, px: number) {
    if (!this.showing || this.revealT < 1.2 || typeof document === "undefined") return;
    const W = 15;
    const H = 21;
    let buf = this.billboardBuffers.get(id);
    if (!buf) {
      buf = document.createElement("canvas");
      buf.width = W;
      buf.height = H;
      this.billboardBuffers.set(id, buf);
    }
    const g = buf.getContext("2d")!;
    g.imageSmoothingEnabled = false;
    const t = this.time;
    const { live, sending, ratio } = this.street;
    if (live.length) {
      const pick = live[Math.floor(t / 3 + BILLBOARD_LANDS.indexOf(id)) % live.length];
      const poster = this.bigPosters.get(pick);
      g.fillStyle = "#0b0e22";
      g.fillRect(0, 0, W, H);
      if (poster) g.drawImage(poster, 1.5, 1, 12, 19);
      if (ratio !== null && ratio < SETBACK) {
        g.fillStyle = "rgba(10, 10, 30, 0.55)";
        g.fillRect(0, 0, W, H);
      }
      g.strokeStyle = ratio !== null && ratio >= VICTORY ? (Math.floor(t * 4) % 2 ? "#f5b86a" : "#ffe08a") : "#52d9ed";
      g.lineWidth = 1;
      g.strokeRect(0.5, 0.5, W - 1, H - 1);
    } else if (sending) {
      g.fillStyle = "#0b0e22";
      g.fillRect(0, 0, W, H);
      g.fillStyle = "#3d7bff";
      g.fillRect(2, 14, Math.round(11 * ((t * 0.4) % 1)), 2);
      g.fillStyle = "#52d9ed";
      for (let i = 0; i < 3; i++) g.fillRect(6 + ((Math.floor(t * 4) + i) % 3) - 1, 6 + i * 2, 3, 1);
    } else {
      // Standing by for our videos: a dark screen with an empty 9:16 slot outlined in dashes, an
      // upload arrow breathing in it, and a scan line rolling down.
      g.fillStyle = "#0b0e22";
      g.fillRect(0, 0, W, H);
      g.fillStyle = "rgba(82, 217, 237, 0.55)";
      for (let x = 3; x < 12; x += 2) {
        g.fillRect(x, 3, 1, 1);
        g.fillRect(x, 17, 1, 1);
      }
      for (let y = 3; y < 18; y += 2) {
        g.fillRect(3, y, 1, 1);
        g.fillRect(11, y, 1, 1);
      }
      g.globalAlpha = 0.45 + 0.4 * Math.abs(Math.sin(t * 1.6 + BILLBOARD_LANDS.indexOf(id)));
      g.fillStyle = "#52d9ed";
      g.fillRect(7, 8, 1, 5);
      g.fillRect(6, 9, 3, 1);
      g.fillRect(5, 10, 1, 1);
      g.fillRect(9, 10, 1, 1);
      g.fillRect(5, 14, 5, 1);
      g.globalAlpha = 1;
      g.fillStyle = "rgba(82, 217, 237, 0.12)";
      g.fillRect(0, Math.floor((t * 6) % H), W, 1);
    }
    // Onto the billboard's face, which faces the road (+y): along it +x, up it z.
    const face = { x0: -7.5, y: 0.75, z1: 42.5 };
    const ox = sx + (face.x0 - face.y) * px;
    const oy = sy + ((face.x0 + face.y) / 2 - 1.2247 * face.z1) * px;
    ctx.save();
    ctx.setTransform(px, 0.5 * px, 0, 1.2247 * px, ox, oy);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(buf, 0, 0, 15, 21);
    ctx.restore();
  }

  /** The whole HQ cheers at the video wall for a few seconds, with confetti. */
  celebrate(seconds: number, why: string) {
    this.cheerUntil = this.time + seconds;
    this.cheerWhy = why;
    this.glow.confetti(seconds);
  }

  /**
   * The video wall: its picture is drawn into a small buffer (a pixel per world unit) and laid onto
   * the wall's plane, so it reads as part of the room. Idle it shows the brand; while videos render,
   * their progress; once there is a cut, the videos themselves, large.
   */
  private paintVideoWall(ctx: CanvasRenderingContext2D, sx: number, sy: number, px: number) {
    if (this.revealT < 0.8 || typeof document === "undefined") return;
    const { x0, x1, z0, z1 } = VIDEO_WALL;
    const W = Math.round(x1 - x0);
    const H = Math.round(z1 - z0);
    if (!this.wallBuffer) this.wallBuffer = document.createElement("canvas");
    const buf = this.wallBuffer;
    if (buf.width !== W || buf.height !== H) {
      buf.width = W;
      buf.height = H;
    }
    const g = buf.getContext("2d")!;
    g.imageSmoothingEnabled = false;
    g.fillStyle = "#0b0e22";
    g.fillRect(0, 0, W, H);
    const t = this.time;
    const text = (str: string, x: number, y: number, scale: number, colour: string) => {
      g.fillStyle = colour;
      const cols = textWidth(str);
      for (let u = 0; u < cols; u++) for (let v = 0; v < 7; v++) if (textPixel(str, u, v)) g.fillRect(Math.round(x + u * scale), Math.round(y + v * scale), Math.ceil(scale), Math.ceil(scale));
    };
    const centred = (str: string, y: number, scale: number, colour: string) => text(str, (W - textWidth(str) * scale) / 2, y, scale, colour);
    const posters = this.posterList.map((p) => this.bigPosters.get(p.creativeId)).filter((c): c is HTMLCanvasElement => Boolean(c));
    const cheering = t < this.cheerUntil;
    if ((this.wallMode === "screening" || this.wallMode === "live") && posters.length) {
      // The finished videos, large: the one playing in the middle, the others either side.
      const count = Math.min(3, posters.length);
      const start = Math.floor(t / 3.5) % posters.length;
      const ph = H - 34;
      const pw = Math.round((ph * 9) / 16);
      const gap = Math.max(2, Math.round((W - pw * count) / (count + 1)));
      for (let i = 0; i < count; i++) {
        const poster = posters[(start + i) % posters.length];
        const x = gap + i * (pw + gap);
        const focus = i === Math.floor(count / 2);
        g.globalAlpha = focus ? 1 : 0.55;
        g.drawImage(poster, x, 18, pw, ph);
        if (focus) {
          g.strokeStyle = cheering ? (Math.floor(t * 6) % 2 ? "#f05ccd" : "#52d9ed") : "#52d9ed";
          g.lineWidth = 1;
          g.strokeRect(x - 1.5, 16.5, pw + 3, ph + 3);
          // A play bar running along the bottom of the one playing.
          g.fillStyle = "#f05ccd";
          g.fillRect(x, 18 + ph + 3, Math.round(pw * ((t % 3.5) / 3.5)), 1);
        }
      }
      g.globalAlpha = 1;
      if (cheering) centred(this.cheerWhy, 5, 1.4, Math.floor(t * 6) % 2 ? "#f05ccd" : "#f5b86a");
      else if (this.wallMode === "live") {
        g.fillStyle = Math.floor(t * 2) % 2 ? "#ff5a6e" : "#7d1f3a";
        g.fillRect(W / 2 - 22, 7, 4, 4);
        centred("  LIVE NOW", 6, 1, "#ff5a6e");
      } else centred("▶ NOW SCREENING", 6, 1, "#52d9ed");
    } else if (this.wallMode === "rendering") {
      centred("RENDERING", 8, 1.6, "#52d9ed");
      // A bar per video: blue while it renders, green done, red failed.
      const desks = this.deskStates.length ? this.deskStates : [1];
      desks.forEach((state, i) => {
        const y = 30 + i * 12;
        if (y > H - 30) return;
        g.fillStyle = "#1c2246";
        g.fillRect(10, y, W - 20, 6);
        const done = state === 2 ? 1 : state === 3 ? 1 : ((t * 0.12 + i * 0.27) % 1) * 0.92;
        g.fillStyle = state === 2 ? "#4dc3a0" : state === 3 ? "#ff5a6e" : "#52d9ed";
        g.fillRect(10, y, Math.round((W - 20) * done), 6);
        text(String(i + 1), 2, y - 0.5, 1, "#aaa7d8");
      });
      // A film strip scrolling along the bottom.
      const stripY = H - 22;
      g.fillStyle = "#151a35";
      g.fillRect(0, stripY, W, 18);
      for (let x = -((t * 18) % 16); x < W; x += 16) {
        g.fillStyle = "#3d7bff";
        g.fillRect(Math.round(x) + 2, stripY + 3, 12, 12);
        g.fillStyle = "#0b0e22";
        g.fillRect(Math.round(x) + 6, stripY + 1, 1, 1);
      }
    } else {
      // Idle: the brand, and an equaliser.
      centred("ADTOPIA", 30, 2, "#f05ccd");
      centred("AUTONOMOUS UGC STUDIO", 52, 0.8, "#52d9ed");
      const bars = 20;
      const bw = (W - 20) / bars;
      for (let i = 0; i < bars; i++) {
        const h = 6 + Math.abs(Math.sin(t * 2.2 + i * 0.7)) * 22;
        g.fillStyle = i % 3 ? "#3d7bff" : "#52d9ed";
        g.fillRect(Math.round(10 + i * bw), Math.round(H - 10 - h), Math.max(1, Math.round(bw - 1)), Math.round(h));
      }
    }
    // Scanlines.
    g.fillStyle = "rgba(0, 0, 0, 0.18)";
    for (let y = 0; y < H; y += 2) g.fillRect(0, y, W, 1);
    // Onto the wall's plane: along it, +x runs right and down on screen; up it, z runs straight up.
    const y = ROOM.y0 + 1.75;
    const ox = sx + (x0 - y) * px;
    const oy = sy + ((x0 + y) / 2 - 1.2247 * z1) * px;
    ctx.save();
    ctx.setTransform(px, 0.5 * px, 0, 1.2247 * px, ox, oy);
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = Math.min(1, (this.revealT - 0.8) / 0.6);
    ctx.drawImage(buf, 0, 0, W, H);
    ctx.restore();
  }

  private readonly timers: Array<{ at: number; run: () => void }> = [];

  /** Runs `run` after `seconds` of scene time (paused with the scene, unlike setTimeout). */
  private later(seconds: number, run: () => void) {
    this.timers.push({ at: this.time + seconds, run });
  }

  private tick(dt: number) {
    this.time += dt;
    this.revealTick(dt);
    this.updateQuietRoad();
    this.placeMarkers();
    for (let i = this.timers.length - 1; i >= 0; i--) {
      if (this.timers[i].at > this.time) continue;
      const [timer] = this.timers.splice(i, 1);
      timer.run();
    }
    // Animate agents that are at their posts.
    for (const agent of this.agents.values()) {
      if ((agent.where !== "posted" && agent.where !== "afield") || agent.busy) continue;
      const e = agent.entity;
      // While the HQ celebrates, everyone at a post turns to the video wall and cheers.
      const cheering = this.time < this.cheerUntil && agent.where === "posted" && !agent.plan.army;
      const act: Act = cheering ? "cheer" : e.act;
      const dir = cheering ? dirFor((VIDEO_WALL.x0 + VIDEO_WALL.x1) / 2 - e.x, ROOM.y0 - e.y) : e.dir;
      const frames = ACT_FRAMES[act];
      const f = frames > 1 ? Math.floor((this.time + agent.phase) / ACT_RATE[act]) % frames : 0;
      e.job = { k: "soldier", look: e.look, act, dir, f };
      agent.frame = f;
      if ((e.reveal ?? 1) < 1 && this.revealT > 0.6) e.reveal = Math.min(1, (e.reveal ?? 0) + dt * 1.6);
    }
    for (const steed of this.landSteeds.values()) if ((steed.reveal ?? 1) < 1 && this.revealT > 2.4) steed.reveal = Math.min(1, (steed.reveal ?? 0) + dt * 1.6);
    // Desk screens: a working screen scrolls through four frames.
    const phase = Math.floor(this.time / 0.22) % 4;
    for (const desk of this.desks.values()) {
      desk.job = { k: "prop", id: "desk", v: desk.state * 4 + (desk.state === 1 ? phase : 0) };
      if (desk.reveal !== undefined && desk.reveal < 1 && this.revealT > 0.5) desk.reveal = Math.min(1, desk.reveal + dt * 1.5);
    }
    // Banners wave; the oracle's television flickers while it studies.
    const wave = Math.floor(this.time / 0.18) % 4;
    for (let i = 0; i < 3; i++) {
      const banner = this.keyed.get(`agora:banner${i}`);
      if (banner?.job?.k === "prop") banner.job = { k: "prop", id: "banner", v: i * 4 + ((wave + i) % 4) };
    }
    // The working stations' lights on the command table pulse.
    // The archive's racks blink and its monitors scroll; the strategy table's hologram turns; the
    // uplink's chart refreshes.
    const frame = Math.floor(this.time / 0.35) % 4;
    const shrine = this.keyed.get("oracle:shrine");
    if (shrine?.job?.k === "prop") shrine.job = { k: "prop", id: "shrine", v: (this.tvOn ? 4 : 0) + (Math.floor(this.time / 0.3) % 4) };
    const table = this.keyed.get("tent:maptable");
    if (table?.job?.k === "prop") table.job = { k: "prop", id: "maptable", v: frame };
    // The analysts work at the table while the viral study runs, and sit back otherwise.
    const studying = this.lastStates.oracle === "working";
    this.analysts.forEach((p, i) => {
      p.hidden = !this.showing || this.revealT < 1.2;
      if (p.hidden) return;
      const act: Act = this.time < this.cheerUntil ? "cheer" : studying ? "type" : "sit";
      const frames = ACT_FRAMES[act];
      p.job = { k: "soldier", look: p.look, act, dir: ORACLE_SEATS[i].dir, f: frames > 1 ? Math.floor((this.time + i * 0.53) / ACT_RATE[act]) % frames : 0 };
    });
    // The crowds on the street: as many as the views call for; cheering when the videos beat the top
    // videos, drifting off when they fall short.
    const crowdSize = this.crowdSize();
    const won = this.street.ratio !== null && this.street.ratio >= VICTORY;
    for (const crowd of this.crowds.values()) {
      crowd.forEach((person, i) => {
        const p = person as Entity & { look: number; act: Act };
        p.hidden = !this.showing || this.revealT < 1.2 || i >= crowdSize;
        if (p.hidden) return;
        const act: Act = won ? "cheer" : "stand";
        const frames = ACT_FRAMES[act];
        p.job = { k: "soldier", look: p.look, act, dir: 6, f: frames > 1 ? Math.floor((this.time + i * 0.37) / ACT_RATE[act]) % frames : 0 };
      });
    }
    // The city map's pins, the film set's REC light and sign, the render servers, the analytics board.
    for (const [key, id, rate] of [
      ["scouts:map", "mapscreen", 0.5],
      ["workshop:filmset", "filmset", 0.6],
      ["workshop:farm", "renderfarm", 0.35],
      ["agora:dashboard", "dashboard", 0.8],
      ["agora:mast", "mast", 0.7],
    ] as const) {
      const prop = this.keyed.get(key);
      if (prop?.job?.k === "prop") prop.job = { k: "prop", id, v: Math.floor(this.time / rate) % 4 };
    }
    const uplinkProp = this.keyed.get("agora:podium");
    if (uplinkProp?.job?.k === "prop") uplinkProp.job = { k: "prop", id: "podium", v: Math.floor(this.time / 0.8) % 4 };
    this.expedition.tick(dt);
  }

  private revealTick(dt: number) {
    const targets = [...this.grounds, ...this.props];
    // The landing's lights come on with the HQ's door.
    if (this.stage.baker.has({ k: "horse-body" })) this.glow.landingLevel = Math.min(1, this.glow.landingLevel + dt * 1.5);
    this.glow.level = this.showing ? Math.min(1, Math.max(0, (this.revealT - 0.6) / 1.2)) : Math.max(0, this.glow.level - dt * 2);
    this.expedition.revealTick(dt, this.showing && this.revealT > 0.4);
    if (!this.showing) {
      for (const entity of targets) entity.reveal = Math.max(0, (entity.reveal ?? 0) - dt * 2);
      this.revealT = 0;
      return;
    }
    if (this.revealT <= 0 && this.landing.isOpen) this.revealT = 0.0001;
    if (this.revealT <= 0) return;
    this.revealT += dt;
    // Grounds appear one after another along the road, grain by grain; furniture follows; then
    // the roads west and the lands along them.
    for (const ground of this.grounds) ground.reveal = Math.max(ground.reveal ?? 0, Math.min(1, (this.revealT - (this.revealAt.get(ground) ?? 0)) / 0.6));
    this.props.forEach((prop, i) => {
      const at = this.revealAt.get(prop) ?? 0.5 + i * 0.05;
      prop.reveal = Math.max(prop.reveal ?? 0, Math.min(1, (this.revealT - at) / 0.5));
    });
  }

  private loadPoster(id: string, url: string | null, videoUrl: string | null) {
    if (this.posters.has(id) || typeof document === "undefined") return;
    this.posters.set(id, null);
    const toPixels = (source: CanvasImageSource, w: number, h: number) => {
      const canvas = document.createElement("canvas");
      canvas.width = 9;
      canvas.height = 16;
      const ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      // Cover-crop to 9:16.
      const scale = Math.max(9 / w, 16 / h);
      ctx.drawImage(source, (9 - w * scale) / 2, (16 - h * scale) / 2, w * scale, h * scale);
      this.posters.set(id, canvas);
      // And a bigger one for the video wall.
      const big = document.createElement("canvas");
      big.width = 36;
      big.height = 64;
      const bctx = big.getContext("2d")!;
      bctx.imageSmoothingEnabled = true;
      bctx.imageSmoothingQuality = "high";
      const bscale = Math.max(36 / w, 64 / h);
      bctx.drawImage(source, (36 - w * bscale) / 2, (64 - h * bscale) / 2, w * bscale, h * bscale);
      this.bigPosters.set(id, big);
    };
    const fromVideo = () => {
      if (!videoUrl) return;
      const video = document.createElement("video");
      video.muted = true;
      video.preload = "auto";
      video.src = `${videoUrl}#t=1`;
      video.addEventListener("loadeddata", () => toPixels(video, video.videoWidth || 9, video.videoHeight || 16), { once: true });
    };
    if (!url) return fromVideo();
    const img = new Image();
    img.onload = () => toPixels(img, img.naturalWidth, img.naturalHeight);
    img.onerror = fromVideo;
    img.src = url;
  }

  private paintScreen(ctx: CanvasRenderingContext2D, sx: number, sy: number, px: number) {
    // The videos play on the video wall now; the review desk's own screen stays as its model draws it.
    if (this.posterList.length >= 0) return;
    // The screen faces the camera, so it is an upright rectangle on screen.
    const width = 2 * SCREEN.half * Math.SQRT2 * 0.98;
    const top = sy - (SCREEN.top - 0.3) * 1.2247 * px + 0.25 * px;
    const height = (SCREEN.top - SCREEN.bottom - 0.6) * 1.2247 * px;
    const count = Math.min(3, this.posterList.length);
    const start = Math.floor(this.time / 4) % this.posterList.length;
    const slotW = (width * px) / 3;
    for (let i = 0; i < count; i++) {
      const poster = this.posterList[(start + i) % this.posterList.length];
      const pixels = this.posters.get(poster.creativeId);
      const w = Math.round(9 * (height / 16));
      const x = Math.round(sx - (width * px) / 2 + slotW * (i + (3 - count) / 2) + (slotW - w) / 2);
      const y = Math.round(top);
      ctx.imageSmoothingEnabled = false;
      if (pixels) ctx.drawImage(pixels, x, y, w, Math.round(height));
      else {
        ctx.fillStyle = "#2a2d33";
        ctx.fillRect(x, y, w, Math.round(height));
      }
    }
  }
}

export { hub };
