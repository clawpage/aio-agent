import { useId, type ReactNode } from "react";

/**
 * Dock and desktop icons for the workspace apps: a rounded tile with a white
 * glyph, macOS-style. The tile colour comes from `.app-icon[data-app]` in
 * styles.css, so both themes stay on the shared tokens.
 */
const GLYPHS: Record<string, ReactNode> = {
  // A compass: the sandbox browser.
  browser: (
    <>
      <circle cx="20" cy="20" r="11" fill="none" stroke="#fff" strokeWidth="2.4" />
      <path d="M24.5 15.5 21.6 21.6 15.5 24.5 18.4 18.4Z" fill="#fff" />
    </>
  ),
  // A prompt.
  terminal: (
    <>
      <path d="M12 15l5 5-5 5" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M20 26h8" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
    </>
  ),
  // A folder.
  files: (
    <path d="M10 14.5a2 2 0 0 1 2-2h5l2.2 2.4H28a2 2 0 0 1 2 2V26a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2Z" fill="#fff" />
  ),
  // Angle brackets.
  editor: (
    <path d="M16 14l-6 6 6 6M24 14l6 6-6 6" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
  ),
  // A notebook with a chart line.
  notebook: (
    <>
      <rect x="12" y="10.5" width="16" height="19" rx="2.5" fill="none" stroke="#fff" strokeWidth="2.2" />
      <path d="M15.5 24l3-4 2.6 2.2 3.4-5" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // A window with an eye-like dot: preview a page or port.
  preview: (
    <>
      <rect x="10" y="12" width="20" height="16" rx="2.5" fill="none" stroke="#fff" strokeWidth="2.2" />
      <path d="M10 16.5h20" stroke="#fff" strokeWidth="2.2" />
      <circle cx="20" cy="22.3" r="2.4" fill="#fff" />
    </>
  ),
  // A phone with a home bar.
  phone: (
    <>
      <rect x="14" y="9.5" width="12" height="21" rx="2.6" fill="none" stroke="#fff" strokeWidth="2.2" />
      <path d="M18 26.5h4" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
    </>
  ),
  // A plug: endpoints and MCP.
  api: (
    <>
      <path d="M16 11v5M24 11v5" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M13 16h14v3a7 7 0 0 1-14 0Z" fill="#fff" />
      <path d="M20 26v4" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
    </>
  ),
};

export function AppIcon({ app, size = 44 }: { app: string; size?: number }) {
  const gloss = useId();
  return (
    <svg className="app-icon" data-app={app} width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <defs>
        <linearGradient id={gloss} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.32" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect className="app-icon-tile" width="40" height="40" rx="9.5" />
      <rect width="40" height="40" rx="9.5" fill={`url(#${gloss})`} />
      {GLYPHS[app]}
    </svg>
  );
}
