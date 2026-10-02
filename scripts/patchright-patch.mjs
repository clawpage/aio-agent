// patchright-core 1.63 rewrote Frame._context: it fetches a frame's execution
// context with a CDP call and, when that yields nothing, retries itself unless
// the frame is detached. A crashed renderer (or a closed session) fails every
// CDP call at once without detaching the frame, so the retry never yields: one
// tab that crashed before anything read it spins the tab server's event loop
// forever, and every task's browser tools stop with it. The patch fails such a
// call the way a detached frame does. The build refuses a version it does not fit.
import fs from "node:fs";
import path from "node:path";

const MARK = "/* aio: fail on a dead session */";
const RETRY = /^( *)if \(this\._isDetached\(\)\) throw new Error\("Frame was detached"\);\n\1return this\._context\(world\);$/gm;
const DEAD = "client._crashed || client._closed || client._connection._closed || client._connection._browserDisconnectedLogs";

/** Patch the package unpacked at `packageDir` in place (idempotent). */
export function patchPatchright(packageDir) {
  const file = path.join(packageDir, "lib", "coreBundle.js");
  const source = fs.readFileSync(file, "utf8");
  if (source.includes(MARK)) return;
  let count = 0;
  const patched = source.replace(RETRY, (match, pad) => {
    count += 1;
    const [detached, retry] = match.split("\n");
    return `${detached}\n${pad}if (${DEAD}) throw new Error(client._crashed ? "Target crashed" : "Target closed"); ${MARK}\n${retry}`;
  });
  if (count !== 2) throw new Error(`patchright-core: expected 2 context retries to patch, found ${count}; re-check scripts/patchright-patch.mjs for this version`);
  fs.writeFileSync(file, patched);
}
