import { openNativeBrowser } from "../deviceBrowser";
import { memo } from "react";
import { opensVideosOutside, type VideoLink } from "../videoLinks";
import { t } from "../i18n";

const PROVIDER = { youtube: "YouTube", bilibili: t.cards.video.bilibili } as const;

/**
 * A YouTube or Bilibili video a message links to. On a computer it plays in place:
 * the provider's own embed page (privacy-enhanced YouTube), framed in a sandbox
 * that lets it run and go full screen but not open windows or navigate this page;
 * it loads only when scrolled near. On a phone or tablet it is a card that opens
 * the video's page in the browser (Safari on an iPhone), which hands it to the
 * YouTube or Bilibili app when one is installed.
 */
export const VideoEmbed = memo(function VideoEmbed({ video }: { video: VideoLink }) {
  const label = PROVIDER[video.provider];
  if (opensVideosOutside(navigator.userAgent)) {
    return (
      <a className="video-link" data-provider={video.provider} href={video.page} onClick={event => { if (openNativeBrowser(video.page)) event.preventDefault(); }} target="_blank" rel="noopener noreferrer" aria-label={t.cards.video.open(label, video.title)}>
        <span className="video-link-play" aria-hidden="true">▶</span>
        <span className="video-link-text">
          <span className="video-link-title">{video.title ?? t.cards.video.fallbackTitle(label)}</span>
          <span className="video-link-hint">{t.cards.video.openHint(label)}</span>
        </span>
      </a>
    );
  }
  return (
    <figure className="video-embed" data-provider={video.provider}>
      <div className="video-embed-frame">
        <iframe
          src={video.embed}
          title={t.cards.video.frame(label, video.title)}
          loading="lazy"
          allow="encrypted-media; picture-in-picture; fullscreen; autoplay"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          sandbox="allow-scripts allow-same-origin allow-presentation"
        />
      </div>
      <figcaption className="video-embed-caption"><span className="video-embed-badge">{label}</span>{video.title && <span className="video-embed-title">{video.title}</span>}</figcaption>
    </figure>
  );
});
