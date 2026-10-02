/** Agent HTML runs only in an opaque origin, including direct navigation. */
export const HTML_PREVIEW_CSP = [
  "sandbox allow-scripts", "default-src 'none'", "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'", "img-src data: blob:", "font-src data:",
  "connect-src 'none'", "frame-src 'none'", "object-src 'none'",
  "base-uri 'none'", "form-action 'none'",
].join("; ");

export function htmlPreviewDocument(text: string): string {
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' + text;
}
