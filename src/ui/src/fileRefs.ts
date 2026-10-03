import { marked, type Token, type Tokens } from "marked";
import {
  isWorkspaceFilePath,
  workspaceFileKind,
  workspaceFilePathFromHref,
  type WorkspaceFileKind,
} from "./sandboxLink";

/**
 * Workspace files referenced by one agent message.
 *
 * The references are taken from the *parsed Markdown*, using the same `marked`
 * lexer the message body is rendered with. That matters for correctness: a
 * hand-written regex both truncates legitimate file names (a `)` or a space in
 * the name) and invents references from text that is not a link at all - a code
 * fence or inline code that merely mentions a path. Walking the real token tree
 * means a card appears exactly when the rendered message shows a link or image.
 *
 * A bare path in prose is deliberately NOT turned into a card: the agent may
 * mention a path that does not exist yet, and a card implies a real file.
 *
 * The classification here is a UI convenience only. Every path is re-validated on
 * the server (lexically *and* with `realpath` inside the container) before any
 * bytes are read, so a crafted Markdown path cannot reach outside the workspace.
 */

export interface FileRef {
  path: string;
  name: string;
  kind: WorkspaceFileKind;
  title?: string;
  /** True when the reference came from an `![]()` image reference. */
  image: boolean;
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

/**
 * Collect the workspace files a message points at, in first-appearance order and
 * deduplicated by path (the same file linked twice is one card).
 *
 * Code fences and inline code contribute nothing: their content is a single
 * literal string, not link tokens, so walking the token tree never sees a link
 * inside them.
 */
export function extractFileRefs(markdown: string): FileRef[] {
  if (!markdown) return [];
  const seen = new Set<string>();
  const refs: FileRef[] = [];
  const push = (href: string, image: boolean, label: string): void => {
    // Marked percent-encodes non-ASCII characters in an href, so decode first;
    // anything that fails workspace validation is skipped, never rewritten.
    const path = workspaceFilePathFromHref(href);
    if (!path || seen.has(path)) return;
    seen.add(path);
    const title = label.replace(/[*_`]/g, "").trim();
    refs.push({ path, name: nameOf(path), kind: workspaceFileKind(path), image,
      ...(!image && title && title !== nameOf(path) && !/^(?:下载|下载文件|下载图片|点击下载|查看|打开|download)$/i.test(title) ? { title } : {}),
    });
  };

  let tokens: Token[];
  try {
    tokens = marked.lexer(markdown, { gfm: true, breaks: true });
  } catch {
    // Malformed Markdown must never break the message list; the plain body is
    // still rendered, just without cards.
    return [];
  }

  marked.walkTokens(tokens, (token) => {
    if (token.type === "link") {
      push((token as Tokens.Link).href, false, (token as Tokens.Link).text);
    } else if (token.type === "image") {
      push((token as Tokens.Image).href, true, (token as Tokens.Image).text);
    }
  });
  return refs;
}

/**
 * Attachments recorded on a user turn, as cards. Older turns only stored a path;
 * the name and kind are derived then, so history still renders cards.
 *
 * `attachment.path` is a *raw* filesystem path, not an href, so it is validated
 * as-is: percent-decoding it would corrupt a real file name containing `%` and
 * silently drop that card.
 */
export function attachmentRefs(
  attachments: ReadonlyArray<{ path?: string; name?: string; kind?: string }>,
): FileRef[] {
  const seen = new Set<string>();
  const refs: FileRef[] = [];
  for (const attachment of attachments) {
    const path = typeof attachment.path === "string" ? attachment.path : "";
    // Only an absolute workspace path is trusted; anything else is skipped
    // rather than rewritten into a path this sandbox may not own.
    if (!isWorkspaceFilePath(path) || seen.has(path)) continue;
    seen.add(path);
    const kind = workspaceFileKind(path);
    refs.push({
      path,
      name: attachment.name || nameOf(path),
      kind,
      image: kind === "image",
    });
  }
  return refs;
}

const MEDIA_LINE = /^(\s*(?:[-*+]\s+|\d+[.)]\s+)?)\[([^\]\n]+)\]\((<[^>\n]+>|[^)\s]+)\)\s*$/;

/**
 * A link to an audio or video file on a line of its own ("[新生儿啼哭（23秒）](/…/cry.mp3)")
 * is shown as that media, in place, like `![…](…)`: the agent puts it where it belongs
 * in the message, and it should not read as a bare link with the same file again as a
 * card at the bottom. A link inside a sentence stays a link (and keeps its card).
 * Code fences are left alone.
 */
export function embedMediaLinks(markdown: string): string {
  if (!markdown || !/\.(?:mp4|m4v|mov|webm|mp3|m4a|aac|wav|ogg|oga|opus|flac)\b/i.test(markdown)) return markdown;
  let fence: string | null = null;
  return markdown.split("\n").map((line) => {
    const opener = /^\s*(`{3,}|~{3,})/.exec(line);
    if (opener) {
      if (fence === null) fence = opener[1]![0]!;
      else if (opener[1]![0] === fence) fence = null;
      return line;
    }
    if (fence !== null) return line;
    const m = MEDIA_LINE.exec(line);
    if (!m) return line;
    const href = m[3]!.replace(/^<|>$/g, "");
    const path = workspaceFilePathFromHref(href.includes(" ") ? encodeURI(href) : href);
    if (!path) return line;
    const kind = workspaceFileKind(path);
    return kind === "audio" || kind === "video" ? `${m[1]}![${m[2]}](${m[3]})` : line;
  }).join("\n");
}
