import { useCallback, useMemo, type KeyboardEvent, type MouseEvent } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { isSandboxLink, isWorkspaceFilePath, workspaceFilePathFromHref } from "../sandboxLink";

marked.setOptions({ gfm: true, breaks: true });

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * A dedicated link renderer runs before sanitisation so a workspace file link is
 * emitted as `data-sandbox-file` (with no href) only after the client-side path
 * check passes. The sanitizer then keeps that data attribute but still strips
 * every href that is not http/https — so `mailto:`, relative paths, `/api/...`,
 * `javascript:` and absolute non-workspace paths stay inert, and a Markdown
 * image `src` can never become a host `/home/gem/...` request.
 */
marked.use({
  renderer: {
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
      const filePath = workspaceFilePathFromHref(href);
      if (filePath) {
        // No href: the workspace path must never be navigable. `role`/`tabindex`
        // keep the control focusable so it can be activated from the keyboard.
        return `<a role="button" tabindex="0" data-sandbox-file="${escapeAttr(filePath)}"${titleAttr}>${text}</a>`;
      }
      return `<a href="${escapeAttr(href)}"${titleAttr}>${text}</a>`;
    },
    /**
     * A workspace image reference renders as nothing here: the sanitizer only
     * keeps `https?` srcs, and a bare `<img>` with a stripped src is a broken
     * element. The file card below the message (with its lazy thumbnail) is the
     * real affordance, and it opens the same preview.
     */
    image({ href, title, text }) {
      if (workspaceFilePathFromHref(href)) return "";
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
      return `<img src="${escapeAttr(href)}" alt="${escapeAttr(text)}"${titleAttr}>`;
    },
  },
});

/**
 * Markdown is rendered with `marked`, then sanitised with DOMPurify (the
 * sanitizer is kept: the click handler is only a convenience, never the security
 * boundary). Absolute http/https links are intercepted so they open as a real
 * sandbox Chromium tab through the authenticated API instead of a host browser
 * tab; the server still re-validates scheme and credentials. Workspace file
 * links are intercepted for an in-conversation preview/download and are
 * re-classified client-side on click, so a raw HTML anchor cannot smuggle in an
 * outside path.
 *
 * Every other href (a relative path, a fragment, `mailto:`, another scheme) is
 * never navigable: the sanitizer drops the href, and the click handler makes any
 * remaining anchor inert. The console must not hand a link to a host program
 * (for example the host mail client); such content stays selectable text.
 */
export function Markdown({
  source,
  onOpenLink,
  onOpenFile,
  document = false,
}: {
  source: string;
  document?: boolean;
  onOpenLink?: (url: string) => void;
  onOpenFile?: (path: string) => void;
}) {
  const html = useMemo(() => {
    const rendered = marked.parse(source ?? "", { async: false }) as string;
    const clean = DOMPurify.sanitize(rendered, {
      // Only web URLs survive sanitisation; everything else loses its href.
      ALLOWED_URI_REGEXP: /^(?:https?):/i,
      // `tabindex` is a plain integer, not a URI. Because the URI regexp above is
      // applied to every non-URI-safe attribute, it must be marked URI-safe or
      // DOMPurify would strip `tabindex="0"` and break keyboard focus.
      ADD_URI_SAFE_ATTR: ["tabindex"],
      ADD_ATTR: ["target", "rel", "data-sandbox-file", "role", "tabindex"],
      ...(document ? {
        FORBID_TAGS: ["form", "input", "button", "textarea", "select", "option", "iframe", "object", "embed", "svg", "math", "style"],
        FORBID_ATTR: ["style", "id", "name"],
      } : {}),
    });
    return clean.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ');
  }, [source, document]);

  const onClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const anchor = (event.target as HTMLElement | null)?.closest?.("[data-sandbox-file]") ?? (event.target as HTMLElement | null)?.closest?.("a");
      if (!anchor) return;
      const file = anchor.getAttribute("data-sandbox-file") ?? "";
      // Re-check the path on click: the data attribute could have arrived through
      // raw HTML, not just our renderer, so only a workspace file is opened.
      if (onOpenFile && file && isWorkspaceFilePath(file)) {
        event.preventDefault();
        onOpenFile(file);
        return;
      }
      const href = anchor.getAttribute("href") ?? "";
      if (onOpenLink && isSandboxLink(href)) {
        // Always intercept http/https: even a modified/ctrl-click goes to the
        // sandbox browser rather than the host.
        event.preventDefault();
        onOpenLink(href);
        return;
      }
      // Never let any other href navigate the host page, or trigger a host
      // program such as a mail client.
      event.preventDefault();
    },
    [onOpenFile, onOpenLink],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const anchor = (event.target as HTMLElement | null)?.closest?.("[data-sandbox-file]");
      const file = anchor?.getAttribute("data-sandbox-file") ?? "";
      if (!onOpenFile || !file || !isWorkspaceFilePath(file)) return;
      event.preventDefault();
      onOpenFile(file);
    },
    [onOpenFile],
  );

  // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
  return <div className="markdown" onClick={onClick} onKeyDown={onKeyDown} dangerouslySetInnerHTML={{ __html: html }} />;
}
