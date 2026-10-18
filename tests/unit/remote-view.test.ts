import { expect, it } from "vitest";
import { clampView, fit, fitted, panBy, toRemote, zoomAt } from "../../src/ui/src/remoteView";

// A phone's stage showing the sandbox desktop (1280×1024): fitted to the width, 312 high.
const stage = { width: 390, height: 600 };
const base = fit(stage, { width: 1280, height: 1024 });

it("fits the remote screen whole and centres it", () => {
  expect(base).toEqual({ width: 390, height: 312 });
  expect(fitted(stage, base)).toEqual({ scale: 1, x: 0, y: 144 });
  expect(fit({ width: 0, height: 600 }, { width: 1280, height: 1024 })).toEqual({ width: 0, height: 0 });
});

it("zooms about the fingers and never shows a gap at the edges of a zoomed picture", () => {
  const zoomed = zoomAt(fitted(stage, base), 2, 100, 300, stage, base);
  // The desktop point under (100, 300) stays there; the 624-high picture now overflows and is clamped to the stage.
  expect(zoomed.scale).toBe(2);
  expect(zoomed.x).toBe(-100);
  expect(zoomed.y).toBeLessThanOrEqual(0);
  expect(zoomed.y).toBeGreaterThanOrEqual(600 - 624);
  expect(zoomAt(zoomed, 99, 0, 0, stage, base).scale).toBe(5);
  expect(zoomAt(zoomed, 0.2, 0, 0, stage, base)).toEqual(fitted(stage, base));
  expect(clampView({ scale: 2, x: 50, y: 0 }, stage, base).x).toBe(0);
  expect(clampView({ scale: 2, x: -999, y: 0 }, stage, base).x).toBe(390 - 780);
});

it("lets a drag move the zoomed picture first and hands the rest to the page's scrolling", () => {
  // Fitted: nothing to pan, so all of it scrolls the page.
  expect(panBy(fitted(stage, base), 30, -40, stage, base).rest).toEqual({ x: 30, y: -40 });
  // Zoomed: the picture moves until its edge, then the page scrolls.
  const zoomed = { scale: 2, x: -100, y: -12 };
  const moved = panBy(zoomed, 150, -40, stage, base);
  expect(moved.view.x).toBe(0);
  expect(moved.rest.x).toBe(50);
  expect(moved.view.y).toBe(-24);
  expect(moved.rest.y).toBe(-28);
});

it("maps a stage point to the remote screen, and nothing outside the picture", () => {
  const view = fitted(stage, base);
  expect(toRemote(view, base, 195, 144 + 156)).toEqual({ x: 0.5, y: 0.5 });
  expect(toRemote(view, base, 195, 100)).toBeNull();
  expect(toRemote({ scale: 2, x: -390, y: -12 }, base, 0, 0)).toEqual({ x: 0.5, y: 12 / 624 });
});
