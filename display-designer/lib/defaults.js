import { generate, GENERATORS } from "./anim.js";
import { bandHeights, computeSlots, DEFAULT_LOCATION } from "./render.js";

export function emptySide() {
  return {
    top: { count: 2, height: 46 },
    bottom: { count: 2, height: 46 },
    slots: {},
  };
}

// Frames for an animation slot of the given size.
export function makeAnim(name, w, h) {
  const g = GENERATORS[name];
  return {
    type: "anim",
    generator: name,
    frames: generate(name, w, h, g.frames),
    period: Math.round(1000 / Math.min(g.fps, 2)),
  };
}

export function defaultDesign() {
  const central = emptySide();
  central.slots = {
    T1: { type: "battery", source: "self", style: 0 },
    T2: { type: "battery", source: "peer", style: 0 },
    C: { type: "layer", style: 2 },
    B1: { type: "profile" },
    B2: { type: "connection", style: 1 },
  };

  const peripheral = emptySide();
  peripheral.bottom = { count: 0, height: 0 };
  peripheral.slots = {
    T1: { type: "battery", source: "self", style: 0 },
    T2: { type: "connection", style: 1 },
  };
  const c = computeSlots(peripheral).find((s) => s.id === "C");
  peripheral.slots.C = makeAnim("radar", c.w, c.h);

  return {
    version: 1,
    invert: false,
    location: { ...DEFAULT_LOCATION },
    sides: { central, peripheral },
  };
}

export { bandHeights };
