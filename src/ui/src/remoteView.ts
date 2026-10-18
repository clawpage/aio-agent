/**
 * The zoom and pan of a remote screen's picture (the sandbox desktop, a page of
 * the AI's Chrome) inside the stage that shows it. At scale 1 the picture is
 * fitted whole in the stage and centred; zoomed in, it is panned within it. A
 * view is the picture's scale over that fit and the offset of its top-left
 * corner in the stage, in screen pixels.
 */
export interface View {
  scale: number;
  x: number;
  y: number;
}
export interface Size {
  width: number;
  height: number;
}

export const MIN_SCALE = 1;
export const MAX_SCALE = 5;
/** A double tap zooms a fitted picture this far in (and a zoomed one back out). */
export const TAP_ZOOM = 2.5;

/** The picture fitted whole in the stage, at the remote screen's aspect. */
export function fit(stage: Size, remote: Size): Size {
  if (stage.width <= 0 || stage.height <= 0 || remote.width <= 0 || remote.height <= 0) return { width: 0, height: 0 };
  const ratio = Math.min(stage.width / remote.width, stage.height / remote.height);
  return { width: remote.width * ratio, height: remote.height * ratio };
}

/** One axis: a picture smaller than the stage is centred, a larger one never shows a gap at its edges. */
function bound(offset: number, picture: number, stage: number): number {
  if (picture <= stage) return (stage - picture) / 2;
  return Math.min(0, Math.max(stage - picture, offset));
}

/** The view kept within the stage (scale limited, no gap at the edges of a zoomed picture). */
export function clampView(view: View, stage: Size, base: Size): View {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale));
  return { scale, x: bound(view.x, base.width * scale, stage.width), y: bound(view.y, base.height * scale, stage.height) };
}

/** The fitted view. */
export function fitted(stage: Size, base: Size): View {
  return clampView({ scale: 1, x: 0, y: 0 }, stage, base);
}

/** Zoomed to `scale`, keeping the picture point under (px, py) — stage pixels — where it is. */
export function zoomAt(view: View, scale: number, px: number, py: number, stage: Size, base: Size): View {
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
  const ratio = next / view.scale;
  return clampView({ scale: next, x: px - (px - view.x) * ratio, y: py - (py - view.y) * ratio }, stage, base);
}

/**
 * A one-finger drag moves the zoomed picture first; what it cannot move (the
 * picture's edge reached, or the picture not zoomed that way) scrolls the
 * remote page, the way a pinch-zoomed page scrolls in a phone's browser.
 * Returns the new view and the leftover, in stage pixels.
 */
export function panBy(view: View, dx: number, dy: number, stage: Size, base: Size): { view: View; rest: { x: number; y: number } } {
  const next = clampView({ ...view, x: view.x + dx, y: view.y + dy }, stage, base);
  return { view: next, rest: { x: dx - (next.x - view.x), y: dy - (next.y - view.y) } };
}

/** Where a stage point falls on the remote screen, as fractions of it (outside the picture: null). */
export function toRemote(view: View, base: Size, px: number, py: number): { x: number; y: number } | null {
  const width = base.width * view.scale, height = base.height * view.scale;
  if (width <= 0 || height <= 0) return null;
  const x = (px - view.x) / width, y = (py - view.y) / height;
  return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
}
