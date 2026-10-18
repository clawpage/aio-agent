import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { Logger } from "../../src/common/logger.js";
import { VoiceLog } from "../../src/control/voiceLog.js";
import { wav } from "../../src/ui/src/voice.js";

const audio = Buffer.from(wav(new Float32Array(8000), 16_000));
const entry = (user: string) => ({ user, platform: null, audio, asr: null, polish: null, error: "x" });

it("keeps only the named accounts, or everyone's with *", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-log-"));
  const log = new VoiceLog(dir, ["owner"], 30, new Logger("error"));
  expect(log.record(entry("cr"))).toBeNull();
  expect(log.record(entry("owner"), new Date("2026-10-18T08:09:10Z"))).toMatch(/^2026-10-18\/080910-owner-[0-9a-f]{6}$/);
  expect(new VoiceLog(dir, ["*"], 30, new Logger("error")).wants("cr")).toBe(true);
  expect(new VoiceLog(dir, [], 30, new Logger("error")).wants("owner")).toBe(false);
});

it("deletes days older than the retention when a new day starts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-log-"));
  const log = new VoiceLog(dir, ["owner"], 2, new Logger("error"));
  for (const day of ["2026-10-01", "2026-10-15", "2026-10-16"]) log.record(entry("owner"), new Date(`${day}T12:00:00Z`));
  fs.writeFileSync(path.join(dir, "notes.txt"), "kept");
  log.record(entry("owner"), new Date("2026-10-18T12:00:00Z"));
  expect(fs.readdirSync(dir).sort()).toEqual(["2026-10-16", "2026-10-18", "notes.txt"]);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "2026-10-18", fs.readdirSync(path.join(dir, "2026-10-18")).find(f => f.endsWith(".json"))!), "utf8"));
  expect(meta.seconds).toBe(0.5);
});
