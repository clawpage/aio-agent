/**
 * Whether a text is an SVG document: after an optional byte-order mark, XML
 * declaration, comments and doctype, the root element must be <svg>. Used by the
 * control plane before serving a workspace .svg, and by the console before
 * drawing a ```svg block. An SVG is only ever shown as an image (an <img>, served
 * under a sandboxing CSP), so its scripts never run either way; this check keeps
 * other markup from being passed off as a picture.
 */
export function looksLikeSvg(text: string): boolean {
  const head = text.replace(/^﻿/, "").slice(0, 64 * 1024);
  return /^\s*(?:<\?xml[^>]*\?>\s*)?(?:(?:<!--[\s\S]*?-->|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>)\s*)*<svg[\s>/]/i.test(head);
}
