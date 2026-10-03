import { memo } from "react";
import type { VideoLink } from "../videoLinks";

const PROVIDER = { youtube: "YouTube", bilibili: "B 站" } as const;

/**
 * A YouTube or Bilibili video a message links to, playing in place. The player is
 * the provider's own embed page (privacy-enhanced YouTube), framed in a sandbox
 * that lets it run and go full screen but not open windows or navigate this page;
 * it loads only when scrolled near. The link in the message still opens the
 * video page in the sandbox browser.
 */
export const VideoEmbed = memo(function VideoEmbed({ video }: { video: VideoLink }) {
  const label = PROVIDER[video.provider];
  return (
    <figure className="video-embed" data-provider={video.provider}>
      <div className="video-embed-frame">
        <iframe
          src={video.embed}
          title={`${label} 视频${video.title ? `：${video.title}` : ""}`}
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
