import type { Baker } from "../engine/baker";
import { type Act, ACT_FRAMES, dirFor } from "../engine/jobs";
import type { Point } from "../engine/walker";
import type { CameraTarget, Entity, Stage } from "../engine/stage";
import { projectX, projectY } from "../engine/tracer";
import { ENTRANCE, ROOM } from "./layout";

// The greeter: before the crew comes out, one agent steps out of the HQ's street door, stops on the
// pavement and asks the visitor for their preferences (the question is HTML anchored over its
// head, see TroyExperience). Then it walks back in to fetch the others.

/** The greeter's look (one of the soldier looks the landing bakes). */
const LOOK = 0;
/** World units per second, a calm walk. */
const SPEED = 30;
/** World units per full stride cycle. */
const STRIDE = 14;
/** Facing the camera (screen down): +x and +y together. */
const FACE_VIEWER = dirFor(1, 1);

const FRONT = ENTRANCE.y + ENTRANCE.depth;
/** Just inside the dark doorway, where it appears and disappears. */
const INSIDE: Point = { x: 0, y: FRONT - 5, z: ROOM.wall };
/** On the threshold. */
const SILL: Point = { x: 0, y: FRONT + 1, z: ROOM.wall };
/** Where it stands to ask, on the pavement in front of the door. */
export const GREET_SPOT: Point = { x: 0, y: FRONT + 14, z: ROOM.wall };

/**
 * The close-up while the greeter asks: the door and the greeter in the lower half of the screen,
 * the question's bubble (about `bubble` CSS px tall) above its head.
 */
export function greetCamera(stage: Stage, bubble = 230): CameraTarget {
  const { width, height } = stage.size;
  // About 70 art px around the greeter (the door, the pavement), and room for the bubble above.
  const zoom = stage.fitZoom(Math.min((height - bubble - 60) / 70, (width - 32) / 120, 6));
  const sx = projectX(GREET_SPOT.x, GREET_SPOT.y);
  const sy = projectY(GREET_SPOT.x, GREET_SPOT.y, GREET_SPOT.z);
  // The greeter's feet sit a little below the middle, so the bubble fits above.
  return { x: sx, y: sy - (bubble / 2 - 40) / zoom, zoom };
}

export class Greeter {
  readonly entity: Entity;
  private out = false;

  constructor(private readonly stage: Stage) {
    // `sort`: the HQ's building is one sprite at the origin; without the nudge the greeter, a few
    // units in front of its door (y < 0), would sort behind it and vanish.
    this.entity = { x: INSIDE.x, y: INSIDE.y, z: INSIDE.z, sort: 60, alpha: 0, shadow: 5, priority: 6, job: null, hidden: true };
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
      // Into the dark of the doorway on the last leg.
      if (fade === "out" && leg >= steps.length - 1) e.alpha = Math.max(0, (e.alpha ?? 1) - dt * 5);
      this.pose("march", dir, Math.floor((travelled / STRIDE) * ACT_FRAMES.march) % ACT_FRAMES.march);
      if (leg >= steps.length) {
        e.tick = undefined;
        done();
      }
    };
  }
}
