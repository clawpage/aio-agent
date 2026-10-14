import { describe, expect, it } from "vitest";
import { parseCamera, splitCameraBlocks } from "../../src/ui/src/cameraBlocks";

describe("camera blocks", () => {
  it("reads a live card and a playback card", () => {
    expect(parseCamera('{"camera": "camera.c201_go2rtc"}')).toEqual({ camera: "camera.c201_go2rtc", at: null, title: null });
    expect(parseCamera('{"camera": "camera.c201_go2rtc", "at": "2026-10-13T20:38:10", "title": "客厅"}')).toEqual({ camera: "camera.c201_go2rtc", at: "2026-10-13 20:38:10", title: "客厅" });
    // A time that is not a local wall-clock time falls back to live rather than guessing.
    expect(parseCamera('{"camera": "camera.c201_go2rtc", "at": "yesterday"}')?.at).toBeNull();
  });

  it("leaves anything that is not a camera as a code block", () => {
    expect(parseCamera('{"camera": "light.kitchen"}')).toBeNull();
    expect(parseCamera('{"camera": "camera.x/../../api"}')).toBeNull();
    expect(parseCamera("camera.c201_go2rtc")).toBeNull();
    expect(splitCameraBlocks("```camera\nnot json\n```")).toEqual([{ kind: "text", text: "```camera\nnot json\n```" }]);
  });

  it("splits a message around its cards, in order", () => {
    const parts = splitCameraBlocks('8 点 38 分有人经过：\n```camera\n{"camera": "camera.c201_go2rtc", "at": "2026-10-13 20:38:10"}\n```\n要看直播：\n```camera\n{"camera": "camera.c201_go2rtc"}\n```');
    expect(parts.map((p) => p.kind)).toEqual(["text", "camera", "text", "camera"]);
    expect(parts[1]).toEqual({ kind: "camera", spec: { camera: "camera.c201_go2rtc", at: "2026-10-13 20:38:10", title: null } });
  });
});
