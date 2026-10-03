import { memo, useEffect, useRef, useState } from "react";
import { api, API_CREDENTIALS } from "../api";
import { isMarkdownPath, isHtmlPath, kindBadge, kindLabel, type WorkspaceFileKind } from "../sandboxLink";

/**
 * One workspace file shown as a card in the conversation.
 *
 * The card body is a real `<button>`, so it is keyboard operable (Enter/Space)
 * and works with touch without any hover-only affordance. Images get a
 * lazily-loaded thumbnail; a failed thumbnail falls back to the format badge
 * with an explicit note, never a blank box.
 *
 * The thumbnail is loaded through `fetch` + an object URL rather than a plain
 * `<img src>`: the authenticated inline image endpoint needs a same-origin
 * credential the URL alone does not carry, and an object URL also lets a failure
 * be handled as a real error instead of a broken-image icon. Loading starts only
 * once the card has been scrolled into view, so a long history does not turn
 * into a burst of image requests.
 *
 * The 下载 link is a separate control, so a file can be saved without opening the
 * preview dialog first.
 */
export interface FileCardProps {
  path: string;
  name: string;
  title?: string;
  kind: WorkspaceFileKind;
  onOpen: (path: string) => void;
}

export const FileCard = memo(function FileCard({ path, name, title, kind, onOpen }: FileCardProps) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [thumbFailed, setThumbFailed] = useState(false);
  const [audioFailed, setAudioFailed] = useState(false);
  const image = kind === "image";
  const html = isHtmlPath(path);
  const markdown = isMarkdownPath(path);
  const showThumb = image && !thumbFailed;
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!image) return;
    let revoked = false;
    let objectUrl: string | null = null;
    const controller = new AbortController();
    const load = (): void => {
      void (async () => {
        try {
          const res = await fetch(api.documentImageUrl(path), {
            credentials: API_CREDENTIALS,
            signal: controller.signal,
          });
          if (!res.ok) throw new Error("thumbnail unavailable");
          // A 200 alone does not mean "image": the server sniffs the bytes and
          // answers a non-image with an error status, but a proxy or a future
          // change could still hand back HTML. Require an image type before it
          // reaches the <img>.
          const type = res.headers.get("content-type") ?? "";
          if (!type.startsWith("image/")) throw new Error("not an image response");
          const blob = await res.blob();
          if (blob.size === 0) throw new Error("empty thumbnail");
          if (revoked) return;
          objectUrl = URL.createObjectURL(blob);
          setThumbUrl(objectUrl);
        } catch (err) {
          if (revoked || (err instanceof DOMException && err.name === "AbortError")) return;
          setThumbFailed(true);
        }
      })();
    };

    // Only start loading when the card is actually visible.
    let observer: IntersectionObserver | null = null;
    if (typeof IntersectionObserver === "function") {
      const target = cardRef.current;
      if (target) {
        observer = new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            observer?.disconnect();
            observer = null;
            load();
          }
        });
        observer.observe(target);
      } else {
        load();
      }
    } else {
      load();
    }

    return () => {
      revoked = true;
      controller.abort();
      observer?.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [image, path]);

  return (
    <div ref={cardRef} className="file-card" data-testid="file-card" data-kind={html ? "html" : markdown ? "markdown" : kind} data-path={path} title={path}>
      <button type="button" className="file-card-open" onClick={() => onOpen(path)} aria-label={`预览 ${title || name}`}>
        <span className="file-card-thumb" aria-hidden="true">
          {showThumb && thumbUrl ? (
            <img
              src={thumbUrl}
              alt=""
              decoding="async"
              data-testid="file-card-thumb"
              // An HTTP 200 can still be undecodable bytes; fall back to the
              // format badge rather than showing a broken image.
              onError={() => setThumbFailed(true)}
            />
          ) : (
            <span className="file-card-badge">{html ? "HTML" : markdown ? "MD" : kindBadge(kind)}</span>
          )}
        </span>
        <span className="file-card-meta">
          <span className="file-card-name">{title || name}</span>
          {title && <span className="file-card-filename muted tiny">{name}</span>}
          <span className="muted tiny">
            {html ? "HTML 页面" : markdown ? "Markdown 文档" : kindLabel(kind)}{kind === "video" ? " · 点击播放" : kind === "audio" ? " · 可直接播放" : kind !== "unsupported" ? " · 点击预览" : " · 可下载"}
            {image && thumbFailed ? "（缩略图不可用，点开查看）" : ""}
          </span>
        </span>
      </button>
      <a className="file-card-download" href={api.downloadUrl(path)} download={name} data-testid="file-card-download">
        下载
      </a>
      {/* Nothing loads until play is pressed (preload none), so a long history stays light. */}
      {kind === "audio" && (
        <audio className="file-card-audio" data-testid="file-card-audio" src={api.documentMediaUrl(path)} controls preload="none" aria-label={`播放 ${title || name}`}
          onError={(e) => { if ((e.currentTarget as HTMLAudioElement).error) setAudioFailed(true); }} />
      )}
      {kind === "audio" && audioFailed && <p className="file-card-note muted tiny" role="status">这个音频在当前浏览器放不了，可以下载后播放。</p>}
    </div>
  );
});
