/**
 * True only for an absolute http/https URL — the only kind of link the console
 * hands to the sandbox browser.
 *
 * Anything else (a relative path, a fragment, a protocol-relative `//host`, an
 * empty href, `mailto:`, `javascript:`, `data:`, `file:`) returns false. Those
 * hrefs must never be resolved against the control-plane origin and then opened
 * as if they were real web links.
 */
export function isSandboxLink(href: string): boolean {
  if (!href) return false;
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    // A bare/relative reference (e.g. `/foo`, `foo/bar`, `#frag`) has no base
    // here on purpose, so it cannot silently become the current page's origin.
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}
