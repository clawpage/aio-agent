import { memo, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { cachedImage, holdImage } from "../imageCache";
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
  const [thumbUrl, setThumbUrl] = useState<string | null>(() => (kind === "image" ? cachedImage(path) : null));
  const [thumbFailed, setThumbFailed] = useState(false);
  const [audioFailed, setAudioFailed] = useState(false);
  const image = kind === "image";
  const html = isHtmlPath(path);
  const markdown = isMarkdownPath(path);
  const showThumb = image && !thumbFailed;
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!image) return;
    let live = true;
    let release: (() => void) | null = null;
    // Fetched once and shared through the image cache: the same picture in a
    // message or the preview is not loaded again. Only an image response is used.
    const load = (): void => {
      if (release) return;
      const held = holdImage(path);
      release = held.release;
      held.promise.then((url) => { if (live) setThumbUrl(url); }, () => { if (live) setThumbFailed(true); });
    };

    // Only start loading when the card is actually visible (at once if it is already cached).
    let observer: IntersectionObserver | null = null;
    const target = cardRef.current;
    if (typeof IntersectionObserver === "function" && target && !cachedImage(path)) {
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

    return () => {
      live = false;
      observer?.disconnect();
      release?.();
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
