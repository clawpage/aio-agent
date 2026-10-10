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

/** One drawing, in milliseconds; the same length as the `.loading-mark` animations in styles.css. */
const LOADING_CYCLE_MS = 2800;

/**
 * The mark's outline in the order one pen draws it: the tile's rounded frame
 * from its left middle round, the line up to the station, the station's circle
 * (from where the line meets it), and the line on past it. The centre is the
 * last touch. Separate strokes, because a dash starts over at every pen lift.
 */
const STROKES = [
  ["lm-frame", "M4 20V13A9 9 0 0 1 13 4H27A9 9 0 0 1 36 13V27A9 9 0 0 1 27 36H13A9 9 0 0 1 4 27Z"],
  ["lm-in", "M9 20H13.2"],
  ["lm-ring", "M13.2 20A6.8 6.8 0 1 1 26.8 20A6.8 6.8 0 1 1 13.2 20"],
  ["lm-out", "M26.8 20H31"],
] as const;

/**
 * The console's one loading animation: the mark sketched in a single line,
 * over and over. Every copy on the page runs on the document's clock, so two
 * loaders (or the page before the script and the app after it) move as one.
 * index.html draws the same figure for the page before the script arrives.
 */
export function LoadingMark({ size = 44 }: { size?: number }) {
  const phase = typeof performance === "undefined" ? 0 : performance.now() % LOADING_CYCLE_MS;
  const style = { "--loading-phase": `-${Math.round(phase)}ms` } as CSSProperties;
  return (
    <svg className="loading-mark" width={size} height={size} viewBox="0 0 40 40" style={style} aria-hidden="true">
      <g className="lm-draw">
        {STROKES.map(([name, d]) => <path key={name} className={`lm-stroke ${name}`} d={d} pathLength={1} />)}
        <circle className="lm-stop" cx="20" cy="20" r="2.6" />
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
