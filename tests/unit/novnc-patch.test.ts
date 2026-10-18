import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { NOVNC_ASSET_VERSION, patchNoVncHtml, patchNoVncRfb, patchNoVncUi } from "../../src/control/sandbox/novncPatch.js";
import { DESKTOP_PATH } from "../../src/ui/src/components/TaskConsole.js";

// app/ui.js and core/rfb.js exactly as the pinned image ships them (noVNC 1.4.0).
const ui = fs.readFileSync(new URL("../fixtures/novnc-ui-1.4.0.js", import.meta.url), "utf8");
const rfb = fs.readFileSync(new URL("../fixtures/novnc-rfb-1.4.0.js", import.meta.url), "utf8");
const changedLines = (a: string, b: string) => b.split("\n").filter((l) => !a.includes(l)).length;

describe("noVNC phone keyboard patch", () => {
  it("makes the input event skip keys the touch keyboard already sent", () => {
    const patched = patchNoVncUi(ui)!;
    expect(patched).toContain("if (down) UI.recentTouchKeys.push({ keysym, at: Date.now() });");
    expect(patched).toContain("if (UI.takeTouchKey(keysym)) continue;");
    expect(patched).toContain("if (UI.takeTouchKey(KeyTable.XK_BackSpace)) continue;");
    // The keyboard fix alone (the toolbar block after it is its own piece, tested below).
    const keyboardOnly = patched.slice(0, patched.indexOf("\n/* aio-agent: the console's toolbar drives this desktop */"));
    expect(changedLines(ui, keyboardOnly)).toBeLessThan(25);
  });

  it("loads the patched rfb.js under the current asset version", () => {
    expect(patchNoVncUi(ui)).toContain(`import RFB from "../core/rfb.js?aio=${NOVNC_ASSET_VERSION}";`);
  });

  it("applies once, and upgrades a ui.js patched by an older version", () => {
    const patched = patchNoVncUi(ui)!;
    expect(patchNoVncUi(patched)).toBe(patched);
    const older = patched.replace(`rfb.js?aio=${NOVNC_ASSET_VERSION}"`, 'rfb.js"');
    expect(patchNoVncUi(older)).toBe(patched);
  });

  it("refuses a noVNC whose code it does not know rather than half-patching it", () => {
    expect(patchNoVncUi(ui.replace('UI.rfb.sendKey(KeyTable.XK_BackSpace, "Backspace");', "UI.rfb.sendKey(KeyTable.XK_BackSpace);"))).toBeNull();
    expect(patchNoVncUi("export default {};")).toBeNull();
  });
});

describe("noVNC long press", () => {
  it("holds the left button for a long press, and only there", () => {
    const patched = patchNoVncRfb(rfb)!;
    const longpress = (down: boolean) => new RegExp(`case 'longpress':\\s+this\\._fakeMouseMove\\(ev, pos\\.x, pos\\.y\\);\\s+this\\._handleMouseButton\\(pos\\.x, pos\\.y, ${down}, (0x\\d)\\);`);
    expect(longpress(true).exec(rfb)![1]).toBe("0x4");
    expect(longpress(true).exec(patched)![1]).toBe("0x1");
    expect(longpress(false).exec(patched)![1]).toBe("0x1");
    // The two-finger tap is still the right click.
    expect(patched).toContain("case 'twotap':\n                        this._handleTapEvent(ev, 0x4);");
    expect(changedLines(rfb, patched)).toBeLessThan(4);
    expect(patchNoVncRfb(patched)).toBe(patched);
    expect(patchNoVncRfb("export default {};")).toBeNull();
  });
});

describe("noVNC pinch", () => {
  const zoomsPage = /GESTURE_ZOOMSENS\) \{\s+this\._handleKeyEvent\(KeyTable\.XK_Control_L, "ControlLeft", true\);/;

  it("never sends the remote page Ctrl + wheel, which Chrome keeps as a per-site zoom", () => {
    expect(rfb).toMatch(zoomsPage);
    const patched = patchNoVncRfb(rfb)!;
    expect(patched).not.toMatch(zoomsPage);
    expect(patched).toContain("/* aio-agent: a pinch never zooms the remote page */");
    // The pinch still moves the pointer; the two-finger scroll is untouched.
    expect(patched).toMatch(/case 'pinch':\s+\/\/ Always scroll in the same position\.[^]*?this\._fakeMouseMove\(ev, pos\.x, pos\.y\);\s+\/\* aio-agent: a pinch never zooms the remote page \*\/\s+break;/);
    expect(patched).toContain("this._handleMouseButton(pos.x, pos.y, true, 0x8);");
    expect(changedLines(rfb, patched)).toBeLessThan(5);
  });

  it("is added to an rfb.js an older version patched for the long press only", () => {
    const patched = patchNoVncRfb(rfb)!;
    const longpressOnly = patched.replace(/( +)\/\* aio-agent: a pinch never zooms the remote page \*\/\n/, (_m, pad: string) => rfb.slice(rfb.indexOf(`${pad}magnitude = Math.hypot`), rfb.indexOf('this._handleKeyEvent(KeyTable.XK_Control_L, "ControlLeft", false);\n', rfb.indexOf(`${pad}magnitude = Math.hypot`)) + 'this._handleKeyEvent(KeyTable.XK_Control_L, "ControlLeft", false);\n'.length));
    expect(longpressOnly).toMatch(zoomsPage);
    expect(longpressOnly).toContain("/* aio-agent: a long press holds the left button */");
    expect(patchNoVncRfb(longpressOnly)).toBe(patched);
    expect(patchNoVncRfb(patched)).toBe(patched);
  });
});

describe("noVNC page", () => {
  // The line from the pinned image's vnc.html.
  const page = '<head>\n    <script type="module" crossorigin="anonymous" src="app/ui.js"></script>\n</head>';

  it("loads ui.js under the current asset version, upgrading an older one", () => {
    const patched = patchNoVncHtml(page)!;
    expect(patched).toContain(`src="app/ui.js?aio=${NOVNC_ASSET_VERSION}"`);
    expect(patchNoVncHtml(patched)).toBe(patched);
    expect(patchNoVncHtml(page.replace('app/ui.js"', 'app/ui.js?aio=1"'))).toBe(patched);
    expect(patchNoVncHtml("<html></html>")).toBeNull();
  });

  it("is opened by the console under the same version", () => {
    expect(DESKTOP_PATH).toContain(`&aio=${NOVNC_ASSET_VERSION}`);
  });
});

describe("noVNC under the console's toolbar", () => {
  it("adds the gesture layer's pointer to a desktop patched by the previous version", () => {
    const patched = patchNoVncUi(ui)!;
    const start = patched.indexOf("\n/* aio-agent: the console's gesture layer drives the pointer */");
    const older = patched.slice(0, start - 1) + patched.slice(patched.indexOf("\n/* aio-agent: the console hears that someone uses the desktop */") - 1);
    expect(older).not.toContain("gesture layer");
    expect(patchNoVncUi(older)).toContain("RFB.messages.pointerEvent(UI.rfb._sock, x, y, mask)");
    expect(patchNoVncUi(patchNoVncUi(older)!)).toBe(patchNoVncUi(older));
  });

  it("clicks, holds a button across moves and turns the wheel from the framing page only", () => {
    const patched = patchNoVncUi(ui)!;
    const marker = "/* aio-agent: the console's gesture layer drives the pointer */";
    const block = patched.slice(patched.indexOf(marker), patched.indexOf("/* aio-agent: the console hears that someone uses the desktop */"));
    const parent = {};
    let listener: ((e: { source: unknown; data: unknown }) => void) | null = null;
    const sent: Array<[number, number, number]> = [];
    const win = { parent, addEventListener: (_: string, fn: typeof listener) => { listener = fn; } };
    const UI = { rfb: { _rfbConnectionState: "connected", viewOnly: false, _fbWidth: 1281, _fbHeight: 1025, _sock: {} } };
    const RFB = { messages: { pointerEvent: (_sock: unknown, x: number, y: number, mask: number) => sent.push([x, y, mask]) } };
    new Function("window", "UI", "RFB", block)(win, UI, RFB);
    const post = (data: Record<string, unknown>, source: unknown = parent) => listener!({ source, data: { aio: "desktop", ...data } });
    post({ type: "click", x: 0.5, y: 0.25, button: "right" });
    expect(sent.splice(0)).toEqual([[640, 256, 0], [640, 256, 4], [640, 256, 0]]);
    post({ type: "pointer", phase: "down", x: 0, y: 0 });
    post({ type: "pointer", phase: "move", x: 1, y: 1 });
    post({ type: "pointer", phase: "up", x: 1, y: 1 });
    expect(sent.splice(0)).toEqual([[0, 0, 1], [1280, 1024, 1], [1280, 1024, 0]]);
    // 120 px down is two notches (the rest waits for the next turn); 60 px left is one.
    post({ type: "wheel", x: 0.5, y: 0.5, dx: -60, dy: 120 });
    expect(sent.splice(0)).toEqual([[640, 512, 0x10], [640, 512, 0], [640, 512, 0x10], [640, 512, 0], [640, 512, 0x20], [640, 512, 0]]);
    post({ type: "wheel", x: 0.5, y: 0.5, dx: 0, dy: 30 });
    expect(sent.splice(0)).toEqual([[640, 512, 0x10], [640, 512, 0]]);
    // Another window, or a view-only desktop, moves nothing.
    post({ type: "click", x: 0.5, y: 0.5 }, {});
    UI.rfb.viewOnly = true;
    post({ type: "click", x: 0.5, y: 0.5 });
    expect(sent).toEqual([]);
  });
  it("lets only the framing page hide the left bar and send keys, text and a paste", () => {
    const patched = patchNoVncUi(ui)!;
    expect(patched).toContain("/* aio-agent: the console's toolbar drives this desktop */");
    expect(patched).toContain("if (e.source !== window.parent || !m || m.aio !== 'desktop') return;");
    expect(patched).toContain("html.aio-host-bar #noVNC_control_bar_anchor");
    expect(patched).toContain("UI.rfb.clipboardPasteFrom(m.text.slice(0, 100000));");
    // Still a module that ends by exporting UI, and patched once.
    expect(patched.trimEnd().endsWith("export default UI;")).toBe(true);
    expect(patchNoVncUi(patched)).toBe(patched);
  });

  it("is added to a ui.js an older version patched for the keyboard only", () => {
    const patched = patchNoVncUi(ui)!;
    const start = patched.indexOf("\n/* aio-agent: the console's toolbar drives this desktop */");
    const older = patched.slice(0, start - 1) + patched.slice(patched.indexOf("\nexport default UI;\n"));
    expect(older).not.toContain("aio-host-bar");
    expect(patchNoVncUi(older)).toBe(patched);
  });
});

describe("noVNC activity report", () => {
  it("tells the embedding console that someone uses the desktop, throttled", () => {
    const patched = patchNoVncUi(ui)!;
    expect(patched).toContain("window.parent.postMessage({ aio: 'desktop', type: 'activity' }, '*');");
    expect(patched).toContain("if (now - reportedAt < 15000) return;");
    // A desktop patched before the report existed gets it on the next start.
    // Cut the block and the blank line the patch put before it.
    const before = patched.slice(0, patched.indexOf("\n/* aio-agent: the console hears that someone uses the desktop */") - 1) + "\nexport default UI;\n";
    expect(patchNoVncUi(before)).toBe(patched);
  });
});
