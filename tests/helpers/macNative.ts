import type { Config } from "../../src/control/config.js";
import type { Logger } from "../../src/common/logger.js";
import type { DeviceLinks } from "../../src/control/deviceLink.js";
import { PhoneGateway } from "../../src/control/phone.js";
import { UserBrowserGateway } from "../../src/control/userBrowser.js";
import { MacShellGateway } from "../../src/control/macShell.js";
import { MacNativeGateway } from "../../src/control/macNative.js";

/** The Mac's three parts and the one MCP server (aio_mac_native) the executor reaches them through, as src/control/index.ts builds them. */
export function macParts(opts: { cfg: Config; log: Logger; usernameOf: (userId: string) => string | null; userIdOf: (username: string) => string | null; links: DeviceLinks }) {
  const part = { cfg: opts.cfg, log: opts.log, userIdOf: opts.userIdOf, links: opts.links };
  const phone = new PhoneGateway(part);
  const browser = new UserBrowserGateway(part);
  const shell = new MacShellGateway(part);
  const native = new MacNativeGateway({ ...opts, port: 0, phone, browser, shell });
  return { phone, browser, shell, native };
}
