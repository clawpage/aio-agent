import { expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SandboxContainer } from "../../src/control/sandbox/container.js";
import { Logger } from "../../src/common/logger.js";
import { testConfig, testNode } from "../helpers/harness.js";

it("gives Claude Code the workspace rules and the long-term memory Codex keeps", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-claude-md-"));
  try {
    const cfg = testConfig(dir, 18999);
    const container = new SandboxContainer(cfg, new Logger("error", undefined, false), testNode());
    let claudeMd = "";
    vi.spyOn(container, "execInSandbox").mockImplementation(async (argv: string[], opts?: { stdin?: string }) => {
      if (argv.at(-1) === cfg.claudeCode.configDir) claudeMd = opts?.stdin ?? "";
      return { code: 0, stdout: `${cfg.claudeCode.version} (Claude Code)`, stderr: "" };
    });
    await container.ensureClaudeCli();
    expect(claudeMd.split("\n")[0]).toBe("@/home/gem/workspace/AGENTS.md");
    expect(claudeMd).toContain("\n@/home/gem/.codex/memories/memory_summary.md\n");
    expect(claudeMd).toContain("/home/gem/.codex/memories/MEMORY.md");
    expect(claudeMd).toContain("不要直接说没有记录");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("aligns the sandbox browser identity once: its own Linux UA, the egress time zone, WebGL on, site isolation back, Chrome's TLS extension", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-identity-"));
  try {
    const cfg = testConfig(dir, 18999);
    const container = new SandboxContainer(cfg, new Logger("error", undefined, false), testNode());
    const configPath = path.join(dir, "browser-supervisor.json");
    fs.writeFileSync(configPath, JSON.stringify({ browser: { args: ["--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "--disable-gpu", "--mute-audio", "--disable-site-isolation-trials", "--use-angle=swiftshader", "--time-zone-for-testing=Asia/Singapore"], env: { TZ: "Asia/Singapore", DISPLAY: ":99" } } }));
    const users: Array<string | undefined> = [];
    // Run the real script against a temp config instead of the container's.
    vi.spyOn(container, "execInSandbox").mockImplementation(async (args: string[], opts?: { user?: string }) => {
      users.push(opts?.user);
      const script = args[args.indexOf("-c") + 1]!.replace("/var/run/gem/browser-supervisor.json", configPath);
      const stdout = execFileSync("python3", ["-c", script, ...args.slice(args.indexOf("-c") + 2)], { encoding: "utf8" });
      return { code: 0, stdout, stderr: "" };
    });
    // No Chromium runs here, so nothing is restarted; the config is rewritten for its next start.
    expect(await container.alignBrowserIdentity("America/Los_Angeles")).toBe(false);
    expect(users[0]).toBe("root");
    const browser = JSON.parse(fs.readFileSync(configPath, "utf8")).browser as { args: string[]; env: Record<string, string>; binary: string };
    expect(browser.args).toEqual(["--mute-audio", "--time-zone-for-testing=America/Los_Angeles", "--enable-features=AddTLSServerHandshakePadding", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]);
    expect(browser.env).toEqual({ TZ: "America/Los_Angeles", DISPLAY: ":99" });
    expect(browser.binary).toBe("/usr/local/bin/browser");
    // Already aligned: nothing more to write.
    const before = fs.readFileSync(configPath, "utf8");
    expect(await container.alignBrowserIdentity("America/Los_Angeles")).toBe(false);
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("points the browser at a newer build with its libraries, merges the TLS feature, and goes back to the image browser without it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-binary-"));
  try {
    const container = new SandboxContainer(testConfig(dir, 18999), new Logger("error", undefined, false), testNode());
    const configPath = path.join(dir, "browser-supervisor.json");
    fs.writeFileSync(configPath, JSON.stringify({ browser: { binary: "/usr/local/bin/browser", args: ["--enable-features=Foo", "--time-zone-for-testing=America/Los_Angeles"], env: { TZ: "America/Los_Angeles" } } }));
    vi.spyOn(container, "execInSandbox").mockImplementation(async (args: string[]) => {
      const script = args[args.indexOf("-c") + 1]!.replace("/var/run/gem/browser-supervisor.json", configPath);
      return { code: 0, stdout: execFileSync("python3", ["-c", script, ...args.slice(args.indexOf("-c") + 2)], { encoding: "utf8" }), stderr: "" };
    });
    const browser = () => JSON.parse(fs.readFileSync(configPath, "utf8")).browser as { binary: string; args: string[]; env: Record<string, string> };
    const build = { binary: "/opt/aio-browser/chromium-abc/root/usr/lib/chromium/chromium", libraryPath: "/opt/aio-browser/chromium-abc/root/usr/lib/aarch64-linux-gnu" };
    await container.alignBrowserIdentity("America/Los_Angeles", build);
    expect(browser().binary).toBe(build.binary);
    expect(browser().env).toEqual({ TZ: "America/Los_Angeles", LD_LIBRARY_PATH: build.libraryPath });
    expect(browser().args.filter((a) => a.startsWith("--enable-features="))).toEqual(["--enable-features=Foo,AddTLSServerHandshakePadding"]);
    await container.alignBrowserIdentity("America/Los_Angeles");
    expect(browser().binary).toBe("/usr/local/bin/browser");
    expect(browser().env).toEqual({ TZ: "America/Los_Angeles" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("unpacks pinned browser packages as root, and leaves another CPU architecture on the image browser", async () => {
  const container = new SandboxContainer(testConfig("/tmp/pa-build", 18999), new Logger("error", undefined, false), testNode());
  const build = { packages: [{ url: "https://pkg.example/chromium.deb", sha256: "a".repeat(64) }, { url: "https://pkg.example/common.deb", sha256: "b".repeat(64) }], arch: "aarch64" };
  const calls: Array<{ argv: string[]; user?: string }> = [];
  let answer = "/opt/aio-browser/chromium-0123456789ab\n";
  container.execInSandbox = (async (argv: string[], opts?: { user?: string }) => (calls.push({ argv, user: opts?.user }), { code: 0, stdout: answer, stderr: "" })) as typeof container.execInSandbox;
  expect(await container.ensureBrowserBuild(build)).toEqual({
    binary: "/opt/aio-browser/chromium-0123456789ab/root/usr/lib/chromium/chromium",
    libraryPath: "/opt/aio-browser/chromium-0123456789ab/root/usr/lib/aarch64-linux-gnu",
  });
  expect(calls[0]!.user).toBe("root");
  expect(calls[0]!.argv.slice(-4)).toEqual([build.packages[0]!.url, build.packages[0]!.sha256, build.packages[1]!.url, build.packages[1]!.sha256]);
  expect(calls[0]!.argv[2]).toContain("sha256sum -c");
  // A fresh container has no tool directory yet: it is created before the build is unpacked beside it.
  expect(calls[0]!.argv[2].indexOf('mkdir -p "$(dirname "$dir")"')).toBeGreaterThan(-1);
  expect(calls[0]!.argv[2].indexOf('mkdir -p "$(dirname "$dir")"')).toBeLessThan(calls[0]!.argv[2].indexOf("mktemp"));
  expect(calls[0]!.argv[2]).toContain("dpkg-deb -x");
  // An old build is only removed when no running process uses it.
  expect(calls[0]!.argv[2]).toContain('grep -qsF "$old/" /proc/[0-9]*/cmdline || rm -rf "$old"');
  answer = "other-arch\n";
  expect(await container.ensureBrowserBuild(build)).toBeNull();
  await expect(container.ensureBrowserBuild({ ...build, packages: [{ url: "https://pkg.example/x.deb", sha256: "not-a-hash" }] })).rejects.toThrow("package list");
  await expect(container.ensureBrowserBuild({ ...build, packages: [{ url: "http://pkg.example/x.deb", sha256: "a".repeat(64) }] })).rejects.toThrow("package list");
});
