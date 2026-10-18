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
 * - A pinch (or a two-finger scroll whose fingers drifted) sent Ctrl + wheel,
 *   which zooms the remote page, and Chrome keeps a zoom per site: Amazon stuck
 *   at 150% laid out 853 px wide, as if on a phone. A pinch now does nothing to
 *   the page.
 * - On a phone the console draws its own toolbar under the desktop (keyboard,
 *   paste, Esc/Tab/Enter). It asks noVNC to hide its own control bar on the left
 *   and sends it keys and text by postMessage; only the embedding page
 *   (window.parent) is listened to, and only our own origins may frame this page
 *   (frame-ancestors).
 * - On a phone the console's own gesture layer covers the desktop (it zooms and
 *   pans the picture itself) and sends the pointer the same way: clicks, a
 *   button held across moves, and wheel turns in the desktop's pixels.
 * - Input on the desktop never reaches the console around it, which puts away a
 *   desktop nobody touches (its socket holds the browser awake). The desktop
 *   tells the embedding page that someone is using it, at most every 15 s.
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
export const NOVNC_ASSET_VERSION = 7;

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

const HOST_BAR_MARKER = "/* aio-agent: the console's toolbar drives this desktop */";
const UI_EXPORT = "\nexport default UI;\n";
const HOST_BAR = `
${HOST_BAR_MARKER}
// The console's own toolbar (in the black strip under the zoomed desktop) replaces the
// control bar on the left. Only the page that frames this one is listened to.
if (window.parent !== window) {
    const style = document.createElement('style');
    style.textContent = 'html.aio-host-bar #noVNC_control_bar_anchor, html.aio-host-bar #noVNC_control_bar_hint { display: none !important; }';
    document.head.appendChild(style);
    const KEYS = {
        Enter: [KeyTable.XK_Return, "Enter"], Backspace: [KeyTable.XK_BackSpace, "Backspace"], Tab: [KeyTable.XK_Tab, "Tab"],
        Escape: [KeyTable.XK_Escape, "Escape"], ArrowUp: [KeyTable.XK_Up, "ArrowUp"], ArrowDown: [KeyTable.XK_Down, "ArrowDown"],
        ArrowLeft: [KeyTable.XK_Left, "ArrowLeft"], ArrowRight: [KeyTable.XK_Right, "ArrowRight"],
    };
    window.addEventListener('message', (e) => {
        const m = e.data;
        if (e.source !== window.parent || !m || m.aio !== 'desktop') return;
        if (m.type === 'bar') { document.documentElement.classList.toggle('aio-host-bar', m.on === true); return; }
        if (!UI.rfb) return;
        if (m.type === 'key' && KEYS[m.key]) UI.rfb.sendKey(...KEYS[m.key]);
        else if (m.type === 'text' && typeof m.text === 'string') {
            for (const ch of m.text.slice(0, 2000)) UI.rfb.sendKey(keysyms.lookup(ch.codePointAt(0)));
        } else if (m.type === 'paste' && typeof m.text === 'string') {
            // Into the desktop's clipboard, then Ctrl+V into the focused page.
            UI.rfb.clipboardPasteFrom(m.text.slice(0, 100000));
            UI.rfb.sendKey(KeyTable.XK_Control_L, "ControlLeft", true);
            UI.rfb.sendKey(KeyTable.XK_v, "KeyV");
            UI.rfb.sendKey(KeyTable.XK_Control_L, "ControlLeft", false);
        }
    });
}
`;

function patchHostBar(source: string): string | null {
  if (source.includes(HOST_BAR_MARKER)) return source;
  if (source.split(UI_EXPORT).length !== 2) return null;
  return source.replace(UI_EXPORT, `\n${HOST_BAR}${UI_EXPORT}`);
}

const HOST_POINTER_MARKER = "/* aio-agent: the console's gesture layer drives the pointer */";
const HOST_POINTER = `
${HOST_POINTER_MARKER}
// Positions arrive as fractions of the desktop, wheel turns in its pixels (one notch per WHEEL_STEP).
if (window.parent !== window) {
    const WHEEL_STEP = 50;
    const BUTTONS = { left: 0x1, middle: 0x2, right: 0x4 };
    let held = 0, wheelX = 0, wheelY = 0;
    const live = () => UI.rfb && UI.rfb._rfbConnectionState === 'connected' && !UI.rfb.viewOnly;
    const at = (m) => {
        const w = UI.rfb._fbWidth, h = UI.rfb._fbHeight, f = (v) => Math.min(1, Math.max(0, Number(v) || 0));
        return [Math.round(f(m.x) * (w - 1)), Math.round(f(m.y) * (h - 1))];
    };
    const pointer = (x, y, mask) => RFB.messages.pointerEvent(UI.rfb._sock, x, y, mask);
    const notches = (x, y, count, bit) => {
        for (let i = 0; i < count; i++) { pointer(x, y, held | bit); pointer(x, y, held); }
    };
    window.addEventListener('message', (e) => {
        const m = e.data;
        if (e.source !== window.parent || !m || m.aio !== 'desktop' || !live()) return;
        if (m.type !== 'click' && m.type !== 'pointer' && m.type !== 'wheel') return;
        const [x, y] = at(m);
        const button = BUTTONS[m.button] || BUTTONS.left;
        if (m.type === 'click') {
            pointer(x, y, held);
            pointer(x, y, held | button);
            pointer(x, y, held);
        } else if (m.type === 'pointer') {
            if (m.phase === 'down') held |= button;
            else if (m.phase === 'up') held &= ~button;
            pointer(x, y, held);
        } else {
            wheelX += Number(m.dx) || 0;
            wheelY += Number(m.dy) || 0;
            const down = Math.trunc(wheelY / WHEEL_STEP), right = Math.trunc(wheelX / WHEEL_STEP);
            wheelY -= down * WHEEL_STEP;
            wheelX -= right * WHEEL_STEP;
            notches(x, y, Math.min(40, Math.abs(down)), down > 0 ? 0x10 : 0x8);
            notches(x, y, Math.min(40, Math.abs(right)), right > 0 ? 0x40 : 0x20);
        }
    });
}
`;

function patchHostPointer(source: string): string | null {
  if (source.includes(HOST_POINTER_MARKER)) return source;
  if (source.split(UI_EXPORT).length !== 2) return null;
  return source.replace(UI_EXPORT, `\n${HOST_POINTER}${UI_EXPORT}`);
}

const HOST_ACTIVITY_MARKER = "/* aio-agent: the console hears that someone uses the desktop */";
const HOST_ACTIVITY = `
${HOST_ACTIVITY_MARKER}
if (window.parent !== window) {
    let reportedAt = 0;
    const report = () => {
        const now = Date.now();
        if (now - reportedAt < 15000) return;
        reportedAt = now;
        window.parent.postMessage({ aio: 'desktop', type: 'activity' }, '*');
    };
    for (const name of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) {
        document.addEventListener(name, report, { capture: true, passive: true });
    }
}
`;

function patchHostActivity(source: string): string | null {
  if (source.includes(HOST_ACTIVITY_MARKER)) return source;
  if (source.split(UI_EXPORT).length !== 2) return null;
  return source.replace(UI_EXPORT, `\n${HOST_ACTIVITY}${UI_EXPORT}`);
}

/** The patched app/ui.js; null when its code is not the version these patches know. */
export function patchNoVncUi(source: string): string | null {
  const keyboard = patchKeyboard(source);
  const bar = keyboard && patchHostBar(keyboard);
  const pointer = bar && patchHostPointer(bar);
  const activity = pointer && patchHostActivity(pointer);
  return activity === null ? null : replaceOne(activity, RFB_IMPORT, `import RFB from "../core/rfb.js?aio=${NOVNC_ASSET_VERSION}";`);
}

/** The patched vnc.html (loads ui.js under the current version); null when unknown. */
export function patchNoVncHtml(source: string): string | null {
  return replaceOne(source, UI_SCRIPT, `src="app/ui.js?aio=${NOVNC_ASSET_VERSION}"`);
}

const LONGPRESS_MARKER = "/* aio-agent: a long press holds the left button */";
const LONGPRESS = (down: boolean, mask: string) => `                    case 'longpress':
                        this._fakeMouseMove(ev, pos.x, pos.y);
                        this._handleMouseButton(pos.x, pos.y, ${down}, ${mask});`;

function patchLongpress(source: string): string | null {
  if (source.includes(LONGPRESS_MARKER)) return source;
  if (source.split(LONGPRESS(true, "0x4")).length !== 2 || source.split(LONGPRESS(false, "0x4")).length !== 2) return null;
  return source
    .replace(LONGPRESS(true, "0x4"), `                    ${LONGPRESS_MARKER}\n${LONGPRESS(true, "0x1")}`)
    .replace(LONGPRESS(false, "0x4"), LONGPRESS(false, "0x1"));
}

const PINCH_MARKER = "/* aio-agent: a pinch never zooms the remote page */";
/** The pinch's Ctrl + wheel (page zoom), from its magnitude to the Ctrl release. */
const PINCH_ZOOM = /( +)magnitude = Math\.hypot\(ev\.detail\.magnitudeX, ev\.detail\.magnitudeY\);\n[^]*?GESTURE_ZOOMSENS[^]*?this\._handleKeyEvent\(KeyTable\.XK_Control_L, "ControlLeft", false\);\n/g;

function patchPinch(source: string): string | null {
  if (source.includes(PINCH_MARKER)) return source;
  return replaceOne(source, PINCH_ZOOM, `$1${PINCH_MARKER}\n`);
}

/** The patched core/rfb.js (a long press holds the left button, a pinch zooms nothing); null when unknown. */
export function patchNoVncRfb(source: string): string | null {
  const longpress = patchLongpress(source);
  return longpress && patchPinch(longpress);
}
