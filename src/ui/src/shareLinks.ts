import { marked, type Token, type Tokens } from "marked";

/**
 * Public share pages (`/u/<user>/share/<name>/`, or the short `share?<name>`) a
 * message links to, so the console can show them as cards that copy and share
 * the address instead of only a link that opens in the sandbox browser.
 * Taken from the parsed Markdown like file references: a link (including a GFM
 * autolinked bare URL) counts, text inside code does not.
 */

export interface ShareLink {
  url: string;
  title: string;
}

const SHARE_URL = /^https?:\/\/[^/\s]+\/u\/[A-Za-z0-9_-]{2,40}\/share(?:\/[a-z0-9][a-z0-9-]{0,62}\/?|\?[a-z0-9][a-z0-9-]{0,62})$/;

export function isShareUrl(href: string): boolean {
  return SHARE_URL.test(href);
}

export function extractShareLinks(markdown: string): ShareLink[] {
  if (!markdown) return [];
  let tokens: Token[];
  try {
    tokens = marked.lexer(markdown, { gfm: true, breaks: true });
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const links: ShareLink[] = [];
  marked.walkTokens(tokens, (token) => {
    if (token.type !== "link") return;
    const { href, text } = token as Tokens.Link;
    if (!isShareUrl(href) || seen.has(href)) return;
    seen.add(href);
    const label = text.replace(/[*_`]/g, "").trim();
    links.push({ url: href, title: label && label !== href ? label : "分享页面" });
  });
  return links;
}
