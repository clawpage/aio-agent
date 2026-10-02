/**
 * 一站's mark: a transit-map station. One line (一) runs through one station (站);
 * the stretch already travelled is solid, the stretch ahead is faint, and the
 * station's amber centre is the person's turn — work arrives, and you are called
 * when it is yours. Keep in step with public/favicon.svg and the PNG icons.
 */
export function BrandMark({ size = 28 }: { size?: number }) {
  const tile = "var(--brand-tile, #5a4fe0)";
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <rect width="40" height="40" rx="11" fill={tile} />
      <path d="M7 20H20" stroke="#fff" strokeWidth="3.6" strokeLinecap="round" />
      <path d="M20 20h13" stroke="#fff" strokeOpacity=".45" strokeWidth="3.6" strokeLinecap="round" />
      <circle cx="20" cy="20" r="6.8" fill={tile} stroke="#fff" strokeWidth="3" />
      <circle cx="20" cy="20" r="3.2" fill="#ffb547" />
    </svg>
  );
}
