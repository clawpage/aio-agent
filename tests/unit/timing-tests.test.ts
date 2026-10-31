import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Tests run on a shared CI machine that can stall for hundreds of milliseconds,
 * so a test must not hinge on how fast the real clock moves. A correct build once
 * failed CI because a 0.5 s budget was checked against a 0.7 s wall-clock bound
 * and the runner took 0.82 s.
 *
 * - Python tests check deadlines on FakeClock (browser-runtime.test.py): sleeping
 *   only moves that clock, so the bound is exact. Real elapsed-time checks and
 *   threading.Timer are refused.
 * - A TypeScript test may still bound real elapsed time to tell "answers soon"
 *   from "hangs", but never tighter than a second; for anything finer, make the
 *   fixture wait on the test (a release function) instead of a timer.
 */
const TESTS = path.resolve(import.meta.dirname, "..");
const MIN_REAL_BOUND_MS = 1000;

function files(dir: string, ext: RegExp): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : files(full, ext);
    return ext.test(e.name) ? [full] : [];
  });
}

const where = (file: string, text: string, index: number) => `${path.relative(TESTS, file)}:${text.slice(0, index).split("\n").length}`;

it("checks Python deadlines on a fake clock, never the real one", () => {
  const problems: string[] = [];
  for (const file of files(TESTS, /\.py$/)) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/monotonic\(\)\s*-\s*[A-Za-z_]|\btime\.time\(\)\s*-|threading\.Timer\(/g)) problems.push(`${where(file, text, m.index!)}: ${m[0]}`);
  }
  expect(problems, "use fake_clock(): clock.now for elapsed time, clock.after() instead of threading.Timer").toEqual([]);
});

it("bounds real elapsed time in TypeScript tests no tighter than a second", () => {
  const problems: string[] = [];
  for (const file of files(TESTS, /\.(ts|tsx|mjs)$/)) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/(?:Date|performance)\.now\(\)\s*-\s*[\w.]+\)\s*\.toBeLessThan(?:OrEqual)?\(\s*([\d_]+)/g)) {
      if (Number(m[1]!.replace(/_/g, "")) < MIN_REAL_BOUND_MS) problems.push(`${where(file, text, m.index!)}: ${m[0]}`);
    }
  }
  expect(problems, `a real-clock bound under ${MIN_REAL_BOUND_MS} ms fails on a busy CI runner; let the fixture wait on the test instead`).toEqual([]);
});
