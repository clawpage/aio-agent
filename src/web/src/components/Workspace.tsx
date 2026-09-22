import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { CapabilitiesResponse, FileEntry, StatusResponse } from "../types";

interface Props {
  open: boolean;
  status: StatusResponse | null;
  initialPath?: string;
  onClose: () => void;
  onNotify: (message: string, level?: "info" | "error") => void;
}

type TabId = "desktop" | "browser" | "terminal" | "files" | "editor" | "notebook" | "preview" | "api";

const TABS: Array<{ id: TabId; label: string; path?: string; kind: "frame" | "native" }> = [
  { id: "desktop", label: "桌面", path: "/vnc/vnc.html?autoconnect=1&resize=scale&path=ws", kind: "frame" },
  { id: "browser", label: "浏览器", path: "/browser-ui", kind: "frame" },
  { id: "terminal", label: "终端", path: "/terminal", kind: "frame" },
  { id: "files", label: "文件", kind: "native" },
  { id: "editor", label: "编辑器", path: "/code-server/", kind: "frame" },
  { id: "notebook", label: "笔记本", path: "/jupyter/lab", kind: "frame" },
  { id: "preview", label: "预览", kind: "native" },
  { id: "api", label: "接口与 MCP", kind: "native" },
];

export function Workspace({ open, status, initialPath, onClose, onNotify }: Props) {
  const [tab, setTab] = useState<TabId>("browser");
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [sessionReady, setSessionReady] = useState(false);
  const [originHint, setOriginHint] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const [previewPath, setPreviewPath] = useState("/");
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [frameStatus, setFrameStatus] = useState<"idle" | "loading" | "loaded" | "timeout">("idle");
  const origin = status?.workspaceOrigin ?? originHint;
  const bootstrapping = useRef(false);

  /**
   * Load a companion path. While no verified companion session exists we redeem a
   * short-lived one-time ticket through /_bootstrap (which is a top-level
   * navigation, so it also works inside an iframe). `sessionReady` is only set
   * once a frame actually reports load, never merely because a ticket was issued.
   */
  const ensureSession = useCallback(
    async (nextPath: string): Promise<string | null> => {
      if (sessionReady && origin) return `${origin}${nextPath}`;
      if (bootstrapping.current) return null;
      bootstrapping.current = true;
      try {
        const ticket = await api.ticket(nextPath);
        setOriginHint(ticket.origin);
        return ticket.url;
      } catch (err) {
        onNotify(err instanceof Error ? err.message : String(err), "error");
        return null;
      } finally {
        bootstrapping.current = false;
      }
    },
    [onNotify, origin, sessionReady],
  );

  /** Verify the companion cookie really works; used on mount and after expiry. */
  const verifyCompanionSession = useCallback(
    async (base: string): Promise<boolean> => {
      try {
        const res = await fetch(`${base}/api/workspace/session`, { credentials: "include" });
        if (!res.ok) return false;
        const body = (await res.json()) as { authenticated?: boolean };
        return body.authenticated === true;
      } catch {
        return false;
      }
    },
    [],
  );

  /** Renew the companion cookie from the control plane (dedicated CORS-enabled endpoint). */
  const renewCompanionSession = useCallback(
    async (base: string): Promise<void> => {
      try {
        await fetch(`${base}/api/workspace/refresh`, { method: "POST", credentials: "include" });
      } catch {
        /* a failed renew simply means the next frame load bootstraps again */
      }
    },
    [],
  );

  const showTab = useCallback(
    async (id: TabId) => {
      setTab(id);
      const def = TABS.find((t) => t.id === id);
      if (!def || def.kind !== "frame" || !def.path) return;
      const src = await ensureSession(def.path);
      if (src) {
        setFrameSrc(src);
        setFrameKey((k) => k + 1);
      }
    },
    [ensureSession],
  );

  const openedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      openedRef.current = false;
      return;
    }
    if (openedRef.current) return;
    openedRef.current = true;
    void (async () => {
      // Trust an existing companion cookie only if it actually authenticates.
      if (origin) {
        const valid = await verifyCompanionSession(origin);
        setSessionReady(valid);
        if (!valid) setSessionReady(false);
      }
      if (initialPath && initialPath.startsWith("/")) {
        setPreviewPath(initialPath);
        setTab("preview");
        const src = await ensureSession(initialPath);
        setSessionReady(true);
        setPreviewSrc(src ?? (origin ? `${origin}${initialPath}` : null));
        return;
      }
      await showTab("browser");
    })();
  }, [ensureSession, initialPath, open, origin, showTab, verifyCompanionSession]);

  // Renew the companion session periodically and when the tab comes back.
  useEffect(() => {
    if (!open || !origin || !sessionReady) return;
    const timer = window.setInterval(() => void renewCompanionSession(origin), 10 * 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void renewCompanionSession(origin);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [open, origin, renewCompanionSession, sessionReady]);

  // The load event is authoritative; the timer only covers a frame that never fires it.
  useEffect(() => {
    if (!frameSrc) return;
    setFrameStatus("loading");
    const timer = window.setTimeout(
      () =>
        setFrameStatus((prev) => {
          if (prev !== "loading") return prev;
          // Force a fresh one-time ticket on the next attempt.
          setSessionReady(false);
          return "timeout";
        }),
      12000,
    );
    return () => window.clearTimeout(timer);
  }, [frameSrc, frameKey]);

  const openExternal = useCallback(
    async (path: string) => {
      const src = sessionReady && origin ? `${origin}${path}` : await ensureSession(path);
      if (src) window.open(src, "_blank", "noopener,noreferrer");
    },
    [ensureSession, origin, sessionReady],
  );

  const currentDef = TABS.find((t) => t.id === tab);

  if (!open) return null;

  return (
    <section className={`workspace ${fullscreen ? "fullscreen" : ""}`}>
      <header className="ws-head">
        <nav className="ws-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? "active" : ""}
              onClick={() => void showTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="ws-actions">
          {currentDef?.path && (
            <button type="button" className="ghost" onClick={() => void openExternal(currentDef.path!)}>
              新标签页
            </button>
          )}
          <button type="button" className="ghost" onClick={() => setFullscreen((v) => !v)}>
            {fullscreen ? "退出全屏" : "全屏"}
          </button>
          <button type="button" className="ghost" onClick={onClose} aria-label="关闭工作区">
            关闭
          </button>
        </div>
      </header>

      <div className="ws-body">
        {tab === "files" && <FilesTab notify={onNotify} />}
        {tab === "preview" && (
          <div className="preview">
            <div className="row">
              <input
                value={previewPath}
                onChange={(e) => setPreviewPath(e.target.value)}
                placeholder="路径（/jupyter/lab）或端口（3000）"
              />
              <button
                type="button"
                className="primary"
                onClick={() => {
                  void (async () => {
                    const path = normalizePreviewTarget(previewPath);
                    const src = sessionReady && origin ? `${origin}${path}` : await ensureSession(path);
                    setPreviewSrc(src);
                  })();
                }}
              >
                打开
              </button>
              <button type="button" className="ghost" onClick={() => void openExternal(normalizePreviewTarget(previewPath))}>
                新标签页
              </button>
            </div>
            <p className="muted tiny">
              端口会通过沙箱的代理入口打开（例如 3000 → <code>/proxy/3000/</code>），用于访问你在沙箱里启动的服务。
            </p>
            {previewSrc ? (
              <iframe key={previewSrc} src={previewSrc} title="预览" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads" />
            ) : (
              <p className="muted">输入沙箱内的路径（例如 /jupyter/lab 或你自己生成的 HTML 文件）。</p>
            )}
          </div>
        )}
        {tab === "api" && <ApiTab notify={onNotify} />}
        {TABS.find((t) => t.id === tab)?.kind === "frame" && (
          <>
            {frameSrc ? (
              <iframe
                key={frameKey}
                src={frameSrc}
                title={currentDef?.label ?? "沙箱"}
                allow="clipboard-read; clipboard-write; fullscreen"
                onLoad={() => {
                  setFrameStatus("loaded");
                  setSessionReady(true);
                }}
              />
            ) : (
              <p className="muted">正在建立工作区会话…</p>
            )}
            {frameStatus === "timeout" && (
              <div className="frame-hint">
                页面加载超时。
                <button type="button" className="link" onClick={() => currentDef?.path && void openExternal(currentDef.path)}>
                  在新标签页打开
                </button>
                <button type="button" className="link" onClick={() => void showTab(tab)}>
                  重试
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function FilesTab({ notify }: { notify: (message: string, level?: "info" | "error") => void }) {
  const [path, setPath] = useState("/home/gem/workspace");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<{ path: string; content: string } | null>(null);
  const [newName, setNewName] = useState("");
  const uploadRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(
    async (target: string) => {
      setLoading(true);
      try {
        const data = await api.listFiles(target);
        setEntries(data.files ?? []);
        setPath(data.path ?? target);
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), "error");
      } finally {
        setLoading(false);
      }
    },
    [notify],
  );

  useEffect(() => {
    void load("/home/gem/workspace");
  }, [load]);

  const parent = useMemo(() => path.replace(/\/[^/]+\/?$/, "") || "/", [path]);

  return (
    <div className="files">
      <div className="row">
        <button type="button" className="ghost" onClick={() => void load(parent)} disabled={path === "/"}>
          上一级
        </button>
        <input value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void load(path)} />
        <button type="button" className="ghost" onClick={() => void load(path)}>
          刷新
        </button>
      </div>
      <div className="row">
        <input placeholder="新建文件/目录名" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button
          type="button"
          className="ghost"
          onClick={() => {
            if (!newName.trim()) return;
            void (async () => {
              try {
                await api.writeFile(`${path}/${newName.trim()}`, "");
                setNewName("");
                await load(path);
              } catch (err) {
                notify(err instanceof Error ? err.message : String(err), "error");
              }
            })();
          }}
        >
          新建文件
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            if (!newName.trim()) return;
            void (async () => {
              try {
                await api.mkdir(`${path}/${newName.trim()}`);
                setNewName("");
                await load(path);
              } catch (err) {
                notify(err instanceof Error ? err.message : String(err), "error");
              }
            })();
          }}
        >
          新建目录
        </button>
        <input
          ref={uploadRef}
          type="file"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            void (async () => {
              try {
                const uploaded = await api.upload(file, path);
                notify(`已上传到 ${path} → ${uploaded.path}`);
                await load(path);
              } catch (err) {
                notify(err instanceof Error ? err.message : String(err), "error");
              }
            })();
          }}
        />
        <button type="button" className="ghost" onClick={() => uploadRef.current?.click()}>
          上传
        </button>
      </div>

      <ul className="file-list">
        {loading && <li className="muted">加载中…</li>}
        {!loading && entries.length === 0 && <li className="muted">空目录</li>}
        {entries.map((entry) => (
          <li key={entry.path}>
            <button
              type="button"
              className="file-name"
              onClick={() => {
                if (entry.is_directory) void load(entry.path);
                else
                  void (async () => {
                    try {
                      const data = await api.readFile(entry.path);
                      setEditing({ path: data.path, content: data.content });
                    } catch (err) {
                      notify(err instanceof Error ? err.message : String(err), "error");
                    }
                  })();
              }}
            >
              {entry.is_directory ? "📁" : "📄"} {entry.name}
            </button>
            <span className="file-size">{entry.is_directory ? "" : formatSize(entry.size)}</span>
            {!entry.is_directory && (
              <a className="link" href={api.downloadUrl(entry.path)} download>
                下载
              </a>
            )}
            <button
              type="button"
              className="link danger-text"
              onClick={() => {
                const label = entry.is_directory ? "目录及其全部内容" : "文件";
                if (!window.confirm(`确定删除${label}？\n${entry.path}`)) return;
                void (async () => {
                  try {
                    await api.deleteFile(entry.path);
                    await load(path);
                  } catch (err) {
                    notify(err instanceof Error ? err.message : String(err), "error");
                  }
                })();
              }}
            >
              删除
            </button>
          </li>
        ))}
      </ul>

      {editing && (
        <div className="editor">
          <div className="row">
            <strong>{editing.path}</strong>
            <span className="spacer" />
            <button
              type="button"
              className="primary"
              onClick={() => {
                void (async () => {
                  try {
                    await api.writeFile(editing.path, editing.content);
                    notify("已保存");
                    setEditing(null);
                    await load(path);
                  } catch (err) {
                    notify(err instanceof Error ? err.message : String(err), "error");
                  }
                })();
              }}
            >
              保存
            </button>
            <button type="button" className="ghost" onClick={() => setEditing(null)}>
              关闭
            </button>
          </div>
          <textarea value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} spellCheck={false} />
        </div>
      )}
    </div>
  );
}

function ApiTab({ notify }: { notify: (message: string, level?: "info" | "error") => void }) {
  const [caps, setCaps] = useState<CapabilitiesResponse | null>(null);
  const [method, setMethod] = useState("GET");
  const [path, setPath] = useState("/v1/sandbox");
  const [body, setBody] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setCaps(await api.capabilities());
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), "error");
      }
    })();
  }, [notify]);

  return (
    <div className="caps">
      <div className="cap-groups">
        {caps?.inventory.groups.map((group) => (
          <details key={group.id} open={group.id === "browser"}>
            <summary>
              {group.title}
              <span className="muted"> · {group.endpoints.length} 个接口</span>
            </summary>
            <p className="muted">{group.description}</p>
            {group.surfaces.length > 0 && (
              <div className="chips">
                {group.surfaces.map((s) => (
                  <button
                    key={s.path}
                    type="button"
                    className="chip"
                    onClick={() => {
                      setMethod("GET");
                      setPath(s.path);
                    }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
            <ul className="endpoints">
              {group.endpoints.map((e) => (
                <li key={`${e.method}${e.path}`}>
                  <button
                    type="button"
                    className="endpoint"
                    onClick={() => {
                      setMethod(e.method);
                      setPath(e.path);
                    }}
                  >
                    <span className={`method ${e.method}`}>{e.method}</span>
                    <code>{e.path}</code>
                    <span className="muted">{e.summary}</span>
                  </button>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </div>

      <div className="explorer">
        <h4>接口调用</h4>
        <div className="row">
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/v1/..." />
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void (async () => {
                try {
                  let parsed: unknown;
                  if (body.trim()) parsed = JSON.parse(body);
                  const res = await api.sandboxRequest(method, path, parsed);
                  setResult(`HTTP ${res.status}\n${res.body}`);
                } catch (err) {
                  setResult(err instanceof Error ? err.message : String(err));
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            发送
          </button>
        </div>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder='请求体（JSON，可留空）：{"url":"https://example.com"}' spellCheck={false} />
        {result !== null && <pre className="result">{result}</pre>}

        <h4>MCP 服务器</h4>
        <p className="muted">{caps?.mcpServers.length ? caps.mcpServers.join("、") : "暂无"}</p>
        <h4>技能</h4>
        <p className="muted">{caps?.skills.length ? caps.skills.map((s) => s.name).join("、") : "暂无已注册技能"}</p>
        {caps?.inventory.sandboxVersion && <p className="muted">沙箱版本：{caps.inventory.sandboxVersion}</p>}
      </div>
    </div>
  );
}

/** Accept a path, a bare port, or `port/path`; ports go through the sandbox proxy entry. */
export function normalizePreviewTarget(input: string): string {
  const value = input.trim();
  if (!value) return "/";
  const bare = value.replace(/^https?:\/\//, "");
  const portMatch = /^(\d{2,5})(\/.*)?$/.exec(bare.startsWith("/") ? "" : bare);
  if (portMatch) return `/proxy/${portMatch[1]}${portMatch[2] ?? "/"}`;
  return value.startsWith("/") ? value : `/${value}`;
}

function formatSize(size: number | null): string {
  if (size === null || size === undefined) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
