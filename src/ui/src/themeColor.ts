/**
 * The value of a theme color (theme.css), for the few places that need a
 * concrete color instead of `var(--name)`: a canvas, or a library that paints
 * its own SVG. Read at the moment of drawing, so it follows the current theme.
 */
export function themeColor(name: `--${string}`): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
