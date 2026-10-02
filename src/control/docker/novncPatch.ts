/**
 * Fixes to the image's noVNC (1.4.0 in the pinned image, unchanged upstream
 * since) for people operating the sandbox desktop from a phone. The control
 * plane applies them to the container's files at sandbox start; each piece is
 * idempotent, so a container patched by an older version just gets what is new.
 *
 * - One tap on a phone keyboard typed two characters: the touch keyboard sends
 *   a key from the hidden textarea's `keydown` and calls preventDefault, and
 *   `keyInput` sends whatever the `input` event added. Phone keyboards often
 *   insert the text anyway (digits on a Chinese keyboard, for one), so the same
 *   key went out twice. `keyEvent` now remembers what it just sent, and
 *   `keyInput` skips a character or backspace sent that way within 100 ms.
 * - A long press held the right mouse button, so "press and hold" checks (the
 *   PerimeterX button on Target and others) could never pass by touch. It now
 *   holds the left button; a two-finger tap stays the right click.
 */
export const NOVNC_UI_PATH = "/opt/novnc/app/ui.js";
export const NOVNC_HTML_PATH = "/opt/novnc/vnc.html";
export const NOVNC_RFB_PATH = "/opt/novnc/core/rfb.js";

/**
 * The image serves noVNC without Cache-Control and with a 2023 Last-Modified,
 * so a phone may keep old copies for months on heuristic freshness. Patched
 * files are loaded under URLs carrying this version (vnc.html → ui.js → rfb.js;
 * the console opens vnc.html with it too, see DESKTOP_PATH); bump it whenever a
 * patched file changes.
 */
export const NOVNC_ASSET_VERSION = 2;

const KEYBOARD_MARKER = "/* aio-agent: one tap, one key */";
const KEY_EVENT = `    keyEvent(keysym, code, down) {
        if (!UI.rfb) return;
`;
const SENDS = `        for (let i = 0; i < backspaces; i++) {
            UI.rfb.sendKey(KeyTable.XK_BackSpace, "Backspace");
        }
        for (let i = newLen - inputs; i < newLen; i++) {
            UI.rfb.sendKey(keysyms.lookup(newValue.charCodeAt(i)));
        }
`;
const RFB_IMPORT = /import RFB from "\.\.\/core\/rfb\.js(\?aio=\d+)?";/g;
const UI_SCRIPT = /src="app\/ui\.js(\?aio=\d+)?"/g;

/** Replace the one match of `pattern`, or null when there is not exactly one. */
function replaceOne(source: string, pattern: RegExp, replacement: string): string | null {
  return (source.match(pattern) ?? []).length === 1 ? source.replace(pattern, replacement) : null;
}

function patchKeyboard(source: string): string | null {
  if (source.includes(KEYBOARD_MARKER)) return source;
  if (source.split(KEY_EVENT).length !== 2 || source.split(SENDS).length !== 2) return null;
  return source
    .replace(KEY_EVENT, `    ${KEYBOARD_MARKER}
    // Keys the touch keyboard just sent; its input event must not send them again.
    recentTouchKeys: [],

    takeTouchKey(keysym) {
        const now = Date.now();
        UI.recentTouchKeys = UI.recentTouchKeys.filter(k => now - k.at < 100);
        const i = UI.recentTouchKeys.findIndex(k => k.keysym === keysym);
        if (i < 0) return false;
        UI.recentTouchKeys.splice(i, 1);
        return true;
    },

${KEY_EVENT}        if (down) UI.recentTouchKeys.push({ keysym, at: Date.now() });
`)
    .replace(SENDS, `        for (let i = 0; i < backspaces; i++) {
            if (UI.takeTouchKey(KeyTable.XK_BackSpace)) continue;
            UI.rfb.sendKey(KeyTable.XK_BackSpace, "Backspace");
        }
        for (let i = newLen - inputs; i < newLen; i++) {
            const keysym = keysyms.lookup(newValue.charCodeAt(i));
            if (UI.takeTouchKey(keysym)) continue;
            UI.rfb.sendKey(keysym);
        }
`);
}

/** The patched app/ui.js; null when its code is not the version these patches know. */
export function patchNoVncUi(source: string): string | null {
  const keyboard = patchKeyboard(source);
  return keyboard === null ? null : replaceOne(keyboard, RFB_IMPORT, `import RFB from "../core/rfb.js?aio=${NOVNC_ASSET_VERSION}";`);
}

/** The patched vnc.html (loads ui.js under the current version); null when unknown. */
export function patchNoVncHtml(source: string): string | null {
  return replaceOne(source, UI_SCRIPT, `src="app/ui.js?aio=${NOVNC_ASSET_VERSION}"`);
}

const LONGPRESS_MARKER = "/* aio-agent: a long press holds the left button */";
const LONGPRESS = (down: boolean, mask: string) => `                    case 'longpress':
                        this._fakeMouseMove(ev, pos.x, pos.y);
                        this._handleMouseButton(pos.x, pos.y, ${down}, ${mask});`;

/** The patched core/rfb.js (a long press holds the left button); null when unknown. */
export function patchNoVncRfb(source: string): string | null {
  if (source.includes(LONGPRESS_MARKER)) return source;
  if (source.split(LONGPRESS(true, "0x4")).length !== 2 || source.split(LONGPRESS(false, "0x4")).length !== 2) return null;
  return source
    .replace(LONGPRESS(true, "0x4"), `                    ${LONGPRESS_MARKER}\n${LONGPRESS(true, "0x1")}`)
    .replace(LONGPRESS(false, "0x4"), LONGPRESS(false, "0x1"));
}
