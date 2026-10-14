/**
 * The image's trusted init (`/opt/gem/gem_init.sh`, run as root at every
 * container start) starts its browser supervisor, and with it Chromium, before
 * anything else. On a 2-core sandbox that costs ~2 s of a ~5 s boot, and the
 * browser it starts is not even the one the account had: a browser released
 * before the stop comes back from its snapshot on first use. The patch skips the
 * supervisor while browser-runtime.py's root-owned marker says the browser was
 * released; starting the supervisor again removes the marker.
 */
export const GEM_INIT_PATH = "/opt/gem/gem_init.sh";
export const BOOT_RELEASED_MARKER = "/opt/aio-browser/boot-released";

const MARKER = "# aio-agent: a released browser stays released until its first use";
const DISABLED = `if [ "\${DISABLE_BROWSER:-false}" = "true" ]; then
  log "browser is disabled, skip browser supervisor"
  exit 0
fi
`;

/** The patched gem_init.sh; null when its code is not the version this patch knows. */
export function patchGemInit(source: string): string | null {
  if (source.includes(MARKER)) return source;
  if (source.split(DISABLED).length !== 2) return null;
  return source.replace(DISABLED, `${DISABLED}
${MARKER}
if [ -e "${BOOT_RELEASED_MARKER}" ]; then
  log "browser was released before the stop, skip browser supervisor"
  exit 0
fi
`);
}
