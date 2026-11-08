/** Agent HTML runs only in an opaque origin, including direct navigation. */
export const HTML_PREVIEW_CSP = [
  "sandbox allow-scripts", "default-src 'none'", "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'", "img-src data: blob:", "font-src data:",
  "connect-src 'none'", "frame-src 'none'", "object-src 'none'",
  "base-uri 'none'", "form-action 'none'",
].join("; ");

/** Written before the page's own bytes: UTF-8 and a phone-sized viewport. */
export const HTML_PREVIEW_PREFIX = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">';

/**
 * The largest page the preview streams to the person's own browser. Pages with their
 * pictures inlined run to megabytes, and loading one here takes a moment, where the
 * sandbox's browser had to wake and render it first.
 */
export const HTML_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;

export function htmlPreviewDocument(text: string): string {
  return HTML_PREVIEW_PREFIX + text;
}
