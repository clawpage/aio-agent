import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/control/config.js";

/**
 * `PA_MAX_CONCURRENT_TURNS` is clamped to the reviewed 1..3 window so an
 * operator can lower concurrency but can never raise it past the three-turn
 * cap the sandbox was validated against.
 */
function withMaxConcurrentTurns(raw: string | undefined, fn: () => void): void {
  const prev = process.env.PA_MAX_CONCURRENT_TURNS;
  if (raw === undefined) delete process.env.PA_MAX_CONCURRENT_TURNS;
  else process.env.PA_MAX_CONCURRENT_TURNS = raw;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.PA_MAX_CONCURRENT_TURNS;
    else process.env.PA_MAX_CONCURRENT_TURNS = prev;
  }
}

describe("agent.maxConcurrentTurns clamping", () => {
  const cases: Array<{ raw: string | undefined; expected: number; label: string }> = [
    { raw: undefined, expected: 3, label: "defaults to three when unset" },
    { raw: "3", expected: 3, label: "keeps the configured three" },
    { raw: "0", expected: 1, label: "clamps zero up to one" },
    { raw: "99", expected: 3, label: "clamps a too-large value down to three" },
    { raw: "-4", expected: 1, label: "clamps negatives up to one" },
    { raw: "not-a-number", expected: 3, label: "falls back to the default on garbage" },
  ];

  for (const { raw, expected, label } of cases) {
    it(label, () => {
      withMaxConcurrentTurns(raw, () => {
        expect(loadConfig().agent.maxConcurrentTurns).toBe(expected);
      });
    });
  }
});
