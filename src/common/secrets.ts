import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** `~` in a configured path means the service user's home. */
export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

/**
 * Read one `KEY=VALUE` entry from a private env-style file. The file is read,
 * never executed, and only the requested key is looked at; the value never
 * leaves the caller.
 *
 * A file another account or group can read is refused outright: the control
 * plane would otherwise turn a world-readable secret into a live credential.
 */
export function readSecretFile(
  filePath: string,
  keyName: string,
): { ok: true; value: string } | { ok: false; reason: string } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { ok: false, reason: `密钥文件不存在或不可读：${filePath}` };
  }
  if (!stat.isFile()) return { ok: false, reason: `密钥路径不是普通文件：${filePath}` };
  const mode = stat.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    return { ok: false, reason: `密钥文件权限过宽（${mode.toString(8)}），要求 600 或 400：${filePath}` };
  }
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return { ok: false, reason: `密钥文件读取失败：${filePath}` };
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq).trim() !== keyName) continue;
    let value = trimmed.slice(eq + 1).trim();
    // Tolerate `KEY="value"` / `KEY='value'` without any shell semantics.
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
    if (quoted) value = value.slice(1, -1);
    if (!value) return { ok: false, reason: `密钥文件里 ${keyName} 为空：${filePath}` };
    return { ok: true, value };
  }
  return { ok: false, reason: `密钥文件里没有 ${keyName}：${filePath}` };
}
