/**
 * One tap on a phone keyboard typed two characters on the sandbox desktop.
 *
 * noVNC (1.4.0 in the pinned image, unchanged upstream since) listens to its
 * hidden keyboard textarea twice: the touch keyboard sends a key from `keydown`
 * and calls preventDefault, and `keyInput` sends whatever the `input` event
 * added. Phone keyboards often insert the text anyway (digits on a Chinese
 * keyboard, for one), so the same key goes out from both. The patch has
 * `keyEvent` remember what it just sent, and `keyInput` skip a character or
 * backspace that was sent that way within the last 100 ms.
 */
export const NOVNC_UI_PATH = "/opt/novnc/app/ui.js";
const MARKER = "/* aio-agent: one tap, one key */";

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

/** The patched ui.js; the source unchanged when already patched; null when its code is not the version this patch knows. */
export function patchNoVncUi(source: string): string | null {
  if (source.includes(MARKER)) return source;
  if (source.split(KEY_EVENT).length !== 2 || source.split(SENDS).length !== 2) return null;
  return source
    .replace(KEY_EVENT, `    ${MARKER}
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
