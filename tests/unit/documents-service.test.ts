import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DocumentError, DocumentService } from "../../src/control/documents/service.js";
import { loadConfig, type Config } from "../../src/control/config.js";
import { Logger } from "../../src/common/logger.js";
import type { SandboxContainer, DockerRunResult } from "../../src/control/sandbox/container.js";

const ROOT = "/home/gem/workspace";

/** One scripted container response for a `docker exec` argv shape. */
type Handler = (argv: string[]) => DockerRunResult | undefined;

class FakeContainer {
  readonly calls: string[][] = [];
  readonly users: Array<string | undefined> = [];
  readonly stdins: Array<string | undefined> = [];
  readonly written = new Map<string, string>();
  handler: Handler;
  constructor(handler: Handler) {
    this.handler = handler;
  }
  async execInSandbox(
    argv: string[],
    opts: { user?: string; stdin?: string } = {},
  ): Promise<DockerRunResult> {
    this.calls.push(argv);
    this.users.push(opts.user);
    this.stdins.push(opts.stdin);
    const result = this.handler(argv);
    if (result) return result;
    // Defaults that keep the readiness/script plumbing quiet.
    if (argv[0] === "cat") return { code: 1, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }
  async writeFileInSandbox(target: string, content: string): Promise<void> {
    this.written.set(target, content);
  }
  /** The sandbox's web port; tests intercept the global fetch underneath. */
  async fetch(pathname: string, init?: RequestInit): Promise<Response> {
    return await fetch(`http://sandbox.test${pathname}`, init);
  }
}

const READY = JSON.stringify({
  ok: true,
  version: "aio-doc-tools-v1",
  ready: true,
  previewReady: true,
  authoringReady: true,
  marker: true,
  venv: true,
  needsRoot: false,
  tools: { soffice: true, pdftoppm: true, pdfinfo: true, cjkFont: true, aioDocCli: true },
  python: { docx: true, openpyxl: true, pptx: true },
  venvPython: "/home/gem/.codex/tools/aio-doc/venv/bin/python",
  missing: [],
});

function config(overrides: Record<string, string> = {}): Config {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aio-doc-test-"));
  const env: Record<string, string> = {
    PA_DATA_DIR: dataDir,
    PA_DB_PATH: path.join(dataDir, "test.sqlite"),
    PA_OWNER_SECRET_PATH: path.join(dataDir, "owner-secret.txt"),
    PA_OWNER_PASSWORD: "correct horse battery staple",
    PA_LOG_LEVEL: "error",
    PA_DOC_TIMEOUT_SECONDS: "30",
    ...overrides,
  };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return loadConfig();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function service(handler: Handler, overrides: Record<string, string> = {}) {
  const cfg = config(overrides);
  const container = new FakeContainer(handler);
  const svc = new DocumentService(cfg, new Logger("error", undefined, false), container as unknown as SandboxContainer);
  return { svc, container, cfg };
}

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

const TOOL_DIR = "/home/gem/.codex/tools/aio-doc";

/**
 * The provisioning preflight is a `python3 -c` probe that never needs the
 * managed scripts, so it works even when the tool directory is root-owned.
 * Its three stdout lines are: missing tools, writability, venv presence.
 */
function probe(missing: string[], opts: { writable?: boolean; venv?: boolean } = {}): DockerRunResult {
  return {
    code: 0,
    stdout: `${missing.length > 0 ? missing.join(",") : "-"}\n${opts.writable === false ? "readonly" : "writable"}\n${
      opts.venv === false ? "novenv" : "venv"
    }\n`,
    stderr: "",
  };
}

/** True when the argv is the provisioning preflight probe. */
function isProbe(argv: string[]): boolean {
  return argv[0] === "python3" && argv[1] === "-c" && argv[3] === TOOL_DIR;
}

/** Route the container calls the document service makes. */
function baseHandler(opts: {
  realPath?: string;
  size?: string;
  mtime?: string;
  render?: (argv: string[]) => DockerRunResult | undefined;
  download?: (target: string) => { status: number; body: Buffer };
}): Handler {
  return (argv) => {
    if (argv[0] === "bash" && String(argv[1]).endsWith("provision.sh")) {
      return { code: 0, stdout: `${READY}\n`, stderr: "" };
    }
    if (argv[0] === "realpath") {
      return { code: 0, stdout: `${opts.realPath ?? `${ROOT}/a.docx`}\n`, stderr: "" };
    }
    if (argv[0] === "stat") {
      return { code: 0, stdout: `regular file\t${opts.size ?? "100"}\t${opts.mtime ?? "2026-09-24 03:00:00.123456789 -0700"}\n`, stderr: "" };
    }
    if (argv[0] === "bash" && String(argv[1]).endsWith("render.sh")) {
      return opts.render?.(argv);
    }
    return undefined;
  };
}

describe("DocumentService path and revision handling", () => {
  it("streams video ranges and HEAD from the resolved path without buffering the file", async () => {
    const {svc}=service(baseHandler({realPath:`${ROOT}/real.mp4`}));
    const header=Buffer.alloc(32);header.write('ftypisom',4);
    const calls: Array<{url:string;init?:RequestInit}>=[];
    const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
      calls.push({url:String(url),init});
      return init?.headers && new Headers(init.headers).get('range')==='bytes=0-31'
        ? new Response(header,{status:206,headers:{'content-length':'32'}})
        : new Response(init?.method==='HEAD'?null:'data',{status:206,headers:{'content-range':'bytes 50-53/100'}});
    });
    try {
      const result=await svc.video(`${ROOT}/alias.MP4`,'bytes=50-53',false,new AbortController().signal);
      expect(await result.text()).toBe('data');expect(result.status).toBe(206);
      expect(calls[1]!.url).toContain(encodeURIComponent(`${ROOT}/real.mp4`));expect(new Headers(calls[1]!.init?.headers).get('range')).toBe('bytes=50-53');
      const head=await svc.video(`${ROOT}/alias.mp4`,undefined,true,new AbortController().signal);
      expect(head.body).toBeNull();expect(calls.at(-1)!.init?.method).not.toBe('HEAD');
    } finally {fetcher.mockRestore();}
  });
  it("rejects fake MP4, missing files, escaped symlinks and unsupported extensions",async()=>{
    const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('<html>not a movie</html>',{status:206}));
    try {
      const {svc}=service(baseHandler({realPath:`${ROOT}/fake.mp4`}));
      await expect(svc.video(`${ROOT}/fake.mp4`,undefined,false,new AbortController().signal)).rejects.toMatchObject({status:415});
      await expect(svc.video(`${ROOT}/x.html`,undefined,false,new AbortController().signal)).rejects.toMatchObject({status:415});
      const escaped=service(baseHandler({realPath:'/etc/private.mp4'})).svc;
      await expect(escaped.video(`${ROOT}/link.mp4`,undefined,false,new AbortController().signal)).rejects.toMatchObject({status:404});
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {fetcher.mockRestore();}
  });
  it("rejects multipart ranges and cancels an upstream that ignores the probe range",async()=>{
    const {svc}=service(baseHandler({realPath:`${ROOT}/a.mp4`}));const cancel=vi.fn();
    const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(new ReadableStream({cancel}),{status:200}));
    try {
      const res=await svc.video(`${ROOT}/a.mp4`,'bytes=0-2,5-7',false,new AbortController().signal);
      expect(res.status).toBe(416);expect(res.headers.get('content-range')).toBe('bytes */100');expect(fetcher).not.toHaveBeenCalled();
      await expect(svc.video(`${ROOT}/a.mp4`,undefined,false,new AbortController().signal)).rejects.toMatchObject({status:502});expect(cancel).toHaveBeenCalled();
    } finally {fetcher.mockRestore();}
  });
  it("refuses a path whose realpath escapes the workspace", async () => {
    const { svc } = service(baseHandler({ realPath: "/etc/passwd" }));
    await expect(svc.render(`${ROOT}/link.docx`)).rejects.toMatchObject({ code: "not_found" });
    await expect(svc.text(`${ROOT}/link.txt`)).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses a path that resolves to the workspace root itself", async () => {
    const { svc } = service(baseHandler({ realPath: ROOT }));
    await expect(svc.render(`${ROOT}/a.docx`)).rejects.toMatchObject({ code: "not_found" });
  });

  it("serves the same revision from cache instead of converting twice", async () => {
    let renderCount = 0;
    const { svc } = service(
      baseHandler({
        render: (argv) => {
          renderCount += 1;
          const cacheDir = argv[3] ?? "";
          return {
            code: 0,
            stdout: `${JSON.stringify({
              ok: true,
              pages: [{ index: 1, path: `${cacheDir}/page-1.png` }],
              pageCount: 1,
              totalPages: 1,
              truncated: false,
              size: 100,
            })}\n`,
            stderr: "",
          };
        },
      }),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new Uint8Array(PNG), { status: 200 }));
    try {
      const first = await svc.render(`${ROOT}/a.docx`);
      const second = await svc.render(`${ROOT}/a.docx`);
      expect(first.pageCount).toBe(1);
      expect(second.pages[0]?.bytes.length).toBe(PNG.length);
      expect(renderCount).toBe(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("treats two same-size revisions with different mtimes as different cache entries", async () => {
    let renderCount = 0;
    let mtime = "2026-09-24 03:00:00.000000001 -0700";
    const { svc } = service((argv) => {
      if (argv[0] === "bash" && String(argv[1]).endsWith("provision.sh")) return { code: 0, stdout: `${READY}\n`, stderr: "" };
      if (argv[0] === "realpath") return { code: 0, stdout: `${ROOT}/a.docx\n`, stderr: "" };
      if (argv[0] === "stat") return { code: 0, stdout: `regular file\t100\t${mtime}\n`, stderr: "" };
      if (argv[0] === "bash" && String(argv[1]).endsWith("render.sh")) {
        renderCount += 1;
        const cacheDir = argv[3] ?? "";
        return {
          code: 0,
          stdout: `${JSON.stringify({ ok: true, pages: [{ index: 1, path: `${cacheDir}/page-1.png` }], pageCount: 1, totalPages: 1, truncated: false, size: 100 })}\n`,
          stderr: "",
        };
      }
      return undefined;
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new Uint8Array(PNG), { status: 200 }));
    try {
      await svc.render(`${ROOT}/a.docx`);
      // Same size, one nanosecond later: a stale preview must not be served.
      mtime = "2026-09-24 03:00:00.000000002 -0700";
      await svc.render(`${ROOT}/a.docx`);
      expect(renderCount).toBe(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("caps the page count and reports the truncation", async () => {
    const { svc } = service(
      baseHandler({
        render: (argv) => {
          const cacheDir = argv[3] ?? "";
          const pages = Array.from({ length: 3 }, (_, i) => ({ index: i + 1, path: `${cacheDir}/page-${i + 1}.png` }));
          return {
            code: 0,
            stdout: `${JSON.stringify({ ok: true, pages, pageCount: 3, totalPages: 40, truncated: true, size: 100 })}\n`,
            stderr: "",
          };
        },
      }),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new Uint8Array(PNG), { status: 200 }));
    try {
      const result = await svc.render(`${ROOT}/a.docx`);
      expect(result.pageCount).toBe(3);
      expect(result.totalPages).toBe(40);
      expect(result.truncated).toBe(true);
      await expect(svc.page(`${ROOT}/a.docx`, 4)).rejects.toMatchObject({ code: "page_unavailable" });
      await expect(svc.page(`${ROOT}/a.docx`, 0)).rejects.toMatchObject({ code: "bad_request" });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("DocumentService render confinement", () => {
  it("drops page paths that are not a direct child of this run's cache directory", async () => {
    const { svc } = service(
      baseHandler({
        render: (argv) => {
          const cacheDir = argv[3] ?? "";
          return {
            code: 0,
            stdout: `${JSON.stringify({
              ok: true,
              pages: [
                { index: 1, path: "/etc/passwd" },
                { index: 2, path: `${cacheDir}/../other/page-1.png` },
                { index: 3, path: `${cacheDir}/nested/page-1.png` },
                { index: 4, path: `${cacheDir}/not-a-page.png` },
              ],
              pageCount: 4,
              totalPages: 4,
              truncated: false,
              size: 100,
            })}\n`,
            stderr: "",
          };
        },
      }),
    );
    await expect(svc.render(`${ROOT}/a.docx`)).rejects.toMatchObject({ code: "render_failed" });
  });

  it("clears its own cache directory even when the render fails", async () => {
    const { svc, container } = service(
      baseHandler({
        render: () => ({ code: 0, stdout: `${JSON.stringify({ ok: false, code: "convert_failed", message: "损坏" })}\n`, stderr: "" }),
      }),
    );
    await expect(svc.render(`${ROOT}/a.docx`)).rejects.toMatchObject({ code: "render_failed" });
    const rmCalls = container.calls.filter((argv) => argv[0] === "rm");
    expect(rmCalls.length).toBe(1);
    expect(rmCalls[0]?.[2]?.startsWith(`${TOOL_DIR}/cache/`)).toBe(true);
  });

  it("reports a container timeout as a timeout error", async () => {
    const { svc } = service(baseHandler({ render: () => ({ code: 1, stdout: "", stderr: "command timed out" }) }));
    await expect(svc.render(`${ROOT}/a.docx`)).rejects.toMatchObject({ code: "timeout", status: 504 });
  });

  it("refuses a renderable document that is empty or oversized", async () => {
    const empty = service(baseHandler({ size: "0" }));
    await expect(empty.svc.render(`${ROOT}/a.docx`)).rejects.toMatchObject({ code: "empty_file" });
    const huge = service(baseHandler({ size: String(200 * 1024 * 1024) }));
    await expect(huge.svc.render(`${ROOT}/a.docx`)).rejects.toMatchObject({ code: "too_large" });
  });

  it("refuses a kind nothing can rasterise", async () => {
    const { svc } = service(baseHandler({}));
    await expect(svc.render(`${ROOT}/a.exe`)).rejects.toMatchObject({ code: "unsupported" });
  });
});

describe("DocumentService conversion", () => {
  it("rejects a target format outside the allowlist", async () => {
    const { svc } = service(baseHandler({}));
    await expect(svc.convert(`${ROOT}/a.docx`, "exe")).rejects.toMatchObject({ code: "bad_request" });
    await expect(svc.convert(`${ROOT}/a.docx`, "")).rejects.toMatchObject({ code: "bad_request" });
  });

  it("refuses a conversion that would overwrite the source", async () => {
    const { svc } = service(baseHandler({ realPath: `${ROOT}/a.docx` }));
    await expect(svc.convert(`${ROOT}/a.docx`, "docx")).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("DocumentService image", () => {
  it("serves a real PNG with its sniffed content type", async () => {
    const { svc } = service(baseHandler({ realPath: `${ROOT}/a.png`, size: String(PNG.length) }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array(PNG), { status: 200 }),
    );
    try {
      const result = await svc.image(`${ROOT}/a.png`);
      expect(result.contentType).toBe("image/png");
      expect(result.bytes.length).toBe(PNG.length);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("refuses a non-image kind and a file that is not really an image", async () => {
    const notImage = service(baseHandler({ realPath: `${ROOT}/a.txt` }));
    await expect(notImage.svc.image(`${ROOT}/a.txt`)).rejects.toMatchObject({ code: "unsupported" });

    const fake = service(baseHandler({ realPath: `${ROOT}/a.png`, size: "10" }));
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(new TextEncoder().encode("<html>not an image</html>"), { status: 200 }));
    try {
      await expect(fake.svc.image(`${ROOT}/a.png`)).rejects.toMatchObject({ code: "unsupported" });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("DocumentService SVG images", () => {
  it("serves a real SVG as image/svg+xml and refuses other markup behind an .svg name", async () => {
    const svg = '<?xml version="1.0"?>\n<!-- chart -->\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
    const { svc } = service(baseHandler({ realPath: `${ROOT}/chart.svg`, size: String(svg.length) }));
    let body = svg;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new TextEncoder().encode(body), { status: 200 }));
    try {
      const result = await svc.image(`${ROOT}/chart.svg`);
      expect(result.contentType).toBe("image/svg+xml");
      expect(result.bytes.toString("utf8")).toBe(svg);
      body = "<html><script>alert(1)</script></html>";
      await expect(svc.image(`${ROOT}/chart.svg`)).rejects.toMatchObject({ code: "unsupported" });
      // SVG text behind a raster name is not a PNG either.
      const png = service(baseHandler({ realPath: `${ROOT}/a.png`, size: "100" }));
      body = svg;
      await expect(png.svc.image(`${ROOT}/a.png`)).rejects.toMatchObject({ code: "unsupported" });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("DocumentService readiness", () => {
  it("reports not-ready as data rather than throwing", async () => {
    const { svc } = service(() => ({ code: 0, stdout: `${JSON.stringify({ ok: true, ready: false, previewReady: false, authoringReady: false, missing: ["libreoffice"] })}\n`, stderr: "" }));
    const readiness = await svc.readiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.missing).toContain("libreoffice");
  });

  it("refuses a render while the tools are not ready", async () => {
    const { svc } = service((argv) => {
      if (argv[0] === "bash" && String(argv[1]).endsWith("provision.sh")) {
        return { code: 0, stdout: `${JSON.stringify({ ok: true, ready: false, previewReady: false, authoringReady: false })}\n`, stderr: "" };
      }
      if (argv[0] === "realpath") return { code: 0, stdout: `${ROOT}/a.docx\n`, stderr: "" };
      if (argv[0] === "stat") return { code: 0, stdout: "regular file\t100\t2026-09-24 03:00:00.000000000 -0700\n", stderr: "" };
      return undefined;
    });
    await expect(svc.render(`${ROOT}/a.docx`)).rejects.toMatchObject({ code: "tools_not_ready", status: 503 });
  });

  it("reuses a recent probe instead of forking the container again", async () => {
    const { svc, container } = service(baseHandler({}));
    await svc.readiness();
    const first = container.calls.filter((argv) => String(argv[1]).endsWith("provision.sh")).length;
    await svc.readiness();
    const second = container.calls.filter((argv) => String(argv[1]).endsWith("provision.sh")).length;
    expect(second).toBe(first);
  });
});

describe("DocumentService provisioning", () => {
  it("runs the fixed root step as root, then the sandbox-user step", async () => {
    // The preflight finds OS packages missing (so the root step is required);
    // every later probe reports ready.
    let probeCount = 0;
    const { svc, container } = service((argv) => {
      if (isProbe(argv)) {
        probeCount += 1;
        return probeCount === 1 ? probe(["soffice", "python3-venv"], { writable: false }) : probe([]);
      }
      if (argv[0] === "bash" && String(argv[1]).endsWith("provision.sh")) {
        const mode = String(argv[2] ?? "");
        if (mode === "install") {
          return { code: 0, stdout: `${JSON.stringify({ ok: true, code: "installed", message: "文档工具安装完成" })}\n`, stderr: "" };
        }
        return { code: 0, stdout: `${READY}\n`, stderr: "" };
      }
      if (argv.includes("aio-doc-root-install")) {
        return { code: 0, stdout: '{"ok":true,"code":"root_installed","aptRan":true,"message":"系统依赖已安装"}\n', stderr: "" };
      }
      return undefined;
    });
    const result = await svc.provision();
    expect(result.ok).toBe(true);

    // The root step's content arrives on stdin, so root never executes a script
    // from a path the sandbox user can edit.
    const rootIndex = container.users.findIndex((user) => user === "root");
    expect(rootIndex).toBeGreaterThanOrEqual(0);
    const rootStdin = container.stdins[rootIndex] ?? "";
    expect(rootStdin).toContain("apt-get install");
    expect(rootStdin).toContain("python3-venv");
    // /etc/codex may only appear in a comment: the root step must never read,
    // write or relax the Codex MCP isolation policy.
    const codexLines = rootStdin
      .split("\n")
      .filter((line) => line.includes("/etc/codex"))
      .filter((line) => !line.trimStart().startsWith("#"));
    expect(codexLines).toEqual([]);
    // ...and it is not read from a sandbox-writable path.
    expect(container.calls[rootIndex]?.join(" ")).not.toContain("install-root.sh");

    // The user step is a real container script, and it is NOT run as root: it
    // leaves the user unset so the container default (the sandbox user) applies.
    const userIndex = container.calls.findIndex((argv) => String(argv[1]).endsWith("provision.sh"));
    expect(userIndex).toBeGreaterThanOrEqual(0);
    expect(container.users[userIndex]).not.toBe("root");
  });

  it("installs by itself what a sandbox is missing, and only then", async () => {
    const world = { installed: false, installs: 0 };
    const NOT_READY = JSON.stringify({ ...JSON.parse(READY), ready: false, authoringReady: false, previewReady: false, missing: ["libreoffice", "python-pptx"] });
    const { svc, container } = service((argv) => {
      if (isProbe(argv)) return world.installed ? probe([]) : probe(["soffice"], { writable: false });
      if (argv[0] === "bash" && String(argv[1]).endsWith("provision.sh")) {
        if (String(argv[2] ?? "") !== "install") return { code: 0, stdout: `${world.installed ? READY : NOT_READY}\n`, stderr: "" };
        world.installs += 1;
        world.installed = true;
        return { code: 0, stdout: `${JSON.stringify({ ok: true, code: "installed", message: "文档工具安装完成" })}\n`, stderr: "" };
      }
      if (argv.includes("aio-doc-root-install")) return { code: 0, stdout: '{"ok":true,"code":"root_installed","aptRan":true,"message":"系统依赖已安装"}\n', stderr: "" };
      return undefined;
    });
    // A new sandbox: three callers at once (a start, a wake, the owner's repair button) share one install.
    await Promise.all([svc.ensureProvisioned(), svc.ensureProvisioned(), svc.provision()]);
    expect(world.installs).toBe(1);
    expect(container.users.filter((user) => user === "root")).toHaveLength(1);
    expect((await svc.readiness()).ready).toBe(true);
    // The next start finds everything in place: one check, nothing run as root.
    const before = container.calls.length;
    await svc.ensureProvisioned();
    expect(world.installs).toBe(1);
    expect(container.users.slice(before)).not.toContain("root");
  });

  it("installs nothing when documents are switched off", async () => {
    const { svc, container } = service(() => undefined, { PA_DOCUMENTS_ENABLED: "0" });
    await svc.ensureProvisioned();
    expect(container.calls).toEqual([]);
  });

  it("does not run the root step when the tools are already ready", async () => {
    const { svc, container } = service((argv) => {
      if (isProbe(argv)) return probe([]);
      if (argv[0] === "bash" && String(argv[1]).endsWith("provision.sh")) {
        if (String(argv[2] ?? "") === "install") {
          return { code: 0, stdout: '{"ok":true,"code":"already","message":"已就绪"}\n', stderr: "" };
        }
        return { code: 0, stdout: `${READY}\n`, stderr: "" };
      }
      return undefined;
    });
    const result = await svc.provision();
    expect(result.ok).toBe(true);
    expect(container.users).not.toContain("root");
  });

  it("runs the root step when only the tool directory is root-owned", async () => {
    // This is the real regression: the directory is root-owned, so the user step
    // cannot write anything. The preflight must detect that and route to root
    // before any managed script is written.
    const { svc, container } = service((argv) => {
      if (isProbe(argv)) return probe([], { writable: false });
      if (argv[0] === "bash" && String(argv[1]).endsWith("provision.sh")) {
        if (String(argv[2] ?? "") === "install") {
          return { code: 0, stdout: '{"ok":true,"code":"installed","message":"文档工具安装完成"}\n', stderr: "" };
        }
        return { code: 0, stdout: `${READY}\n`, stderr: "" };
      }
      if (argv.includes("aio-doc-root-install")) {
        return { code: 0, stdout: '{"ok":true,"code":"root_installed","aptRan":false,"message":"权限已设置"}\n', stderr: "" };
      }
      return undefined;
    });
    const result = await svc.provision();
    expect(result.ok).toBe(true);
    const rootIndex = container.users.findIndex((user) => user === "root");
    expect(rootIndex).toBeGreaterThanOrEqual(0);
    // No apt run was needed, so the summary must not claim one.
    expect(result.message).toContain("工具目录权限");
    // The root step must run before any managed script is written: otherwise the
    // write itself would fail on the root-owned directory.
    const firstWrite = container.calls.findIndex((argv) => argv[0] === "cat" || argv[0] === "mkdir");
    if (firstWrite >= 0) expect(rootIndex).toBeLessThan(firstWrite);
  });

  it("never reports ok when readiness is still false after a successful install", async () => {
    // `provision.sh check` always exits with ok:true (the probe itself worked),
    // which says nothing about readiness. `ok` must follow readiness.ready.
    const { svc } = service((argv) => {
      if (isProbe(argv)) return probe([]);
      if (argv[0] === "bash" && String(argv[1]).endsWith("provision.sh")) {
        if (String(argv[2] ?? "") === "install") {
          return { code: 0, stdout: '{"ok":true,"code":"installed","message":"文档工具安装完成"}\n', stderr: "" };
        }
        return {
          code: 0,
          stdout: `${JSON.stringify({ ok: true, ready: false, previewReady: true, authoringReady: false, missing: ["python-pptx"] })}\n`,
          stderr: "",
        };
      }
      return undefined;
    });
    const result = await svc.provision();
    expect(result.ok).toBe(false);
    expect(result.readiness.ready).toBe(false);
  });

  it("reports a failed root step as data instead of throwing", async () => {
    const { svc } = service((argv) => {
      if (isProbe(argv)) return probe(["soffice"], { writable: false });
      if (argv.includes("aio-doc-root-install")) {
        return { code: 0, stdout: '{"ok":false,"code":"apt_update_failed","message":"没有网络出口"}\n', stderr: "" };
      }
      if (argv[0] === "bash" && String(argv[1]).endsWith("provision.sh")) {
        return {
          code: 0,
          stdout: `${JSON.stringify({ ok: true, ready: false, previewReady: false, authoringReady: false, needsRoot: true })}\n`,
          stderr: "",
        };
      }
      return undefined;
    });
    const result = await svc.provision();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("没有网络出口");
  });
});

describe("DocumentError", () => {
  it("carries a code and an HTTP status", () => {
    const err = new DocumentError("busy", "排队已满", 429);
    expect(err.code).toBe("busy");
    expect(err.status).toBe(429);
    expect(err).toBeInstanceOf(Error);
  });
});

describe("web pictures in messages", () => {
  const ok = (bytes: Buffer): DockerRunResult => ({ code: 0, stdout: bytes.toString("base64"), stderr: "" });
  const fetches = (container: FakeContainer) => container.calls.filter((argv) => argv[0] === "python3" && argv[1] === "-c");

  it("lets the account's sandbox fetch an https picture, once, and returns only image bytes", async () => {
    const { svc, container } = service((argv) => (argv[0] === "python3" ? ok(PNG) : undefined));
    const url = "https://m.media-amazon.com/images/I/saros.png";
    const [a, b] = await Promise.all([svc.webImage(url), svc.webImage(url)]);
    expect(a).toEqual({ bytes: PNG, contentType: "image/png" });
    expect(b.bytes.equals(PNG)).toBe(true);
    // Fixed code, the URL as its only argument: nothing of it reaches a shell.
    expect(fetches(container)).toEqual([["python3", "-c", expect.stringContaining("urllib.request"), url]]);
    await svc.webImage(url);
    expect(fetches(container)).toHaveLength(1);
  });

  it("refuses what is not an https picture, and remembers a failure for a while", async () => {
    const { svc, container } = service((argv) => {
      if (argv[0] !== "python3") return undefined;
      if (argv[3]!.endsWith("page.html")) return ok(Buffer.from("<html><script>alert(1)</script></html>"));
      if (argv[3]!.endsWith("huge.jpg")) return { code: 3, stdout: "", stderr: "" };
      return { code: 2, stdout: "", stderr: "URLError" };
    });
    for (const bad of ["http://example.com/a.png", "javascript:alert(1)", "https://user:pw@example.com/a.png", "not a url", `https://example.com/${"a".repeat(2100)}.png`]) {
      await expect(svc.webImage(bad), bad).rejects.toMatchObject({ status: 400 });
    }
    await expect(svc.webImage("https://example.com/page.html")).rejects.toMatchObject({ status: 415 });
    await expect(svc.webImage("https://example.com/huge.jpg")).rejects.toMatchObject({ status: 413 });
    await expect(svc.webImage("https://example.com/down.jpg")).rejects.toMatchObject({ status: 502 });
    await expect(svc.webImage("https://example.com/down.jpg")).rejects.toBeInstanceOf(DocumentError);
    expect(fetches(container).map((argv) => argv[3])).toEqual(["https://example.com/page.html", "https://example.com/huge.jpg", "https://example.com/down.jpg"]);
  });
});
