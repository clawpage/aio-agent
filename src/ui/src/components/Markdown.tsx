import { useCallback, useEffect, useMemo, useRef, type KeyboardEvent, type MouseEvent } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { api } from "../api";
import { cachedImage, holdImage } from "../imageCache";
import { isWebLink, isSandboxLink, isWorkspaceFilePath, workspaceFileKind, workspaceFilePathFromHref } from "../sandboxLink";
import { openNativeBrowser } from "../deviceBrowser";
import { embedMediaLinks } from "../fileRefs";
import { splitMapBlocks, type MessagePart } from "../mapBlocks";
import { splitSvgBlocks, type SvgPart } from "../svgBlocks";
import { splitMermaidBlocks, type MermaidPart } from "../mermaidBlocks";
import { splitAskBlocks, splitChoiceBlocks, splitFormBlocks, type AskPart, type ChoicePart, type FormPart } from "../choices";
import { FormCard } from "./FormCard";
import { splitProductBlocks, type ProductPart } from "../productBlocks";
import { cjkStrong } from "../markdownStrong";
import { MapCard } from "./MapCard";
import { SvgCard } from "./SvgCard";
import { MermaidCard } from "./MermaidCard";
import { ChoiceList } from "./ChoiceList";
import { ProductCards } from "./ProductCards";

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
  extensions: [cjkStrong],
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
     * Images, videos and audio in the workspace show where the message put them. They are
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
        // Audio and video are a small card: what it is (tap to open the preview, which also downloads) and the player.
        if (kind === "video" || kind === "audio") {
          const label = escapeAttr(text || filePath.slice(filePath.lastIndexOf("/") + 1));
          const caption = `<figcaption><span class="media-card-icon" aria-hidden="true">${kind === "video" ? "▶" : "♪"}</span><a role="button" tabindex="0" data-sandbox-file="${escapeAttr(filePath)}">${label}</a></figcaption>`;
          const player = kind === "video"
            ? `<video class="inline-media" data-sandbox-video="${escapeAttr(filePath)}" controls playsinline preload="metadata"${titleAttr}></video>`
            : `<audio class="inline-audio" data-sandbox-audio="${escapeAttr(filePath)}" controls preload="metadata" title="${escapeAttr(text)}"></audio>`;
          return `<figure class="media-card" data-kind="${kind}">${caption}${player}</figure>`;
        }
        return "";
      }
      // A web picture never loads from its host (the CSP admits only this origin):
      // the component fetches it through the account's sandbox. Only https.
      if (!/^https:\/\//i.test(href)) return "";
      return `<img class="inline-media" data-web-image="${escapeAttr(href)}" alt="${escapeAttr(text)}"${titleAttr}>`;
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
  /** Where a ```choices answer goes when tapped; without it the answers are only shown. */
  choices?: { onChoose: (option: string) => void; chosen: string | null; disabled?: boolean };
};

/**
 * A message: Markdown, with ```map blocks drawn as map cards, ```svg blocks as
 * pictures, ```mermaid blocks as diagrams, ```products blocks as product cards, ```choices blocks as answers
 * to tap and ```form blocks as forms to fill in, where they stand.
 */
export function Markdown(props: MarkdownProps) {
  const parts = useMemo(
    () => splitMapBlocks(props.source ?? "")
      .flatMap<MessagePart | SvgPart>((part) => (part.kind === "text" ? splitSvgBlocks(part.text) : [part]))
      .flatMap<MessagePart | SvgPart | MermaidPart>((part) => (part.kind === "text" ? splitMermaidBlocks(part.text) : [part]))
      .flatMap<MessagePart | SvgPart | MermaidPart | ChoicePart>((part) => (part.kind === "text" ? splitChoiceBlocks(part.text) : [part]))
      .flatMap<MessagePart | SvgPart | MermaidPart | ChoicePart | ProductPart>((part) => (part.kind === "text" ? splitProductBlocks(part.text) : [part]))
      .flatMap<MessagePart | SvgPart | MermaidPart | ChoicePart | ProductPart | AskPart>((part) => (part.kind === "text" ? splitAskBlocks(part.text) : [part]))
      .flatMap<MessagePart | SvgPart | MermaidPart | ChoicePart | ProductPart | AskPart | FormPart>((part) => (part.kind === "text" ? splitFormBlocks(part.text) : [part])),
    [props.source],
  );
  if (parts.length === 1 && parts[0]!.kind === "text") return <MarkdownBlock {...props} source={parts[0]!.text} />;
  return (
    <>
      {parts.map((part, i) => part.kind === "map"
        ? <MapCard key={i} place={part.place} />
        : part.kind === "svg"
          ? <SvgCard key={i} code={part.code} />
          : part.kind === "mermaid"
            ? <MermaidCard key={i} code={part.code} />
          : part.kind === "products"
            ? <ProductCards key={i} items={part.items} onOpenLink={props.onOpenLink} onOpenFile={props.onOpenFile} />
          : part.kind === "choices"
            ? <ChoiceList key={i} options={part.options} chosen={props.choices?.chosen ?? null} disabled={props.choices?.disabled} onChoose={props.choices?.onChoose} />
          : part.kind === "ask"
            ? <div key={i} className="task-question ask-block" role="note" aria-label="向你提问">
                <div className="task-question-heading"><span aria-hidden="true">?</span><strong>向你提问</strong></div>
                <p>{part.question}</p>
                {part.options && <ChoiceList options={part.options} disabled />}
                {part.form && <FormCard spec={part.form} embedded />}
              </div>
          : part.kind === "form"
            // Sent like a tapped answer: the reply to this message is what closes it.
            ? <FormCard key={i} spec={part.spec} sent={props.choices?.chosen ?? null} disabled={props.choices?.disabled} onSubmit={props.choices?.onChoose} />
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
    // In a message, a media link on a line of its own plays where it stands (see embedMediaLinks).
    const rendered = marked.parse(document ? source ?? "" : embedMediaLinks(source ?? ""), { async: false }) as string;
    const clean = DOMPurify.sanitize(rendered, {
      // Only web URLs survive sanitisation; everything else loses its href.
      ALLOWED_URI_REGEXP: /^(?:https?):/i,
      // `tabindex` is a plain integer, not a URI. Because the URI regexp above is
      // applied to every non-URI-safe attribute, it must be marked URI-safe or
      // DOMPurify would strip `tabindex="0"` and break keyboard focus.
      ADD_URI_SAFE_ATTR: ["tabindex"],
      ADD_ATTR: ["target", "rel", "data-sandbox-file", "data-sandbox-image", "data-sandbox-video", "data-sandbox-audio", "data-web-image", "role", "tabindex", "controls", "playsinline", "preload", "loading"],
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
    const releases: Array<() => void> = [];
    let live = true;
    const fail = (img: HTMLImageElement) => {
      const note = window.document.createElement("span");
      note.className = "inline-media-failed muted tiny";
      note.textContent = `图片暂时无法显示：${img.alt || img.getAttribute("data-sandbox-image")?.split("/").pop() || img.getAttribute("data-web-image") || ""}`;
      img.replaceWith(note);
    };
    const load = (el: Element) => {
      if (el instanceof HTMLMediaElement) {
        const attr = el instanceof HTMLVideoElement ? "data-sandbox-video" : "data-sandbox-audio";
        const path = el.getAttribute(attr) ?? "";
        if (!isWorkspaceFilePath(path) || workspaceFileKind(path) !== (el instanceof HTMLVideoElement ? "video" : "audio")) return;
        // A file that cannot play says so in words; the title above still opens the preview and the download.
        el.addEventListener("error", () => {
          const note = window.document.createElement("span");
          note.className = "inline-media-failed muted tiny";
          note.textContent = "暂时放不了（文件可能已移动，或这个浏览器不支持这种格式）：点上面的标题打开预览或下载。";
          el.replaceWith(note);
        }, { once: true });
        el.src = api.documentMediaUrl(path);
        return;
      }
      const img = el as HTMLImageElement;
      const web = img.getAttribute("data-web-image");
      const path = img.getAttribute("data-sandbox-image") ?? "";
      if (web !== null ? !/^https:\/\//i.test(web) : !isWorkspaceFilePath(path) || workspaceFileKind(path) !== "image") return fail(img);
      // Fetched once and shared: the same picture elsewhere (a task panel, the preview) reuses it.
      const held = holdImage(web ?? path);
      releases.push(held.release);
      held.promise.then((url) => { if (live) img.src = url; }, () => { if (live) fail(img); });
    };
    const media = [...container.querySelectorAll("img[data-sandbox-image], img[data-web-image], video[data-sandbox-video], audio[data-sandbox-audio]")];
    let observer: IntersectionObserver | null = null;
    if (typeof IntersectionObserver === "function") {
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) if (entry.isIntersecting) { observer!.unobserve(entry.target); load(entry.target); }
      }, { rootMargin: "200px" });
      // A picture already fetched is drawn at once, without waiting to come into view.
      media.forEach((el) => { if (el instanceof HTMLImageElement && cachedImage(el.getAttribute("data-web-image") ?? el.getAttribute("data-sandbox-image"))) load(el); else observer!.observe(el); });
    } else media.forEach(load);
    return () => { live = false; observer?.disconnect(); releases.forEach((release) => release()); };
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
        // Private IP links stay reachable from the sandbox network.
        event.preventDefault();
        onOpenLink(href);
        return;
      }
      if (isWebLink(href) && !isSandboxLink(href)) {
        if (openNativeBrowser(href)) event.preventDefault();
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
