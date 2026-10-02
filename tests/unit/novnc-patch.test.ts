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
    expect(changedLines(ui, patched)).toBeLessThan(25);
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
