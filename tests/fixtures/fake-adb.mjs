/**
 * Stands in for adb in tests/integration/mac-env.test.ts: the phones "plugged in"
 * are whatever FAKE_ADB_STATE (a JSON file) lists now, so a test plugs and unplugs
 * them by rewriting it. Answers only what bin/phone-bridge.mjs asks of adb.
 */
import fs from "node:fs";

const phones = (() => { try { return JSON.parse(fs.readFileSync(process.env.FAKE_ADB_STATE, "utf8")).phones ?? []; } catch { return []; } })();
const args = process.argv.slice(2);
if (args[0] === "devices") {
  process.stdout.write(`List of devices attached\n${phones.map((p) => `${p.serial}           device usb:1-1 product:x model:${p.model} device:x transport_id:1\n`).join("")}\n`);
} else if (args[0] === "-s") {
  const phone = phones.find((p) => p.serial === args[1]);
  if (!phone) { process.stderr.write(`adb: device '${args[1]}' not found\n`); process.exit(1); }
  const cmd = args.slice(2).join(" ");
  if (cmd === "shell getprop ro.product.model") process.stdout.write(`${phone.model}\n`);
  else if (cmd === "shell getprop ro.build.version.release") process.stdout.write("14\n");
  else if (cmd === "shell settings get global device_name") process.stdout.write(`${phone.name ?? "null"}\n`);
}
