/**
 * Link classification for the chat Markdown view.
 *
 * Two kinds of href are meaningful:
 *
 *  - An absolute http/https URL is the only kind of link the console hands to
 *    the sandbox browser.
 *  - An absolute path inside the sandbox workspace (`/home/gem/workspace/...`)
 *    is a file the agent produced; it is previewed (raster images) or downloaded
 *    through the authenticated control-plane API.
 *
 * Everything else (a relative path, a fragment, a protocol-relative `//host`, an
 * empty href, `mailto:`, `javascript:`, `data:`, `file:`, or an absolute path
 * outside the workspace) is never navigable. Those hrefs must never be resolved
 * against the control-plane origin and then opened as if they were real web
 * links. Path classification is only a client-side convenience; the download
 * endpoint re-validates every path server-side.
 */

/** Fixed workspace root inside the AIO sandbox (matches `sandbox.containerWorkspaceDir`). */
export const SANDBOX_WORKSPACE_ROOT = "/home/gem/workspace";

/** Image extensions that may be shown in the in-conversation lightbox. */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "avif"]);

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

/**
 * True for an already-decoded absolute path inside the sandbox workspace.
 *
 * Rejects protocol-relative paths, control characters, backslashes and any `..`
 * segment, so a crafted href can never point at `/etc/...` or escape the
 * workspace through traversal.
 */
export function isWorkspaceFilePath(path: string): boolean {
  if (!path || !path.startsWith("/")) return false;
  if (path.startsWith("//")) return false;
  if (path.includes("\u0000") || path.includes("\n") || path.includes("\r") || path.includes("\\")) return false;
  if (path !== SANDBOX_WORKSPACE_ROOT && !path.startsWith(`${SANDBOX_WORKSPACE_ROOT}/`)) return false;
  for (const segment of path.split("/")) {
    if (segment === "..") return false;
  }
  return true;
}

/**
 * Turn a Markdown href into an absolute sandbox workspace file path, or null.
 *
 * Marked percent-encodes non-ASCII characters, so decode first; a malformed
 * escape or anything that fails workspace validation returns null.
 */
export function workspaceFilePathFromHref(href: string): string | null {
  if (!href || !href.startsWith("/") || href.startsWith("//")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    return null;
  }
  return isWorkspaceFilePath(decoded) ? decoded : null;
}

/** Classify a workspace file path for the UI: raster image preview vs download. */
export function workspaceFileKind(path: string): "image" | "file" {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return IMAGE_EXTENSIONS.has(ext) ? "image" : "file";
}
