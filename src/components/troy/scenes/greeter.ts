import type { Baker } from "../engine/baker";
import { type Act, ACT_FRAMES, dirFor } from "../engine/jobs";
import type { Point } from "../engine/walker";
import type { Entity, Stage } from "../engine/stage";
import { ENTRANCE, entrancePath, ROOM } from "./layout";

// The greeter: before the crew comes out, one agent steps out of the HQ's street door, stops on the
// pavement and asks the visitor for their preferences (the question is HTML anchored over its
// head, see TroyExperience). Then it walks back in to fetch the others.

/** Who greets you at the door: one of the crew, with a handle like the rest. */
export const GREETER = { name: "Neon", role: "Door crew" };

/** The greeter's look (one of the soldier looks the landing bakes). */
const LOOK = 0;
/** World units per second, a calm walk. */
const SPEED = 30;
/** World units per full stride cycle. */
const STRIDE = 14;
/** Facing the camera (screen down): +x and +y together. */
const FACE_VIEWER = dirFor(1, 1);

const FRONT = ENTRANCE.y + ENTRANCE.depth;
/** In the lit doorway, where it appears and disappears (the building is drawn behind anyone standing in it). */
const INSIDE: Point = { x: 0, y: FRONT - 1.5, z: ROOM.wall };
/** On the threshold. */
const SILL: Point = { x: 0, y: FRONT + 2, z: ROOM.wall };
/**
 * Where it stands to ask: on the light spilling from the door, on the pavement close to the
 * building; its speech bubble (up and to its left) may overlap the building's corner a little,
 * but only the edge of the SURREEL HQ sign.
 */
export const GREET_SPOT: Point = { x: ENTRANCE.x, y: FRONT + 16, z: ROOM.wall };

export class Greeter {
  readonly entity: Entity;
  private out = false;

  constructor(private readonly stage: Stage) {
    // The HQ's building sorts by its doorway (see LandingScene), so the greeter in the doorway or on
    // the pavement is drawn over it without any nudge.
    this.entity = { x: INSIDE.x, y: INSIDE.y, z: INSIDE.z, alpha: 0, shadow: 5, shadowZ: ROOM.wall, priority: 6, job: null, hidden: true };
  }

  /** Bakes the frames it walks and stands in, so the walk never waits on a missing sprite. */
  preload(baker: Baker) {
    const jobs = [];
    for (const dir of [dirFor(0, 1), dirFor(0, -1)]) for (let f = 0; f < ACT_FRAMES.march; f++) jobs.push(baker.request({ k: "soldier", look: LOOK, act: "march", dir, f }, 5));
    jobs.push(baker.request({ k: "soldier", look: LOOK, act: "stand", dir: FACE_VIEWER, f: 0 }, 5));
    return Promise.all(jobs);
  }

  /** Where its head is (for the question's bubble), or null while it is inside. */
  head(): Point | null {
    if (!this.out) return null;
    return { x: this.entity.x, y: this.entity.y, z: this.entity.z + 21 };
  }

  /** Steps out of the door to the pavement and turns to the visitor. `instant` skips the walk. */
  comeOut(done: () => void, instant = false) {
    this.out = true;
    const e = this.entity;
    e.hidden = false;
    this.stage.add(e);
    if (instant) {
      Object.assign(e, { x: GREET_SPOT.x, y: GREET_SPOT.y, z: GREET_SPOT.z, alpha: 1 });
      this.pose("stand", FACE_VIEWER, 0);
      done();
      return;
    }
    Object.assign(e, { x: INSIDE.x, y: INSIDE.y, z: INSIDE.z, alpha: 0 });
    this.walk([SILL, GREET_SPOT], "in", () => {
      this.pose("stand", FACE_VIEWER, 0);
      done();
    });
  }

  /**
   * Leads the crew down to the HQ: from where it stands, across the road and down the stairs the
   * crew takes, fading out at their foot as the crew comes on behind. `instant`: just gone.
   */
  lead(done: () => void = () => undefined, instant = false) {
    if (instant || !this.out) {
      this.hide();
      done();
      return;
    }
    // The crew's way from the door, from where the road starts (the greeter is already outside).
    this.walk(entrancePath().slice(2), "out", () => {
      this.hide();
      done();
    });
  }

  /** Walks back into the doorway and fades into the dark. */
  goIn(done: () => void, instant = false) {
    if (instant || !this.out) {
      this.hide();
      done();
      return;
    }
    this.walk([SILL, INSIDE], "out", () => {
      this.hide();
      done();
    });
  }

  /** Gone (back to the landing, or before the crew marches). */
  hide() {
    this.out = false;
    this.entity.tick = undefined;
    this.entity.hidden = true;
    this.stage.remove(this.entity);
  }

  private pose(act: Act, dir: number, f: number) {
    this.entity.job = { k: "soldier", look: LOOK, act, dir, f };
  }

  /** Walks through `steps`, fading in out of the doorway or out into it. */
  private walk(steps: Point[], fade: "in" | "out", done: () => void) {
    const e = this.entity;
    let leg = 0;
    let travelled = 0;
    let dir = dirFor(steps[0].x - e.x, steps[0].y - e.y);
    e.tick = (dt) => {
      if (fade === "in") e.alpha = Math.min(1, (e.alpha ?? 0) + dt * 4);
      let remaining = SPEED * dt;
      while (remaining > 0 && leg < steps.length) {
        const b = steps[leg];
        const dx = b.x - e.x;
        const dy = b.y - e.y;
        const dz = b.z - e.z;
        if (Math.hypot(dx, dy) > 0.05) dir = dirFor(dx, dy);
        const left = Math.hypot(dx, dy, dz);
        if (left <= remaining) {
          Object.assign(e, { x: b.x, y: b.y, z: b.z });
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
      // Its shadow stays under its feet, down the stairs too.
      e.shadowZ = e.z;
      // Into the dark of the doorway (or the HQ) on the last leg.
      if (fade === "out" && leg >= steps.length - 1) e.alpha = Math.max(0, (e.alpha ?? 1) - dt * 5);
      this.pose("march", dir, Math.floor((travelled / STRIDE) * ACT_FRAMES.march) % ACT_FRAMES.march);
      if (leg >= steps.length) {
        e.tick = undefined;
        done();
      }
    };
  }
}
