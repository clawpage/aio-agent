import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../common/logger.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** One voice input as it went: what was recorded, what the speech server heard, what the polisher made of it. */
export interface VoiceRecord {
  user: string;
  platform: string | null;
  /** What the console says recorded it: the microphone's name, the ones it could see, the hardware rate. */
  microphone: { used: string; inputs: string[]; rate: number | null } | null;
  audio: Buffer;
  asr: { url: string; model: string | null; ms: number; text: string; raw: string | null } | null;
  polish: { model: string; effort: string; ms: number; polished: boolean; text: string } | null;
  error: string | null;
}

/**
 * Keeps the named accounts' voice inputs (the WAV and a JSON beside it) so the
 * recognizer can be re-run on them later (bin/voice-replay.mjs). One folder per
 * day under `dir`; days older than `days` are deleted. Never throws: the log
 * must not break the voice input it records.
 */
export class VoiceLog {
  #lastPrune = "";

  constructor(
    private dir: string,
    private users: string[],
    private days: number,
    private log: Logger,
  ) {}

  wants(username: string): boolean {
    return this.users.includes("*") || this.users.includes(username);
  }

  record(r: VoiceRecord, at = new Date()): string | null {
    if (!this.wants(r.user)) return null;
    try {
      const iso = at.toISOString();
      const day = iso.slice(0, 10);
      const id = `${iso.slice(11, 19).replace(/:/g, "")}-${r.user}-${crypto.randomBytes(3).toString("hex")}`;
      const folder = path.join(this.dir, day);
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(folder, `${id}.wav`), r.audio, { mode: 0o600 });
      const { audio, ...rest } = r;
      const bytesPerSecond = audio.readUInt32LE(28) || 32_000;
      const meta = { id: `${day}/${id}`, at: iso, seconds: Math.round(((audio.byteLength - 44) / bytesPerSecond) * 10) / 10, ...rest };
      fs.writeFileSync(path.join(folder, `${id}.json`), JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });
      if (day !== this.#lastPrune) this.#prune(at);
      this.#lastPrune = day;
      return meta.id;
    } catch (err) {
      this.log.warn("voice log not written", { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  #prune(at: Date): void {
    const oldest = new Date(at.getTime() - this.days * 86_400_000).toISOString().slice(0, 10);
    for (const name of fs.readdirSync(this.dir)) {
      if (DAY.test(name) && name < oldest) fs.rmSync(path.join(this.dir, name), { recursive: true, force: true });
    }
  }
}
