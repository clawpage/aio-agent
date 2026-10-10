import type { CSSProperties } from "react";

/**
 * 一站's mark: a transit-map station. One line (一) runs through one station (站);
 * the stretch already travelled is solid, the stretch ahead is faint, and the
 * station's amber centre is the person's turn — work arrives, and you are called
 * when it is yours. Keep in step with public/favicon.svg and the PNG icons.
 */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <rect width="40" height="40" rx="11" fill="var(--brand-tile)" />
      <path d="M7 20H20" stroke="var(--brand-line)" strokeWidth="3.6" strokeLinecap="round" />
      <path d="M20 20h13" stroke="var(--brand-line)" strokeOpacity=".45" strokeWidth="3.6" strokeLinecap="round" />
      <circle cx="20" cy="20" r="6.8" fill="var(--brand-tile)" stroke="var(--brand-line)" strokeWidth="3" />
      <circle cx="20" cy="20" r="3.2" fill="var(--brand-stop)" />
    </svg>
  );
}

/** One construction, in milliseconds; the same length as the `.loading-mark` animations in styles.css. */
const LOADING_CYCLE_MS = 3200;
/** Below this size the ruler and compass are too small to read: only the drawing shows. */
const TOOLS_MIN_SIZE = 28;

/**
 * The console's one loading animation: the mark drawn with ruler and compass,
 * over and over. The ruler lays the line, the compass turns once about the
 * station to draw it, the amber centre lights, and the stretch ahead fades to
 * its faint shade. Every copy on the page runs on the document's clock, so two
 * loaders (or the page before the script and the app after it) move as one.
 * index.html draws the same figure for the page before the script arrives.
 */
export function LoadingMark({ size = 44 }: { size?: number }) {
  const phase = typeof performance === "undefined" ? 0 : performance.now() % LOADING_CYCLE_MS;
  const style = { "--loading-phase": `-${Math.round(phase)}ms` } as CSSProperties;
  return (
    <svg className={`loading-mark${size < TOOLS_MIN_SIZE ? " small" : ""}`} width={size} height={size} viewBox="0 0 40 40" style={style} aria-hidden="true">
      <rect className="lm-tile" width="40" height="40" rx="11" />
      <g className="lm-draw">
        <rect className="lm-ruler" x="5" y="22.6" width="30" height="2.6" rx="0.8" />
        <path className="lm-line lm-travelled" d="M7 20H20" pathLength={1} />
        <path className="lm-line lm-ahead" d="M20 20h13" pathLength={1} />
        <circle className="lm-station" cx="20" cy="20" r="6.8" pathLength={1} />
        <circle className="lm-stop" cx="20" cy="20" r="3.2" />
        <g className="lm-compass">
          <path d="M24.2 9.6 20 20M24.2 9.6 26.8 20" />
          <circle cx="24.2" cy="9.6" r="1.3" />
        </g>
      </g>
    </svg>
  );
}

/** A whole screen still loading: the large mark, centred, with what is happening under it. */
export function PageLoading({ label }: { label: string }) {
  return (
    <div className="boot boot-loading" role="status">
      <LoadingMark size={56} />
      <span className="boot-label">{label}</span>
    </div>
  );
}

/** Loading inside a page or panel: the small mark beside the text that says what is loading. */
export function InlineLoading({ label }: { label: string }) {
  return (
    <span className="inline-loading" role="status">
      <LoadingMark size={18} />
      <span>{label}</span>
    </span>
  );
}
