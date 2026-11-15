import { beforeAll, describe, expect, it } from "vitest";
import type { Baker } from "@/components/troy/engine/baker";
import type { Entity, Stage as StageType } from "@/components/troy/engine/stage";

// Every station's crew is at its post while the station works: the demo campaign is replayed
// from the first research run to the last post, and nobody a working station needs may be missing
// for more than the walk over.

type Fake = Record<string, unknown>;

function fakeContext(): Fake {
  const noop = () => undefined;
  return new Proxy(
    { createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }), createPattern: () => null },
    { get: (target, key) => (key in target ? target[key as keyof typeof target] : noop) },
  );
}

function fakeCanvas(): Fake {
  return { width: 0, height: 0, getContext: () => fakeContext(), getBoundingClientRect: () => ({ width: 1440, height: 900 }) };
}

let Stage: typeof StageType;
let CampScene: typeof import("@/components/troy/scenes/camp").CampScene;
let LandingScene: typeof import("@/components/troy/scenes/landing").LandingScene;
let derive: typeof import("@/components/troy/scenes/derive").derive;
let demo: typeof import("@/components/troy/camp/demo");
let SAMPLE: typeof import("@/components/troy/camp/sample").SAMPLE;
let STATION: typeof import("@/components/troy/scenes/layout").STATION;

beforeAll(async () => {
  (globalThis as Fake).document = { createElement: () => fakeCanvas() };
  // Posters load as images; here they never arrive.
  (globalThis as Fake).Image = class {
    src = "";
  };
  ({ Stage } = await import("@/components/troy/engine/stage"));
  ({ CampScene } = await import("@/components/troy/scenes/camp"));
  ({ LandingScene } = await import("@/components/troy/scenes/landing"));
  ({ derive } = await import("@/components/troy/scenes/derive"));
  demo = await import("@/components/troy/camp/demo");
  ({ SAMPLE } = await import("@/components/troy/camp/sample"));
  ({ STATION } = await import("@/components/troy/scenes/layout"));
});

const baker = { request: () => new Promise(() => undefined), get: () => undefined, has: () => false } as unknown as Baker;

type AgentState = { plan: { id: string; station: keyof typeof STATION; x: number; y: number; z: number; state: string; army?: unknown; away?: boolean }; entity: Entity; where: string };

/** The agents a station needs at their posts while it works: everyone posted there who is working, but not scouts out on the street or the courier. */
const needed = (a: AgentState) => a.plan.state === "working" && !a.plan.army && !a.plan.away && !a.plan.id.startsWith("scout") && a.plan.id !== "courier";

describe("the crew", () => {
  it("is at its post whenever its station is at work, all through the demo campaign", () => {
    const stage = new Stage(fakeCanvas() as unknown as HTMLCanvasElement, baker);
    const landing = new LandingScene(stage, {});
    const camp = new CampScene(stage, landing);
    landing.recruit = () => camp.nextRecruit();
    camp.prepare("brd_demo");
    camp.beginEntrance();
    landing.openNow();
    camp.show(true);
    const step = (stage as unknown as { step(dt: number): void }).step.bind(stage);
    const agents = (camp as unknown as { agents: Map<string, AgentState> }).agents;
    const atPost = (a: AgentState) => {
      const s = STATION[a.plan.station];
      const e = a.entity;
      return stage.has(e) && Math.hypot(e.x - (s.x + a.plan.x), e.y - (s.y + a.plan.y)) < 1 && Math.abs(e.z - s.z - a.plan.z) < 1;
    };
    let state = demo.freshState(Date.UTC(2026, 10, 9, 10, 0, 0));
    const missing = new Map<string, number>();
    const worst = new Map<string, number>();
    const end = demo.timeline(SAMPLE).review + 60;
    for (let t = 0; t < end; t += 0.5) {
      state = demo.advance(SAMPLE, state, 0.5, true);
      camp.apply(derive(demo.replay(SAMPLE, state)));
      for (let k = 0; k < 15; k++) step(1 / 30);
      for (const a of agents.values()) {
        const key = a.plan.id;
        if (!needed(a) || atPost(a)) {
          missing.delete(key);
          continue;
        }
        const since = (missing.get(key) ?? 0) + 0.5;
        missing.set(key, since);
        worst.set(key, Math.max(worst.get(key) ?? 0, since));
      }
    }
    // The longest walk on to a post (down from the street, across both floors) takes about 25 s.
    const late = [...worst].filter(([, s]) => s > 25);
    expect(late, late.map(([id, s]) => `${id} away from its post ${s}s while needed`).join("; ")).toEqual([]);
  }, 120_000);
});
