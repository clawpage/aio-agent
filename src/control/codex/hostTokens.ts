import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Config } from "../config.js";
import type { Logger } from "../../common/logger.js";
import { JsonRpcPeer } from "./jsonrpc.js";

export interface HostTokens {
  accessToken: string;
  chatgptAccountId: string;
  planType: string | null;
  expiresAt: number;
}

export interface HostAuthStatus {
  ok: boolean;
  authMethod: string | null;
  email: string | null;
  planType: string | null;
  expiresAt: number | null;
  error: string | null;
}

interface JwtClaims {
  exp?: number;
  email?: string;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
    chatgpt_plan_type?: string;
    chatgpt_user_id?: string;
  };
}

export function decodeJwtClaims(token: string): JwtClaims | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(payload) as JwtClaims;
  } catch {
    return null;
  }
}

/**
 * Supplies ChatGPT access tokens for the sandbox's external auth mode.
 *
 * The refresh is owned by the host Codex installation: we only call the official
 * `account/read {refreshToken:true}` + `getAuthStatus {includeToken:true}` methods on
 * a local host app-server. No OAuth endpoint is implemented here, the host
 * `~/.codex/auth.json` is never modified, and the refresh token never leaves the Mac.
 */
export class HostTokenSource {
  #cfg: Config;
  #log: Logger;
  #peer: JsonRpcPeer | null = null;
  #ready: Promise<JsonRpcPeer> | null = null;
  #cache: HostTokens | null = null;
  #inflight: Promise<HostTokens> | null = null;
  #lastError: string | null = null;
  #lastStatus: HostAuthStatus | null = null;

  constructor(cfg: Config, log: Logger) {
    this.#cfg = cfg;
    this.#log = log.child("host-codex");
  }

  #ensurePeer(): Promise<JsonRpcPeer> {
    if (this.#peer?.alive) return Promise.resolve(this.#peer);
    if (this.#ready) return this.#ready;
    this.#ready = (async () => {
      const child = spawn(this.#cfg.hostCodex.bin, ["app-server", "--listen", "stdio://"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, CODEX_HOME: this.#cfg.hostCodex.home },
      });
      const peer = new JsonRpcPeer(child, "host-codex");
      peer.on("closed", (reason) => {
        this.#log.warn("host codex app-server closed", { reason });
        this.#peer = null;
        this.#ready = null;
        this.#cache = null;
      });
      peer.on("warning", (message) => this.#log.debug("host codex warning", { message }));
      try {
        await peer.request(
          "initialize",
          { clientInfo: { name: "personal-agent", title: "Personal Agent", version: "0.1.0" }, capabilities: { experimentalApi: true } },
          this.#cfg.hostCodex.requestTimeoutMs,
        );
      } catch (err) {
        peer.close();
        throw err;
      }
      peer.notify("initialized");
      this.#peer = peer;
      this.#log.info("host codex app-server ready");
      return peer;
    })().catch((err) => {
      this.#ready = null;
      throw err;
    });
    return this.#ready;
  }

  #readAuthFileAccountId(): string | null {
    try {
      const file = path.join(this.#cfg.hostCodex.home, "auth.json");
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw) as { tokens?: { account_id?: string } };
      return parsed.tokens?.account_id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Return a usable access token, refreshing through the host Codex when the
   * cached token is missing or close to expiry. Concurrent callers share one refresh.
   */
  async getTokens(opts: { force?: boolean } = {}): Promise<HostTokens> {
    const skew = this.#cfg.hostCodex.tokenRefreshSkewMs;
    if (!opts.force && this.#cache && this.#cache.expiresAt - Date.now() > skew) {
      return this.#cache;
    }
    if (this.#inflight) return this.#inflight;
    this.#inflight = this.#refresh().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  async #refresh(): Promise<HostTokens> {
    const timeout = this.#cfg.hostCodex.requestTimeoutMs;
    try {
      const peer = await this.#ensurePeer();
      // Official managed refresh: host Codex rotates its own ChatGPT login if needed.
      await peer.request("account/read", { refreshToken: true }, timeout);
      const status = (await peer.request("getAuthStatus", { includeToken: true, refreshToken: false }, timeout)) as {
        authMethod?: string | null;
        authToken?: string | null;
      };
      if (status?.authMethod !== "chatgpt" || !status.authToken) {
        throw new Error(`host Codex is not logged in with ChatGPT (authMethod=${status?.authMethod ?? "none"})`);
      }
      const claims = decodeJwtClaims(status.authToken);
      const accountId = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id ?? this.#readAuthFileAccountId();
      if (!accountId) throw new Error("could not determine chatgpt account id from host token claims");
      const expiresAt = claims?.exp ? claims.exp * 1000 : Date.now() + 30 * 60_000;
      if (expiresAt <= Date.now()) {
        throw new Error("host Codex returned an already-expired access token; please re-run `codex login`");
      }
      const tokens: HostTokens = {
        accessToken: status.authToken,
        chatgptAccountId: accountId,
        planType: claims?.["https://api.openai.com/auth"]?.chatgpt_plan_type ?? null,
        expiresAt,
      };
      this.#cache = tokens;
      this.#lastError = null;
      this.#lastStatus = {
        ok: true,
        authMethod: "chatgpt",
        email: claims?.email ?? null,
        planType: tokens.planType,
        expiresAt,
        error: null,
      };
      this.#log.info("host chatgpt tokens refreshed", {
        accountIdLength: accountId.length,
        planType: tokens.planType,
        expiresInMinutes: Math.round((expiresAt - Date.now()) / 60000),
      });
      return tokens;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#lastError = message;
      this.#lastStatus = {
        ok: false,
        authMethod: this.#lastStatus?.authMethod ?? null,
        email: this.#lastStatus?.email ?? null,
        planType: this.#lastStatus?.planType ?? null,
        expiresAt: this.#lastStatus?.expiresAt ?? null,
        error: message,
      };
      this.#log.error("host token refresh failed", { error: message });
      throw new Error(`host Codex 认证不可用：${message}`);
    }
  }

  /** Secret-free health snapshot for /healthz and the UI. Never stays "ok" past expiry. */
  async status(): Promise<HostAuthStatus> {
    const now = Date.now();
    const fresh =
      this.#lastStatus?.ok &&
      this.#lastStatus.expiresAt !== null &&
      this.#lastStatus.expiresAt - now > this.#cfg.hostCodex.tokenRefreshSkewMs;
    if (fresh) return this.#lastStatus!;
    try {
      await this.getTokens();
      return (
        this.#lastStatus ?? {
          ok: false,
          authMethod: null,
          email: null,
          planType: null,
          expiresAt: null,
          error: this.#lastError,
        }
      );
    } catch (err) {
      return {
        ok: false,
        authMethod: null,
        email: null,
        planType: null,
        expiresAt: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  invalidate(): void {
    this.#cache = null;
  }

  close(): void {
    this.#peer?.close();
    this.#peer = null;
    this.#ready = null;
    this.#cache = null;
  }
}
