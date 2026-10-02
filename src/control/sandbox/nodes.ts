import type { Db } from "../db.js";
import type { Config } from "../config.js";
import { readSecretFile } from "../../common/secrets.js";
import { SandboxNode } from "./node.js";

/** Fallback key in the tokens file when a node has no token of its own. */
export const NODE_TOKEN_KEY = "AIO_SANDBOX_NODE_TOKEN";

/**
 * The sandbox nodes this control plane drives, and which account lives on which.
 * An account stays on its node for good (its volumes are there); a new account
 * goes to the node with the most room.
 */
export class SandboxNodes {
  readonly nodes: SandboxNode[];

  constructor(cfg: Config) {
    const file = cfg.sandboxNodes.tokensFile;
    this.nodes = cfg.sandboxNodes.nodes.map(({ name, url }) => {
      const own = readSecretFile(file, name);
      const shared = own.ok ? own : readSecretFile(file, NODE_TOKEN_KEY);
      return new SandboxNode(name, url, process.env[NODE_TOKEN_KEY]?.trim() || (shared.ok ? shared.value : ""));
    });
    if (!this.nodes.length) throw new Error("PA_SANDBOX_NODES lists no sandbox node");
  }

  get(name: string): SandboxNode | undefined {
    return this.nodes.find((n) => n.name === name);
  }

  /**
   * The node an account's sandbox lives on, recorded in the root database.
   * `existing` marks an account whose sandbox predates node assignment (it is on
   * the first node). A recorded node that is no longer configured fails closed:
   * the account's data is there, so it is never silently recreated elsewhere.
   */
  async assign(db: Db, userId: string, existing: boolean): Promise<SandboxNode> {
    const key = `sandbox_node:${userId}`;
    const row = db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined;
    if (row) {
      const node = this.get(row.value);
      if (!node) throw new Error(`账号的沙箱在节点 ${row.value} 上，但该节点不在 PA_SANDBOX_NODES 中`);
      return node;
    }
    const node = existing || this.nodes.length === 1 ? this.nodes[0]! : await this.#roomiest();
    db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING").run(key, node.name);
    return node;
  }

  async #roomiest(): Promise<SandboxNode> {
    const scored = await Promise.all(
      this.nodes.map(async (node) => {
        const compat = await node.check(0);
        if (!compat.ok) return { node, room: -1 };
        const info = await node.info().catch(() => null);
        return { node, room: info?.memAvailable ?? 0 };
      }),
    );
    const best = scored.filter((s) => s.room >= 0).sort((a, b) => b.room - a.room)[0];
    if (!best) throw new Error("没有可用的沙箱节点");
    return best.node;
  }
}
