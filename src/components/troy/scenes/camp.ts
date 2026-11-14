import { type Act, ACT_FRAMES, ACT_RATE, dirFor, type Job, RIDER_FRAMES } from "../engine/jobs";
import { exitPath } from "../engine/models/horse";
import { HUB_STATES } from "../engine/models/cyber";
import { wallLamps } from "../engine/models/hq";
import { type GlowSource, GlowLayer, NEON } from "../engine/glow";
import { SCREEN } from "../engine/models/props";
import type { CameraTarget, Entity, Stage } from "../engine/stage";
import { projectX, projectY } from "../engine/tracer";
import type { Point } from "../engine/walker";
import type { AgentPlan, CampPlan } from "./derive";
import type { LandingScene } from "./landing";
import { type Enlisted, Expedition } from "./expedition";
import { CAMP_CENTER, ENTRANCE, LAND_Z, LOFT, ROOM, STREET_LANE, ROOM_CENTER, ROOM_HALF, STAIRS, STAIRS_TOP, HARBOR_VIEW, hub, ISLAND_RADIUS, JUNCTION, LAND, type LandId, LANDS, LANDS_VIEW, MAP_BOUNDS, type Node, ROME, ROME_VIEW, roadToLand, sandbars, scoutLand, STATION, type StationId, STATIONS, travel, WORLD_VIEW, worldTrails } from "./layout";
import { COURIER_STALL, DESK_SLOTS, LAND_SPOTS, PROPS, SPOTS, STABLE_AISLE, STABLE_GATE, STALLS, type Waypoint } from "./stations";

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
const PLACE: Record<Node, string> = { horse: "the street door", scouts: "the intelligence desk", oracle: "the reference archive", tent: "the strategy table", workshop: "the production studio", theatre: "the approval desk", agora: "the publishing terminal" };

/** What a figure standing at its post looks like it is doing, by its act. */
const ACT_WORDS: Record<Act, string> = {
  stand: "Standing by",
  march: "On the march",
  carry: "Carrying a data package",
  climb: "Climbing",
  type: "Typing at the desk",
  paint: "Painting at the easel",
  inspect: "Studying a shot through a lens",
  read: "Taking notes",
  lookout: "Keeping watch from the tower",
  herald: "Sounding the trumpet from the podium",
  point: "Pointing out the plan on the map",
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
  rollOut: (brand: string | null) => `Team ${brand?.trim() || "Surreel"}, down to the HQ! Let's roll out!`,
};

/** Where the street's cars drive from and to (world x); they wrap round. */
const CAR_X0 = -80;
const CAR_X1 = ROOM.x1 + 190;

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
  /** Packets of work running between stations along the floor (see dispatch). */
  private readonly packets: Array<{ from: StationId; to: StationId; at: number }> = [];
  private readonly cars: Array<{ entity: Entity; dir: number; rgb: string }> = [];
  private readonly glow: GlowLayer;
  private staticGlow: GlowSource[] | null = null;
  /** The command table: its lights follow the stations' states. */
  private readonly hub: Entity;
  /** The six stations' states as the table's digits (HUB_STATES), and whether posts are going out. */
  private hubCode = 0;
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
    // Bake the room while the visitor is still on the landing (after the HQ's door, which asks higher).
    void stage.baker.request({ k: "room" }, 3).catch(() => undefined);
    for (const station of STATIONS) {
      for (const placement of PROPS[station.id]) {
        const entity = stage.add({
          x: station.x + placement.x,
          y: station.y + placement.y,
          z: 0,
          sort: placement.sort ?? 0,
          job: { k: "prop", id: placement.prop, v: placement.v ?? 0 },
          reveal: 0,
          priority: 4,
        });
        this.props.push(entity);
        if (placement.key) this.keyed.set(`${station.id}:${placement.key}`, entity);
      }
    }
    // The command table in the middle of the room, and the light trails out of the uplink.
    this.hub = stage.add({ x: ROOM_CENTER.x, y: ROOM_CENTER.y, z: 0, job: { k: "prop", id: "hub", v: 0 }, reveal: 0, priority: 4 });
    this.props.push(this.hub);
    stage.add({ x: STATION.agora.x, y: STATION.agora.y, z: 0, sort: 60, paint: (ctx, sx, sy, px, time) => this.paintUplink(ctx, sx, sy, px, time) });
    // The street's lamps along the kerb, and hover cars passing both ways.
    for (let x = -50, i = 0; x < ROOM.x1 + 170; x += 52, i++) {
      if (Math.abs(x - STAIRS_TOP.x) < 16 || Math.abs(x - ENTRANCE.x) < 26) continue;
      const lamp = stage.add({ x, y: ROOM.y0 - 29, z: LAND_Z, job: { k: "prop", id: "streetlamp", v: i }, reveal: 0, priority: 3.8 });
      this.props.push(lamp);
      this.streetLamps.push(lamp);
    }
    const lanes = [
      { y: ROOM.y0 - 52, dir: 1 },
      { y: ROOM.y0 - 68, dir: -1 },
    ];
    for (let i = 0; i < 5; i++) {
      const lane = lanes[i % 2];
      const span = CAR_X1 - CAR_X0;
      const car: Entity = stage.add({
        x: CAR_X0 + ((i * 0.37 + 0.1) % 1) * span,
        y: lane.y,
        z: LAND_Z + 2.4,
        sort: 2,
        job: { k: "prop", id: "car", v: (i % 4) + (lane.dir < 0 ? 4 : 0) },
        priority: 3.6,
        tick: (dt) => {
          car.x += lane.dir * (22 + (i % 3) * 7) * dt;
          if (car.x > CAR_X1) car.x = CAR_X0;
          if (car.x < CAR_X0) car.x = CAR_X1;
          car.z = LAND_Z + 2.4 + Math.sin(this.time * 2 + i) * 0.4;
          // On the landing only the slice of street in front of the HQ's door is there to drive on.
          car.hidden = this.showing ? this.revealT < 1.2 : Math.abs(car.x) > 40;
        },
      });
      this.cars.push({ entity: car, dir: lane.dir, rgb: [NEON.pink, NEON.cyan, NEON.amber, NEON.blue][i % 4] });
    }
    // The light over everything: neon halos that breathe and flicker, and drifting motes.
    this.glow = new GlowLayer(() => this.glowSources(), { x0: ROOM.x0 - 40, y0: ROOM.y0 - 110, x1: ROOM.x1 + 160, y1: ROOM.y1, z: ROOM.wall + 60 });
    // Steam off the coffee on every editing desk (the cup sits at the desk's back right).
    this.glow.steam = () => [...this.desks.values()].filter((d) => (d.reveal ?? 1) > 0.9).map((d) => ({ x: d.x - 1.7, y: d.y + 3.7, z: 9.5 }));
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
    const scouts = STATION.scouts;
    for (const stall of STALLS) {
      const steed = stage.add({ x: scouts.x + stall.horse.x, y: scouts.y + stall.horse.y, z: 0, shadow: 8, job: { k: "steed", dir: stall.horse.dir, h: stall.coat }, reveal: 0, priority: 4 });
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
  camera(insets: { top: number; bottom: number; right: number } = this.insets): CameraTarget {
    const { width, height } = this.stage.size;
    // The basement from wall to wall, and the street above the right wall.
    const spanX = 2 * (ROOM_HALF * 2 + 16);
    const spanY = ROOM_HALF * 2 + ROOM.wall * 1.22 + 130;
    const usableW = width - insets.right - 24;
    const usableH = height - insets.top - insets.bottom;
    const fit = Math.min(usableW / spanX, usableH / spanY, 3.5);
    const zoom = this.stage.fitZoom(fit);
    const midY = CAMP_CENTER.sy - 70;
    return { x: CAMP_CENTER.sx + insets.right / 2 / zoom, y: midY + (insets.bottom - insets.top) / 2 / zoom, zoom };
  }

  insets = { top: 84, bottom: 72, right: 0 };

  /** The camera that shows the camp and every land around it (while the scouts are out). */
  world(insets: { top: number; bottom: number; right: number } = this.insets): CameraTarget {
    return this.fitView(WORLD_VIEW, insets);
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
  focus(id: StationId, insets = this.insets): CameraTarget {
    const base = this.camera(insets);
    const station = STATION[id];
    // Close enough to see who is doing what, in whole device pixels.
    const zoom = Math.min(this.stage.fitZoom(Math.max(2, base.zoom * 1.6)), 4);
    const sx = projectX(station.x, station.y);
    const sy = projectY(station.x, station.y, 4);
    return { x: sx + insets.right / 2 / zoom, y: sy + (insets.bottom - insets.top) / 2 / zoom, zoom };
  }

  /** Where a station sits on screen (CSS px), for labels. */
  stationPoint(id: StationId) {
    const s = STATION[id];
    return { x: s.x, y: s.y, z: 0 };
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
    this.hubCode = STATIONS.reduce((code, s, i) => code + HUB_STATES.indexOf(plan.stations[s.id].state) * 6 ** i, 0);
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
    // A packet of data runs along the floor's cables from one station, via the command table, to the next.
    this.packets.push({ from, to, at: this.time });
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
      Object.assign(agent.entity, { x: p.x, y: p.y, z: 0, dir: spot.dir, act: LAND_ACT[land], reveal: 0, alpha: 1, shadow: 5 });
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
    Object.assign(agent.entity, { x: post.x, y: post.y, z: post.z, dir: plan.dir, act: plan.act, reveal: 0, alpha: 1 });
    agent.entity.shadow = post.z < 1 ? 5 : 0;
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
    const far = agent.node !== plan.station;
    // Already in by the same way (a soldier moving up on the battlefield): straight to the new post.
    if (!far && agent.up && plan.via && this.sameWay(agent.up, this.viaSteps(plan))) {
      agent.doing = "Moving up";
      this.run(agent, [{ ...this.postPoint(plan), dir: plan.dir }], plan.act === "fight" || plan.act === "cheer" ? SPEED.run : SPEED.walk, () => undefined);
      return;
    }
    const steps: Step[] = [...this.descend(agent)];
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
    agent.node = "scouts";
    agent.trip = "out";
    if (stall < 0) {
      agent.onFoot = true;
      agent.doing = `Every bike is out: running to ${name} for ${this.source(agent)}`;
      const out = this.descend(agent);
      if (!this.atStable(agent)) out.push(this.gate());
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
    this.landSteeds.set(agent, this.stage.add({ x: p.x, y: p.y, z: p.z, shadow: 8, job: { k: "steed", dir: horse.dir, h: agent.entity.coat } as Job, reveal, priority: 3 }));
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
    if (agent.onFoot || agent.stall === null) {
      agent.onFoot = false;
      agent.doing = carrying ? `Running back from ${name} with a data package` : `Running back from ${name}`;
      if (carrying) return this.run(agent, [...home, this.gate(), basket], SPEED.run, deliver, "carry");
      backEmpty();
      return this.run(agent, [...home, this.gate()], SPEED.run, () => undefined);
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
            // Into the basket with it.
            agent.entity.act = "carry";
            agent.doing = "Carrying the data package to the intake bin";
            this.run(agent, [...this.outOfStable(agent), basket], SPEED.run, deliver, "carry");
          });
        });
      });
    });
  }

  /** The courier saddles up, rides to where the work is, then on to the station that needs it. */
  private courierRun(agent: Agent) {
    const stall = agent.stall ?? this.freeStall(agent);
    // The courier's horse is his alone, so it is always in when he is.
    if (stall < 0) return;
    this.stalls[stall].rider = agent;
    agent.stall = stall;
    agent.node = "scouts";
    agent.doing = "Going to the bike bay for a scooter";
    this.run(agent, this.toStall(agent, stall), SPEED.walk, () => {
      agent.doing = "Saddling up";
      this.mount(agent, stall, () => this.courierLeg(agent));
    });
  }

  private courierLeg(agent: Agent) {
    const job = this.dispatches.shift();
    const stall = agent.stall!;
    // Leave the stable through its gate, or cross the island the last job ended on.
    const lead: Step[] = this.atStable(agent) ? [...this.outOfStable(agent), hub("scouts")] : [hub(agent.node)];
    if (!job) {
      // Nothing more to carry: back to the stable, unsaddle, back to the post.
      const home: Step[] = agent.node === "scouts" ? [] : [...travel(agent.node, "scouts"), hub("scouts")];
      const steps: Step[] = [...lead, ...home, ...this.intoStable(stall, "horse")];
      agent.node = "scouts";
      agent.errand = null;
      agent.doing = "Riding back to the bike bay";
      this.ride(agent, steps, SPEED.courier, 1, () => this.dismount(agent, false, () => this.settle(agent)));
      return;
    }
    const pickup: Step[] = [...lead, ...travel(agent.node, job.from)];
    agent.node = job.from;
    agent.errand = { from: job.from, to: job.to };
    agent.doing = `Riding to ${PLACE[job.from]} to collect the finished work`;
    // Who talks at each end: the station's head and the courier.
    const talk = (phase: "pickup" | "handover", station: StationId) => {
      const head = HEAD[station];
      const speakers = phase === "pickup" ? [head, "courier"] : ["courier", head];
      this.events.onExchange?.({ key: job.key, from: job.from, to: job.to, phase, speakers: speakers.filter((id): id is string => Boolean(id && this.agents.has(id))) });
    };
    this.ride(agent, pickup, SPEED.courier, 1, () => {
      agent.doing = `Collecting the work at ${PLACE[job.from]}`;
      talk("pickup", job.from);
      this.pause(agent, BEAT.pickup, () => {
        agent.node = job.to;
        agent.doing = `Carrying the work to ${PLACE[job.to]}`;
        this.ride(agent, [hub(job.from), ...travel(job.from, job.to)], SPEED.courier, 1, () => {
          this.events.onArrive?.(job.to);
          talk("handover", job.to);
          agent.deliveries++;
          agent.doing = `Handing the work over at ${PLACE[job.to]}`;
          this.pause(agent, BEAT.handover, () => this.courierLeg(agent));
        });
      });
    });
  }

  /** Swaps the walker for a rider on the stall's horse, standing a moment before moving off. */
  private mount(agent: Agent, stall: number, then: () => void) {
    const at = STALLS[stall];
    const steed = this.stalls[stall].steed;
    this.stage.remove(steed);
    const e = agent.entity;
    Object.assign(e, { x: steed.x, y: steed.y, z: 0, dir: at.horse.dir, shadow: 9 });
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
      const spot = this.rel("scouts", at.mount.x, at.mount.y, 0);
      Object.assign(e, { x: spot.x, y: spot.y, z: 0, dir: at.mount.dir, shadow: 5, act: carrying ? "carry" : "stand" });
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
      e.shadow = e.z < 1 ? 5 : 0;
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
  private toStall(agent: Agent, stall: number): Step[] {
    // Already in the stable (just back from a ride, say): along the aisle to the horse.
    if (this.atStable(agent)) return this.intoStable(stall, "mount").slice(2);
    const steps: Step[] = [...this.descend(agent)];
    if (agent.node !== "scouts") steps.push(...travel(agent.node, "scouts"), hub("scouts"));
    steps.push(...this.intoStable(stall, "mount"));
    return steps;
  }

  private gate(): Point {
    return this.rel("scouts", STABLE_GATE.x, STABLE_GATE.y, 0);
  }

  /** From a stall (on foot or on horseback) back into the aisle behind the horses, and out of the gate. */
  private outOfStable(agent: Agent): Step[] {
    const y = agent.entity.y - STATION.scouts.y;
    return [this.rel("scouts", STABLE_AISLE.x, y, 0), this.rel("scouts", STABLE_AISLE.x, STABLE_AISLE.south, 0), this.gate()];
  }

  /** In at the gate and up the aisle to a stall: its horse (riding in), or behind it (walking up to mount). */
  private intoStable(stall: number, to: "horse" | "mount"): Step[] {
    const spot = STALLS[stall][to];
    return [
      this.gate(),
      this.rel("scouts", STABLE_AISLE.x, STABLE_AISLE.south, 0),
      this.rel("scouts", STABLE_AISLE.x, spot.y, 0),
      { ...this.rel("scouts", spot.x, spot.y, 0), dir: spot.dir },
    ];
  }

  private atStable(agent: Agent) {
    const s = STATION.scouts;
    return agent.node === "scouts" && agent.entity.x - s.x < STABLE_GATE.x + 2;
  }

  private rel(station: StationId, x: number, y: number, z: number): Point {
    const s = STATION[station];
    return { x: s.x + x, y: s.y + y, z };
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
    if (!up?.length) return this.atStable(agent) ? this.outOfStable(agent) : [];
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
    if (!this.uplinkOn) return;
    const from = { x: -6, y: -6, z: 18 };
    const colours = ["#52d9ed", "#f05ccd", "#ff5a6e"];
    for (let k = 0; k < 3; k++) {
      const to = { x: -40 + k * 30, y: -150 - k * 20, z: ROOM.wall + 40 };
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
      moving.push({ a: { x: e.x + car.dir * 8, y: e.y, z: e.z + 3.4 }, rgb: NEON.white, r: 14, strength: 0.5, pulse: 0, phase: i, always: true });
      moving.push({ a: { x: e.x, y: e.y, z: e.z + 1.6 }, rgb: car.rgb, r: 16, strength: 0.45, pulse: 0.1, phase: i + 0.5, always: true });
    });
    // Packets: a bright core with a halo, out along the cable to the table and on to the next station.
    const centre = { x: ROOM_CENTER.x, y: ROOM_CENTER.y, z: 1 };
    for (const p of this.packets) {
      const t = (this.time - p.at) / 2.6;
      if (t < 0 || t > 1) continue;
      const a = { x: STATION[p.from].x, y: STATION[p.from].y, z: 1 };
      const b = { x: STATION[p.to].x, y: STATION[p.to].y, z: 1 };
      const [u, v, k] = t < 0.5 ? [a, centre, t * 2] : [centre, b, t * 2 - 1];
      const at = { x: u.x + (v.x - u.x) * k, y: u.y + (v.y - u.y) * k, z: 2 };
      moving.push({ a: at, rgb: NEON.white, r: 6, strength: 0.9, pulse: 0, phase: 0 });
      moving.push({ a: at, rgb: t < 0.5 ? NEON.cyan : NEON.pink, r: 20, strength: 0.6, pulse: 0, phase: 0 });
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
    // The stairs' rail and the lights under its treads.
    add({ a: { x: STAIRS.top.x, y: STAIRS.top.y + STAIRS.width / 2, z: wall + 5 }, b: { x: STAIRS.foot.x, y: STAIRS.top.y + STAIRS.width / 2, z: 5 }, rgb: NEON.cyan, r: 12, strength: 0.35 });
    add({ a: { x: STAIRS.top.x, y: STAIRS.top.y, z: wall - 2 }, b: { x: STAIRS.foot.x, y: STAIRS.top.y, z: 4 }, rgb: NEON.blue, r: 10, strength: 0.3 });
    // The SURREEL sign on the left wall, the wall lamps and the posters.
    add({ a: { x: x0 + 1, y: y0 + (y1 - y0) * 0.62, z: 70 }, rgb: NEON.pink, r: 38, strength: 0.5, pulse: 0.35, flicker: 0.02 });
    for (const lamp of wallLamps()) add({ a: lamp, rgb: NEON.amber, r: 30, strength: 0.55, pulse: 0.15 });
    add({ a: { x: x0 + 1, y: y0 + (y1 - y0) * 0.86, z: 62 }, rgb: NEON.blue, r: 14, strength: 0.3 });
    // The loft: its rail, the racks and the analytics wall over it.
    add({ a: { x: x0 + LOFT.depth, y: y0, z: LOFT.z + 7 }, b: { x: x0 + LOFT.depth, y: LOFT.y1, z: LOFT.z + 7 }, rgb: NEON.pink, r: 10, strength: 0.3 });
    add({ a: { x: x0 + 1.5, y: y0 + 32, z: LOFT.z + 26 }, rgb: NEON.blue, r: 40, strength: 0.4, pulse: 0.35 });
    add({ a: { x: x0 + 9, y: y0 + 14, z: LOFT.z + 9 }, rgb: NEON.cyan, r: 14, strength: 0.35, pulse: 0.6 });
    add({ a: { x: x0 + 1, y: y0 + (y1 - y0) * 0.78, z: 32 }, rgb: NEON.cyan, r: 14, strength: 0.3 });
    add({ a: { x: x0 + (x1 - x0) * 0.74, y: y0 + 1, z: 62 }, rgb: NEON.pink, r: 14, strength: 0.3 });
    add({ a: { x: x0 + (x1 - x0) * 0.62, y: y0 + 1.5, z: 30 }, rgb: NEON.cyan, r: 16, strength: 0.35, pulse: 0.5 });
    // The stations: the command table, the archive's sign and monitors, the desks, the approval
    // screen's warm bar, the uplink, the strategy corner's notes.
    add({ a: { x: ROOM_CENTER.x, y: ROOM_CENTER.y, z: 14 }, rgb: NEON.cyan, r: 30, strength: 0.5, pulse: 0.4 });
    add({ a: { x: ROOM_CENTER.x, y: ROOM_CENTER.y, z: 19 }, rgb: NEON.pink, r: 14, strength: 0.5 });
    const st = (id: StationId, dx: number, dy: number, z: number) => ({ x: STATION[id].x + dx, y: STATION[id].y + dy, z });
    add({ a: st("oracle", -12, -3, 19.6), rgb: NEON.pink, r: 16, strength: 0.4, flicker: 0.02 });
    add({ a: st("oracle", -21, -12, 10), rgb: NEON.cyan, r: 22, strength: 0.4, pulse: 0.5 });
    add({ a: st("workshop", -14, -10, 12), rgb: NEON.cyan, r: 30, strength: 0.4, pulse: 0.3 });
    add({ a: st("workshop", 18, -28, 10), rgb: NEON.jade, r: 14, strength: 0.3 });
    add({ a: st("theatre", -15, -15, 24), rgb: NEON.amber, r: 30, strength: 0.45 });
    add({ a: st("tent", -24, -12, 12), rgb: NEON.pink, r: 22, strength: 0.35, pulse: 0.3 });
    add({ a: st("tent", 12, 8, 8), rgb: NEON.cyan, r: 16, strength: 0.45, pulse: 0.5 });
    add({ a: st("scouts", -16, -14, 36), rgb: NEON.pink, r: 8, strength: 0.7, pulse: 0.9 });
    add({ a: st("agora", -6, -6, 16), rgb: NEON.cyan, r: 12, strength: 0.4, pulse: 0.6 });
    // The street: the HQ's sign and door, the shops' signs and awnings, the lamps.
    const front = ENTRANCE.y + ENTRANCE.depth;
    add({ a: { x: 0, y: front + 1.2, z: wall + 38 }, rgb: NEON.pink, r: 40, strength: 0.6, pulse: 0.3, flicker: 0.03, always: true });
    add({ a: { x: 0, y: front + 1.2, z: wall + 27 }, rgb: NEON.cyan, r: 18, strength: 0.5, flicker: 0.01, always: true });
    add({ a: { x: 0, y: front + 4, z: wall + 6 }, rgb: NEON.amber, r: 22, strength: 0.45, always: true });
    for (const side of [-1, 1]) {
      add({ a: { x: side * (ENTRANCE.half - 0.8), y: front, z: wall + 2 }, b: { x: side * (ENTRANCE.half - 0.8), y: front, z: wall + ENTRANCE.tall }, rgb: NEON.pink, r: 10, strength: 0.35, always: true });
      add({ a: { x: side * (ENTRANCE.door + 3), y: front + 0.7, z: wall + 12 }, rgb: NEON.amber, r: 12, strength: 0.45, always: true });
    }
    add({ a: { x: 10, y: ENTRANCE.y, z: wall + ENTRANCE.tall + 14.4 }, rgb: NEON.pink, r: 8, strength: 0.8, pulse: 0.9, always: true });
    // The puddles on the landing's slice of street catch the sign.
    for (const [px, py, rgb] of [
      [18, STREET_LANE + 9, NEON.pink],
      [-22, STREET_LANE - 6, NEON.cyan],
      [30, STREET_LANE - 14, NEON.blue],
    ] as const) add({ a: { x: px, y: py, z: wall + 0.2 }, rgb, r: 12, strength: 0.35, pulse: 0.5, always: true });
    for (const land of LANDS) {
      const rgb = hexRgb(land.color);
      add({ a: { x: land.x, y: land.y - 7, z: LAND_Z + 15.5 }, rgb, r: 26, strength: 0.5, pulse: 0.3, flicker: 0.012 });
      add({ a: { x: land.x - 16, y: land.y - 3.6, z: LAND_Z + 10.2 }, b: { x: land.x + 16, y: land.y - 3.6, z: LAND_Z + 10.2 }, rgb, r: 9, strength: 0.3 });
    }
    for (const lamp of this.streetLamps) {
      const cyan = lamp.job?.k === "prop" && lamp.job.v % 2 === 1;
      add({ a: { x: lamp.x, y: lamp.y - 7.5, z: lamp.z + 24.6 }, rgb: cyan ? NEON.cyan : NEON.pink, r: 26, strength: 0.45, pulse: 0.15, flicker: 0.008 });
    }
    return out;
  }

  private readonly timers: Array<{ at: number; run: () => void }> = [];

  /** Runs `run` after `seconds` of scene time (paused with the scene, unlike setTimeout). */
  private later(seconds: number, run: () => void) {
    this.timers.push({ at: this.time + seconds, run });
  }

  private tick(dt: number) {
    this.time += dt;
    this.revealTick(dt);
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
      const act = e.act;
      const frames = ACT_FRAMES[act];
      const f = frames > 1 ? Math.floor((this.time + agent.phase) / ACT_RATE[act]) % frames : 0;
      e.job = { k: "soldier", look: e.look, act, dir: e.dir, f };
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
    if (this.hub.job?.k === "prop") this.hub.job = { k: "prop", id: "hub", v: this.hubCode * 2 + (Math.floor(this.time / 0.5) % 2) };
    // The archive's racks blink and its monitors scroll; the strategy table's hologram turns; the
    // uplink's chart refreshes.
    const frame = Math.floor(this.time / 0.35) % 4;
    const shrine = this.keyed.get("oracle:shrine");
    if (shrine?.job?.k === "prop") shrine.job = { k: "prop", id: "shrine", v: (this.tvOn ? 4 : 0) + (Math.floor(this.time / 0.3) % 4) };
    const table = this.keyed.get("tent:maptable");
    if (table?.job?.k === "prop") table.job = { k: "prop", id: "maptable", v: frame };
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
    if (!this.posterList.length) return;
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
