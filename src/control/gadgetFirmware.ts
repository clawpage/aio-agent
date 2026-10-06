import fs from "node:fs";
import path from "node:path";

/**
 * The firmware the voice gadget updates itself to over Wi-Fi (an ESP-IDF app
 * image). One file, published with bin/publish-gadget-firmware.mjs; the gadget
 * reads what it is from GET /api/gadget/firmware and installs it when its app
 * ELF SHA-256 differs from the running one's.
 */
export const FIRMWARE_FILE = "muse-gadget.bin";

export interface FirmwareInfo {
  version: string;
  project: string;
  /** esp_app_desc_t.app_elf_sha256: what the gadget compares with the running image. */
  elfSha256: string;
  builtAt: string;
  size: number;
}

/** esp_image_header_t (24 bytes) + the first segment header (8), then esp_app_desc_t. */
const DESC = 32;
const IMAGE_MAGIC = 0xe9;
const DESC_MAGIC = 0xabcd5432;

const cString = (buf: Buffer, start: number, length: number) => {
  const raw = buf.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? raw.length : end).toString("utf8");
};

/** What an image says it is, or null if it is not an ESP-IDF app image. */
export function describeFirmware(head: Buffer, size: number): FirmwareInfo | null {
  if (head.length < DESC + 176 || head[0] !== IMAGE_MAGIC || head.readUInt32LE(DESC) !== DESC_MAGIC) return null;
  return {
    version: cString(head, DESC + 16, 32),
    project: cString(head, DESC + 48, 32),
    builtAt: `${cString(head, DESC + 96, 16)} ${cString(head, DESC + 80, 16)}`.trim(),
    elfSha256: head.subarray(DESC + 144, DESC + 176).toString("hex"),
    size,
  };
}

/** The published image in `dir`, or null when none is (or it is not an app image). */
export function readFirmware(dir: string): (FirmwareInfo & { file: string }) | null {
  const file = path.join(dir, FIRMWARE_FILE);
  let fd: number;
  try { fd = fs.openSync(file, "r"); } catch { return null; }
  try {
    const head = Buffer.alloc(512);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    const info = describeFirmware(head.subarray(0, read), fs.fstatSync(fd).size);
    return info ? { ...info, file } : null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Publishes `source` as the offered image: checked first, then swapped in whole. */
export function publishFirmware(dir: string, source: string): FirmwareInfo {
  const data = fs.readFileSync(source);
  const info = describeFirmware(data.subarray(0, 512), data.length);
  if (!info) throw new Error("不是 ESP-IDF 应用镜像");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${FIRMWARE_FILE}.${process.pid}.tmp`);
  fs.writeFileSync(temp, data, { mode: 0o600 });
  fs.renameSync(temp, path.join(dir, FIRMWARE_FILE));
  return info;
}
