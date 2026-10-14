import { describe, expect, it } from "vitest";
import { ATTENTION_MS, Attention } from "../../src/ui/src/attention.js";

function setup() {
  const world = { now: 0, visible: true, timers: new Map<number, { at: number; fn: () => void }>(), next: 1 };
  const tracker = new Attention({
    now: () => world.now,
    visible: () => world.visible,
    setTimeout: (fn, ms) => { const id = world.next++; world.timers.set(id, { at: world.now + ms, fn }); return id; },
    clearTimeout: (id) => void world.timers.delete(id as number),
  });
  const advance = (ms: number) => {
    const target = world.now + ms;
    for (;;) {
      const due = [...world.timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      world.timers.delete(due[0]);
      world.now = due[1].at;
      due[1].fn();
    }
    world.now = target;
  };
  return { world, tracker, advance };
}

describe("console attention", () => {
  it("a visible console nobody touches stops counting after the window, and a touch brings it back", () => {
    const { tracker, advance } = setup();
    const seen: boolean[] = [];
    tracker.subscribe((on) => seen.push(on));
    expect(tracker.attended).toBe(true);
    advance(ATTENTION_MS - 1000);
    tracker.mark();
    advance(ATTENTION_MS - 1000);
    expect(tracker.attended).toBe(true);
    advance(2000);
    expect(tracker.attended).toBe(false);
    tracker.mark();
    expect(tracker.attended).toBe(true);
    expect(seen).toEqual([false, true]);
  });

  it("a hidden console is never attended, whatever happened just before", () => {
    const { world, tracker } = setup();
    world.visible = false;
    tracker.update();
    expect(tracker.attended).toBe(false);
    tracker.mark();
    expect(tracker.attended).toBe(false);
    world.visible = true;
    tracker.mark();
    expect(tracker.attended).toBe(true);
  });
});
