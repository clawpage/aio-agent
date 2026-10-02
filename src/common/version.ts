/**
 * The compatibility contract between the three layers. Each layer is built,
 * versioned and deployed on its own; these numbers decide which combinations
 * work together. Every image carries them as labels (checked before `compose up`)
 * and every layer checks them again at runtime, so a mismatch is refused instead
 * of half-working.
 *
 * Bump a number only for an incompatible change, and widen the matching range
 * when the newer side still understands the older one.
 */

/** The control plane's HTTP API version the UI is written against. */
export const API_VERSION = 1;
/** The oldest UI API version this control plane still serves. */
export const API_MIN = 1;

/** The control-plane-to-sandboxd protocol a sandbox node speaks. */
export const SANDBOX_PROTOCOL = 1;
/** The sandbox protocols this control plane can drive. */
export const SANDBOX_PROTOCOL_MIN = 1;
export const SANDBOX_PROTOCOL_MAX = 1;

/** Whether a UI built for `required` works with a control plane serving `api` (down to `min`). */
export function apiCompatible(required: number, api: number, min: number): boolean {
  return Number.isInteger(required) && required >= min && required <= api;
}

/** Whether a control plane driving `[min, max]` can use a node speaking `protocol`. */
export function sandboxCompatible(protocol: number, min: number, max: number): boolean {
  return Number.isInteger(protocol) && protocol >= min && protocol <= max;
}
