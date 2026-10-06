#!/usr/bin/env node
// Local administrator command: offer an ESP-IDF app image (the voice gadget's firmware) for its Wi-Fi update.
// The gadget installs it at its next check (every 10 minutes, while idle) when it differs from what it runs.
import { loadConfig } from '../dist/control/config.js';
import { publishFirmware } from '../dist/control/gadgetFirmware.js';

const [source] = process.argv.slice(2);
if (!source) throw new Error('用法: node bin/publish-gadget-firmware.mjs <muse-gadget.bin>');
const info = publishFirmware(loadConfig().gadgetFirmwareDir, source);
console.log(`已发布 ${info.project} ${info.version}（${info.builtAt}，${info.size} 字节，ELF SHA-256 ${info.elfSha256.slice(0, 12)}…）`);
