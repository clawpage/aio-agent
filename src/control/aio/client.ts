import type { Logger } from "../../common/logger.js";
import { t, type Messages } from "../i18n/index.js";

/** What the client needs of the sandbox: requests to its web port (through its node). */
export interface SandboxWeb {
  fetch(pathname: string, init?: RequestInit): Promise<Response>;
}

export interface CapabilityEndpoint {
  method: string;
  path: string;
  summary: string;
}

export interface CapabilityGroup {
  id: string;
  title: string;
  description: string;
  /** Native web UI paths on the companion origin, if the capability has one. */
  surfaces: Array<{ label: string; path: string; kind: "page" | "api" }>;
  endpoints: CapabilityEndpoint[];
  available: boolean | null;
  note?: string;
}

export interface CapabilityInventory {
  generatedAt: number;
  sandboxVersion: string | null;
  groups: CapabilityGroup[];
  openApiPathCount: number | null;
}

/**
 * Live view of the sandbox capabilities. The endpoint list is fetched from the
 * sandbox's own OpenAPI document so the inventory always reflects the pinned
 * image instead of upstream documentation.
 */
export class AioClient {
  #sandbox: SandboxWeb;
  #log: Logger;
  /** What the sandbox reported; grouped per call, so each reader gets their own language. */
  #cache: { at: number; paths: Record<string, Record<string, { summary?: string }>>; version: string | null } | null = null;

  constructor(log: Logger, sandbox: SandboxWeb) {
    this.#sandbox = sandbox;
    this.#log = log.child("aio");
  }

  async get(pathname: string, timeoutMs = 15_000): Promise<unknown> {
    const res = await this.#sandbox.fetch(pathname, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`${pathname} -> HTTP ${res.status}`);
    return await res.json();
  }

  async health(): Promise<boolean> {
    try {
      const res = await this.#sandbox.fetch(`/health`, { signal: AbortSignal.timeout(4000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async sandboxContext(): Promise<string | null> {
    try {
      const data = (await this.get("/v1/sandbox")) as { data?: string };
      return data.data ?? null;
    } catch {
      return null;
    }
  }

  async version(): Promise<string | null> {
    try {
      const res = await this.#sandbox.fetch(`/v1/openapi.json`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const doc = (await res.json()) as { info?: { version?: string } };
      return doc.info?.version ?? null;
    } catch {
      return null;
    }
  }

  async openApiPaths(): Promise<Record<string, Record<string, { summary?: string }>>> {
    const res = await this.#sandbox.fetch(`/v1/openapi.json`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`openapi -> HTTP ${res.status}`);
    const doc = (await res.json()) as { paths?: Record<string, Record<string, { summary?: string }>> };
    return doc.paths ?? {};
  }

  async mcpServers(): Promise<string[]> {
    try {
      const data = (await this.get("/v1/mcp/servers")) as { data?: string[] };
      return data.data ?? [];
    } catch {
      return [];
    }
  }

  async skills(): Promise<Array<{ name: string; description?: string }>> {
    try {
      const data = (await this.get("/v1/skills/metadatas")) as { data?: { skills?: Array<{ name: string; description?: string }> } };
      return data.data?.skills ?? [];
    } catch {
      return [];
    }
  }

  async jupyterInfo(): Promise<unknown> {
    try {
      return await this.get("/v1/jupyter/info");
    } catch {
      return null;
    }
  }

  async codeInfo(): Promise<unknown> {
    try {
      return await this.get("/v1/code/info");
    } catch {
      return null;
    }
  }

  /**
   * Create a real Chromium tab inside the sandbox and load `url` in it. This is
   * the only sandbox browser write the control plane performs on behalf of a
   * user click, and the URL is validated by the caller before it reaches here.
   */
  async createBrowserTab(url: string): Promise<BrowserTabResult> {
    let res: Response;
    let json: { success?: boolean; message?: string; data?: unknown } | null = null;
    try {
      res = await this.#sandbox.fetch(`/v1/browser/tabs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(15_000),
      });
      json = (await res.json().catch(() => null)) as { success?: boolean; message?: string; data?: unknown } | null;
    } catch (err) {
      return { ok: false, message: t().documents.aio.browserUnreachable(err instanceof Error ? err.message : String(err)) };
    }
    if (!res.ok) {
      return { ok: false, message: json?.message ?? t().documents.aio.sandboxHttp(res.status) };
    }
    if (!json || json.success === false) {
      return { ok: false, message: json?.message ?? t().documents.aio.tabUnconfirmed };
    }
    return { ok: true, message: json.message ?? t().documents.aio.opened, data: json.data ?? null };
  }

  async buildInventory(force = false): Promise<CapabilityInventory> {
    if (force || !this.#cache || Date.now() - this.#cache.at >= 60_000) {
      let paths: Record<string, Record<string, { summary?: string }>> = {};
      let version: string | null = null;
      try {
        paths = await this.openApiPaths();
        version = await this.version();
      } catch (err) {
        this.#log.warn("capability inventory unavailable", { error: String(err) });
      }
      this.#cache = { at: Date.now(), paths, version };
    }
    const { at, paths, version } = this.#cache;
    return {
      generatedAt: at,
      sandboxVersion: version,
      groups: groupEndpoints(paths),
      openApiPathCount: Object.keys(paths).length || null,
    };
  }
}

export interface BrowserTabResult {
  ok: boolean;
  message: string;
  data?: unknown;
}

/**
 * Parse a user-supplied link for the sandbox browser. Only absolute http/https
 * URLs without embedded credentials are accepted; everything else (javascript:,
 * data:, file:, mailto:, `user:pass@host`) is rejected before any sandbox call.
 */
export function parseHttpUrl(input: string): { ok: true; url: string } | { ok: false; message: string } {
  const value = input.trim();
  if (!value) return { ok: false, message: t().documents.aio.linkMissing };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, message: t().documents.aio.linkInvalid };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, message: t().documents.aio.linkHttpOnly };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, message: t().documents.aio.linkCredentials };
  }
  return { ok: true, url: parsed.href };
}

type GroupId = keyof Messages["documents"]["aio"]["groups"];
type SurfaceLabel = (m: Messages["documents"]["aio"]["surfaces"]) => string;

/** Titles, descriptions and surface labels are looked up when an inventory is built, in its reader's language. */
const GROUP_DEFS: Array<{
  id: Exclude<GroupId, "other">;
  match: (path: string) => boolean;
  surfaces: Array<{ label: SurfaceLabel; path: string; kind: "page" | "api" }>;
}> = [
  {
    id: "browser",
    match: (p) => p.startsWith("/v1/browser") || p.startsWith("/v1/display") || p === "/cdp" || p.startsWith("/json") || p.startsWith("/devtools"),
    surfaces: [
      { label: (m) => m.vnc, path: "/vnc/vnc.html?autoconnect=1&resize=scale&path=ws", kind: "page" },
      { label: (m) => m.browserUi, path: "/browser-ui", kind: "page" },
      { label: (m) => m.cdp, path: "/cdp/json/version", kind: "api" },
    ],
  },
  {
    id: "terminal",
    match: (p) => p.startsWith("/v1/shell") || p.startsWith("/v1/bash"),
    surfaces: [
      { label: (m) => m.terminal, path: "/terminal", kind: "page" },
      { label: () => "Shell WebSocket", path: "/v1/shell/ws", kind: "api" },
    ],
  },
  {
    id: "files",
    match: (p) => p.startsWith("/v1/file"),
    surfaces: [],
  },
  {
    id: "editor",
    match: (p) => p.startsWith("/code-server"),
    surfaces: [{ label: () => "code-server", path: "/code-server/", kind: "page" }],
  },
  {
    id: "notebook",
    match: (p) => p.startsWith("/v1/jupyter") || p.startsWith("/v1/code") || p.startsWith("/v1/nodejs"),
    surfaces: [
      { label: () => "JupyterLab", path: "/jupyter/lab", kind: "page" },
      { label: (m) => m.kernel, path: "/v1/jupyter/info", kind: "api" },
    ],
  },
  {
    id: "mcp",
    match: (p) => p.startsWith("/v1/mcp") || p.startsWith("/v1/skills"),
    surfaces: [{ label: (m) => m.mcp, path: "/mcp", kind: "api" }],
  },
  {
    id: "sandbox",
    match: (p) => p.startsWith("/v1/sandbox") || p.startsWith("/v1/proxy") || p.startsWith("/v1/util"),
    surfaces: [],
  },
];

export function groupEndpoints(paths: Record<string, Record<string, { summary?: string }>>): CapabilityGroup[] {
  const all: Array<CapabilityEndpoint & { group: string }> = [];
  for (const [path, ops] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(ops)) {
      const group = GROUP_DEFS.find((g) => g.match(path))?.id ?? "other";
      all.push({ method: method.toUpperCase(), path, summary: op?.summary ?? "", group });
    }
  }
  const words = t().documents.aio;
  const groups: CapabilityGroup[] = GROUP_DEFS.map((def) => {
    const endpoints = all.filter((e) => e.group === def.id).map(({ method, path, summary }) => ({ method, path, summary }));
    return {
      id: def.id,
      title: words.groups[def.id].title,
      description: words.groups[def.id].description,
      surfaces: def.surfaces.map(({ label, path, kind }) => ({ label: label(words.surfaces), path, kind })),
      endpoints,
      available: endpoints.length > 0 ? true : null,
    };
  });
  const other = all.filter((e) => e.group === "other");
  if (other.length) {
    groups.push({
      id: "other",
      title: words.groups.other.title,
      description: words.groups.other.description,
      surfaces: [],
      endpoints: other.map(({ method, path, summary }) => ({ method, path, summary })),
      available: true,
    });
  }
  return groups;
}
