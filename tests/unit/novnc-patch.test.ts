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
  it("adds the host pinch relay to a desktop patched by the previous toolbar version", () => {
    const patched = patchNoVncUi(ui)!;
    const start = patched.indexOf("\n/* aio-agent: pinch scales the host preview */");
    const older = patched.slice(0, start - 1) + patched.slice(patched.indexOf("\nexport default UI;"));
    expect(patchNoVncUi(older)).toBe(patched);
    expect(patched).toContain("e.detail.type !== 'pinch'");
    expect(patched).toContain("e.stopImmediatePropagation();");
    expect(patched).toContain("ratio: magnitude / startMagnitude");
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
