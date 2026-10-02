import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { patchNoVncUi } from "../../src/server/docker/novncPatch.js";

// app/ui.js exactly as the pinned image ships it (noVNC 1.4.0).
const upstream = fs.readFileSync(new URL("../fixtures/novnc-ui-1.4.0.js", import.meta.url), "utf8");

describe("noVNC phone keyboard patch", () => {
  it("makes the input event skip keys the touch keyboard already sent", () => {
    const patched = patchNoVncUi(upstream)!;
    expect(patched).not.toBe(upstream);
    expect(patched).toContain("if (down) UI.recentTouchKeys.push({ keysym, at: Date.now() });");
    expect(patched).toContain("if (UI.takeTouchKey(keysym)) continue;");
    expect(patched).toContain("if (UI.takeTouchKey(KeyTable.XK_BackSpace)) continue;");
    // Everything else stays as shipped.
    expect(patched.length - upstream.length).toBeLessThan(1200);
    expect(patched.split("\n").filter((l) => !upstream.includes(l)).length).toBeLessThan(25);
  });

  it("applies once", () => {
    const patched = patchNoVncUi(upstream)!;
    expect(patchNoVncUi(patched)).toBe(patched);
  });

  it("refuses a noVNC whose code it does not know rather than half-patching it", () => {
    expect(patchNoVncUi(upstream.replace('UI.rfb.sendKey(KeyTable.XK_BackSpace, "Backspace");', "UI.rfb.sendKey(KeyTable.XK_BackSpace);"))).toBeNull();
    expect(patchNoVncUi("export default {};")).toBeNull();
  });
});
