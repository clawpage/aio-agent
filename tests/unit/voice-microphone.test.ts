import { expect, it } from "vitest";
import { builtInMicrophone, mobileOs } from "../../src/ui/src/voice.js";

it("knows phones and tablets, including an iPad that says Macintosh", () => {
  expect(mobileOs("Mozilla/5.0 (Linux; Android 15; SM-F741U1) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36")).toBe("android");
  expect(mobileOs("Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148")).toBe("ios");
  expect(mobileOs("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15", 5)).toBe("ios");
  expect(mobileOs("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15", 0)).toBeNull();
  expect(mobileOs("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0 Safari/537.36")).toBeNull();
});

it("picks the Android phone's own microphone, speakerphone first, never a headset", () => {
  const inputs = [
    { deviceId: "default", label: "" },
    { deviceId: "bt", label: "Bluetooth headset" },
    { deviceId: "wired", label: "Wired headset" },
    { deviceId: "ear", label: "Headset earpiece" },
    { deviceId: "spk", label: "Speakerphone" },
    { deviceId: "usb", label: "USB audio" },
  ];
  expect(builtInMicrophone("android", inputs)).toBe("spk");
  expect(builtInMicrophone("android", inputs.filter(d => d.deviceId !== "spk"))).toBe("ear");
  expect(builtInMicrophone("android", inputs.filter(d => !["spk", "ear"].includes(d.deviceId)))).toBeNull();
  // Before the microphone is allowed, names are empty: nothing to go on.
  expect(builtInMicrophone("android", inputs.map(d => ({ ...d, label: "" })))).toBeNull();
});

it("picks the iPhone's own microphone in any language, never AirPods or a headset", () => {
  expect(builtInMicrophone("ios", [{ deviceId: "a", label: "Mengxiao's AirPods Pro" }, { deviceId: "b", label: "iPhone Microphone" }])).toBe("b");
  expect(builtInMicrophone("ios", [{ deviceId: "a", label: "AirPods" }, { deviceId: "b", label: "iPhone 麦克风" }])).toBe("b");
  expect(builtInMicrophone("ios", [{ deviceId: "b", label: "iPad 麥克風" }])).toBe("b");
  expect(builtInMicrophone("ios", [{ deviceId: "c", label: "Headset Microphone" }, { deviceId: "d", label: "耳机麦克风" }, { deviceId: "e", label: "Bose QC45" }])).toBeNull();
});
