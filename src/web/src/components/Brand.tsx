/**
 * 一站's mark: an arc handing an amber dot on — the AI (indigo) and the person
 * (amber) passing work between them, which is what every screen is about.
 */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <rect width="40" height="40" rx="11" fill="var(--brand-tile, #5a4fe0)" />
      <path d="M11 25a9 9 0 0 1 18 0" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" />
      <circle cx="29" cy="25" r="4.4" fill="#ffb547" />
    </svg>
  );
}
