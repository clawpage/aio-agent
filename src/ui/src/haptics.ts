/**
 * A touch the iOS app plays (`aioHaptic`, DeviceBrowser.swift): "tap" for a main button, "start" when the
 * microphone opens, and the outcome of something important. Nothing anywhere else.
 */
export type Haptic = "tap" | "start" | "success" | "warning" | "error";

export function haptic(kind: Haptic): void {
  (window as { webkit?: { messageHandlers?: { aioHaptic?: { postMessage(body: string): void } } } }).webkit?.messageHandlers?.aioHaptic?.postMessage(kind);
}
