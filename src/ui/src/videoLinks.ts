import { marked, type Token, type Tokens } from "marked";

/**
 * YouTube and Bilibili videos a message links to, so the console can play them in
 * place. Taken from the parsed Markdown like share links: a link (including a GFM
 * autolinked bare URL) counts, text inside code does not. The player address is
 * rebuilt from the video's id on the provider's own embed host, never taken from
 * the link, so a link can only ever name a video.
 */

export interface VideoLink {
  /** Provider and video (and part), unique within a message. */
  key: string;
  provider: "youtube" | "bilibili";
  /** The link as written. */
  url: string;
  /** The link's text when it says more than the address. */
  title: string | null;
  /** The player to frame. */
  embed: string;
}

/** At most this many players per message. */
export const MAX_VIDEOS = 4;

/**
 * Embed hosts the console frames (its CSP admits exactly these). On a phone the
 * Bilibili player redirects to its mobile player on www.bilibili.com, which the
 * frame must also be allowed to load.
 */
export const VIDEO_EMBED_ORIGINS = ["https://www.youtube-nocookie.com", "https://player.bilibili.com", "https://www.bilibili.com"];

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const BILIBILI_ID = /^(?:(BV[0-9A-Za-z]{10})|av([1-9][0-9]{0,15}))$/i;

/** A start time as YouTube and Bilibili write it: `90`, `90s`, `1m30s`, `1h2m3s`. */
function seconds(value: string | null): number | null {
  if (!value) return null;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(value.trim());
  if (!m || !value.trim()) return null;
  const total = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return total > 0 && total < 360_000 ? total : null;
}

/** The video a web address points at, or null when it is not a single YouTube or Bilibili video. */
export function parseVideoUrl(href: string): Omit<VideoLink, "title"> | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/^(?:www|m)\./, "");
  const path = url.pathname.split("/").filter(Boolean);

  if (host === "youtube.com" || host === "youtu.be") {
    let id: string | null = null;
    if (host === "youtu.be") id = path[0] ?? null;
    else if (path[0] === "watch") id = url.searchParams.get("v");
    else if (["shorts", "embed", "live", "v"].includes(path[0] ?? "")) id = path[1] ?? null;
    if (!id || !YOUTUBE_ID.test(id)) return null;
    const start = seconds(url.searchParams.get("t") ?? url.searchParams.get("start"));
    return {
      key: `youtube:${id}`,
      provider: "youtube",
      url: href,
      embed: `https://www.youtube-nocookie.com/embed/${id}?rel=0&playsinline=1${start ? `&start=${start}` : ""}`,
    };
  }

  if (host === "bilibili.com" && path[0] === "video" && path[1]) {
    const m = BILIBILI_ID.exec(path[1]);
    if (!m) return null;
    const bvid = m[1] ? `BV${m[1].slice(2)}` : null;
    const page = Math.min(Math.max(Number.parseInt(url.searchParams.get("p") ?? "1", 10) || 1, 1), 999);
    const start = seconds(url.searchParams.get("t"));
    const id = bvid ? `bvid=${bvid}` : `aid=${m[2]}`;
    return {
      key: `bilibili:${bvid ?? `av${m[2]}`}:${page}`,
      provider: "bilibili",
      url: href,
      embed: `https://player.bilibili.com/player.html?${id}&page=${page}&autoplay=0&high_quality=1${start ? `&t=${start}` : ""}`,
    };
  }
  return null;
}

export function extractVideoLinks(markdown: string): VideoLink[] {
  if (!markdown) return [];
  let tokens: Token[];
  try {
    tokens = marked.lexer(markdown, { gfm: true, breaks: true });
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const videos: VideoLink[] = [];
  marked.walkTokens(tokens, (token) => {
    if (token.type !== "link" || videos.length >= MAX_VIDEOS) return;
    const { href, text } = token as Tokens.Link;
    const video = parseVideoUrl(href);
    if (!video || seen.has(video.key)) return;
    seen.add(video.key);
    const label = text.replace(/[*_`]/g, "").trim();
    videos.push({ ...video, title: label && label !== href ? label : null });
  });
  return videos;
}
