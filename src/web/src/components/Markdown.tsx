import { useCallback, useEffect, useMemo, useRef, type KeyboardEvent, type MouseEvent } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { api } from "../api";
import { isSandboxLink, isWorkspaceFilePath, workspaceFileKind, workspaceFilePathFromHref } from "../sandboxLink";
import { splitMapBlocks } from "../mapBlocks";
import { MapCard } from "./MapCard";

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
     * Images and MP4s in the workspace show where the message put them. They are
     * emitted without a source (the sanitizer only keeps `https?` URIs); after
     * sanitising, the component re-checks each path and loads it through the
     * authenticated document endpoints. Other workspace files render nothing here
     * and appear as file cards below the message.
     */
    image({ href, title, text }) {
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
      const filePath = workspaceFilePathFromHref(href);
      if (filePath) {
        const kind = workspaceFileKind(filePath);
        if (kind === "image") return `<img class="inline-media" data-sandbox-image="${escapeAttr(filePath)}" alt="${escapeAttr(text)}"${titleAttr}>`;
        if (kind === "video") return `<video class="inline-media" data-sandbox-video="${escapeAttr(filePath)}" controls playsinline preload="metadata"${titleAttr}></video>`;
        return "";
      }
      return `<img class="inline-media" src="${escapeAttr(href)}" alt="${escapeAttr(text)}" loading="lazy"${titleAttr}>`;
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
type MarkdownProps = {
  source: string;
  document?: boolean;
  onOpenLink?: (url: string) => void;
  onOpenFile?: (path: string) => void;
};

/** A message: Markdown, with any ```map blocks drawn as map cards where they stand. */
export function Markdown(props: MarkdownProps) {
  const parts = useMemo(() => splitMapBlocks(props.source ?? ""), [props.source]);
  if (parts.length === 1 && parts[0]!.kind === "text") return <MarkdownBlock {...props} source={parts[0]!.text} />;
  return (
    <>
      {parts.map((part, i) => part.kind === "map"
        ? <MapCard key={i} place={part.place} />
        : <MarkdownBlock key={i} {...props} source={part.text} />)}
    </>
  );
}

function MarkdownBlock({
  source,
  onOpenLink,
  onOpenFile,
  document = false,
}: MarkdownProps) {
  const html = useMemo(() => {
    const rendered = marked.parse(source ?? "", { async: false }) as string;
    const clean = DOMPurify.sanitize(rendered, {
      // Only web URLs survive sanitisation; everything else loses its href.
      ALLOWED_URI_REGEXP: /^(?:https?):/i,
      // `tabindex` is a plain integer, not a URI. Because the URI regexp above is
      // applied to every non-URI-safe attribute, it must be marked URI-safe or
      // DOMPurify would strip `tabindex="0"` and break keyboard focus.
      ADD_URI_SAFE_ATTR: ["tabindex"],
      ADD_ATTR: ["target", "rel", "data-sandbox-file", "data-sandbox-image", "data-sandbox-video", "role", "tabindex", "controls", "playsinline", "preload", "loading"],
      ...(document ? {
        FORBID_TAGS: ["form", "input", "button", "textarea", "select", "option", "iframe", "object", "embed", "svg", "math", "style"],
        FORBID_ATTR: ["style", "id", "name"],
      } : {}),
    });
    return clean.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ');
  }, [source, document]);

  // Load inline workspace media once each element is near the viewport.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = root.current;
    if (!container) return;
    const urls: string[] = [];
    const controller = new AbortController();
    const fail = (img: HTMLImageElement) => {
      const note = window.document.createElement("span");
      note.className = "inline-media-failed muted tiny";
      note.textContent = `图片暂时无法显示：${img.alt || img.getAttribute("data-sandbox-image")?.split("/").pop() || ""}`;
      img.replaceWith(note);
    };
    const load = (el: Element) => {
      if (el instanceof HTMLVideoElement) {
        const path = el.getAttribute("data-sandbox-video") ?? "";
        if (isWorkspaceFilePath(path) && workspaceFileKind(path) === "video") el.src = api.documentVideoUrl(path);
        return;
      }
      const img = el as HTMLImageElement;
      const path = img.getAttribute("data-sandbox-image") ?? "";
      if (!isWorkspaceFilePath(path) || workspaceFileKind(path) !== "image") return fail(img);
      void (async () => {
        try {
          const res = await fetch(api.documentImageUrl(path), { credentials: "same-origin", signal: controller.signal });
          // Only an image response may reach the <img>, whatever answered.
          if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("image/")) throw new Error("unavailable");
          const blob = await res.blob();
          if (!blob.size) throw new Error("empty");
          const url = URL.createObjectURL(blob);
          urls.push(url);
          img.src = url;
        } catch (err) {
          if (!(err instanceof DOMException && err.name === "AbortError")) fail(img);
        }
      })();
    };
    const media = [...container.querySelectorAll("img[data-sandbox-image], video[data-sandbox-video]")];
    let observer: IntersectionObserver | null = null;
    if (typeof IntersectionObserver === "function") {
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) if (entry.isIntersecting) { observer!.unobserve(entry.target); load(entry.target); }
      }, { rootMargin: "200px" });
      media.forEach((el) => observer!.observe(el));
    } else media.forEach(load);
    return () => { observer?.disconnect(); controller.abort(); urls.forEach((url) => URL.revokeObjectURL(url)); };
  }, [html]);

  const onClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const image = (event.target as HTMLElement | null)?.closest?.("img[data-sandbox-image]");
      const imagePath = image?.getAttribute("data-sandbox-image") ?? "";
      if (onOpenFile && imagePath && isWorkspaceFilePath(imagePath)) {
        event.preventDefault();
        onOpenFile(imagePath);
        return;
      }
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
  return <div ref={root} className="markdown" onClick={onClick} onKeyDown={onKeyDown} dangerouslySetInnerHTML={{ __html: html }} />;
}
