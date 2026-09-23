import type { Config } from "../config.js";
import type { Logger } from "../logger.js";

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
  #cfg: Config;
  #log: Logger;
  #cache: { at: number; inventory: CapabilityInventory } | null = null;

  constructor(cfg: Config, log: Logger) {
    this.#cfg = cfg;
    this.#log = log.child("aio");
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.#cfg.sandbox.hostPort}`;
  }

  async get(pathname: string, timeoutMs = 15_000): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${pathname}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`${pathname} -> HTTP ${res.status}`);
    return await res.json();
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(4000) });
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
      const res = await fetch(`${this.baseUrl}/v1/openapi.json`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const doc = (await res.json()) as { info?: { version?: string } };
      return doc.info?.version ?? null;
    } catch {
      return null;
    }
  }

  async openApiPaths(): Promise<Record<string, Record<string, { summary?: string }>>> {
    const res = await fetch(`${this.baseUrl}/v1/openapi.json`, { signal: AbortSignal.timeout(10_000) });
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
      res = await fetch(`${this.baseUrl}/v1/browser/tabs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(15_000),
      });
      json = (await res.json().catch(() => null)) as { success?: boolean; message?: string; data?: unknown } | null;
    } catch (err) {
      return { ok: false, message: `无法连接沙箱浏览器：${err instanceof Error ? err.message : String(err)}` };
    }
    if (!res.ok) {
      return { ok: false, message: json?.message ?? `沙箱返回 HTTP ${res.status}` };
    }
    if (!json || json.success === false) {
      return { ok: false, message: json?.message ?? "沙箱未确认新标签页已创建" };
    }
    return { ok: true, message: json.message ?? "已打开", data: json.data ?? null };
  }

  async buildInventory(force = false): Promise<CapabilityInventory> {
    if (!force && this.#cache && Date.now() - this.#cache.at < 60_000) return this.#cache.inventory;

    let paths: Record<string, Record<string, { summary?: string }>> = {};
    let version: string | null = null;
    try {
      paths = await this.openApiPaths();
      version = await this.version();
    } catch (err) {
      this.#log.warn("capability inventory unavailable", { error: String(err) });
    }

    const groups = groupEndpoints(paths);
    const inventory: CapabilityInventory = {
      generatedAt: Date.now(),
      sandboxVersion: version,
      groups,
      openApiPathCount: Object.keys(paths).length || null,
    };
    this.#cache = { at: Date.now(), inventory };
    return inventory;
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
  if (!value) return { ok: false, message: "缺少链接地址" };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, message: "链接地址无效" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, message: "只允许 http/https 链接" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, message: "链接不能包含用户名或密码" };
  }
  return { ok: true, url: parsed.href };
}

const GROUP_DEFS: Array<{
  id: string;
  title: string;
  description: string;
  match: (path: string) => boolean;
  surfaces: Array<{ label: string; path: string; kind: "page" | "api" }>;
}> = [
  {
    id: "browser",
    title: "浏览器与桌面",
    description: "真实 Chromium 浏览器、CDP 调试与 VNC 桌面，可在手机上进行触摸操作。",
    match: (p) => p.startsWith("/v1/browser") || p.startsWith("/v1/display") || p === "/cdp" || p.startsWith("/json") || p.startsWith("/devtools"),
    surfaces: [
      { label: "浏览器桌面（VNC）", path: "/vnc/vnc.html?autoconnect=1&resize=scale&path=ws", kind: "page" },
      { label: "浏览器控制台", path: "/browser-ui", kind: "page" },
      { label: "CDP 信息", path: "/cdp/json/version", kind: "api" },
    ],
  },
  {
    id: "terminal",
    title: "终端与 Shell",
    description: "交互式终端会话、后台进程、等待与写入。",
    match: (p) => p.startsWith("/v1/shell") || p.startsWith("/v1/bash"),
    surfaces: [
      { label: "交互终端", path: "/terminal", kind: "page" },
      { label: "Shell WebSocket", path: "/v1/shell/ws", kind: "api" },
    ],
  },
  {
    id: "files",
    title: "文件管理",
    description: "在沙箱内任意路径浏览、读写、搜索、上传与下载文件。",
    match: (p) => p.startsWith("/v1/file"),
    surfaces: [],
  },
  {
    id: "editor",
    title: "代码编辑器",
    description: "code-server（VS Code Web），可直接编辑沙箱内项目。",
    match: (p) => p.startsWith("/code-server"),
    surfaces: [{ label: "code-server", path: "/code-server/", kind: "page" }],
  },
  {
    id: "notebook",
    title: "Jupyter 笔记本",
    description: "JupyterLab 与多内核代码执行（Python 3.10/3.11/3.12）。",
    match: (p) => p.startsWith("/v1/jupyter") || p.startsWith("/v1/code") || p.startsWith("/v1/nodejs"),
    surfaces: [
      { label: "JupyterLab", path: "/jupyter/lab", kind: "page" },
      { label: "内核信息", path: "/v1/jupyter/info", kind: "api" },
    ],
  },
  {
    id: "mcp",
    title: "MCP 与技能",
    description: "MCP 服务器与工具调用、技能注册与读取。",
    match: (p) => p.startsWith("/v1/mcp") || p.startsWith("/v1/skills"),
    surfaces: [{ label: "MCP 端点", path: "/mcp", kind: "api" }],
  },
  {
    id: "sandbox",
    title: "沙箱与预览",
    description: "环境信息、包列表、端口映射、代理与页面预览。",
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
  const groups: CapabilityGroup[] = GROUP_DEFS.map((def) => {
    const endpoints = all.filter((e) => e.group === def.id).map(({ method, path, summary }) => ({ method, path, summary }));
    return {
      id: def.id,
      title: def.title,
      description: def.description,
      surfaces: def.surfaces,
      endpoints,
      available: endpoints.length > 0 ? true : null,
    };
  });
  const other = all.filter((e) => e.group === "other");
  if (other.length) {
    groups.push({
      id: "other",
      title: "其他接口",
      description: "沙箱提供的其余 REST 接口。",
      surfaces: [],
      endpoints: other.map(({ method, path, summary }) => ({ method, path, summary })),
      available: true,
    });
  }
  return groups;
}
