import { it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error plain ESM script without types
import { applyEdits, createMacShell, findTmux, OFF, shellEnv, tail, TOOL_NAMES } from "../../bin/mac-shell.mjs";
import { MAC_SHELL_TOOLS } from "../../src/control/macShell.js";

type Result = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };
const tmux = findTmux();
const root = fs.mkdtempSync(path.join(os.tmpdir(), "aio-mac-shell-test-"));
// A tmux server of the test's own, never the bridge's (aio-agent) or the user's.
const socket = `aio-test-${process.pid}`;
const shells: Array<{ close(): void }> = [];
afterAll(() => {
  for (const s of shells) s.close();
  fs.rmSync(root, { recursive: true, force: true });
  // tmux leaves its socket file behind.
  fs.rmSync(path.join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${os.userInfo().uid}`, socket), { force: true });
});

function shell(enabled = true) {
  const s = createMacShell({ enabled, tmux, home: root, socket, stateDir: path.join(root, ".state") });
  shells.push(s);
  return {
    call: async (name: string, args: Record<string, unknown>, session = "task_1") =>
      ((await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, session)) as { result: Result }).result,
    raw: s,
  };
}
const textOf = (r: Result) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

it("implements exactly the tools the gateway lists", () => {
  expect(MAC_SHELL_TOOLS.map((t) => t.name)).toEqual(TOOL_NAMES);
});

it("does nothing while the person at the Mac has not turned it on", async () => {
  const { call, raw } = shell(false);
  const off = await call("bash", { command: "touch should-not-exist" });
  expect(off).toEqual({ content: [{ type: "text", text: OFF }], isError: true });
  expect(fs.existsSync(path.join(root, "should-not-exist"))).toBe(false);
  expect(raw.status()).toEqual({ enabled: false, tmux: Boolean(tmux) });
  // Notifications have no answer; the handshake is the gateway's.
  expect(await raw.handle({ jsonrpc: "2.0", method: "notifications/initialized" }, "")).toBeNull();
  expect(await raw.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }, "")).toMatchObject({ error: { code: -32601 } });
});

it("gives the shell none of the bridge's secrets, a UTF-8 locale and Homebrew on PATH", () => {
  const env = shellEnv({ HOME: "/Users/x", USER: "x", PATH: "/usr/bin:/bin", PHONE_BRIDGE_TOKEN: "s", PA_DEVICE_LINK_TOKEN: "dl_s" }, "/Users/x");
  expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "PATH", "TERM", "USER"]);
  expect(env.LANG).toBe("en_US.UTF-8");
  expect(env.PATH.split(":").slice(0, 3)).toEqual(["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"]);
});

it("edits by exact, unique, non-overlapping replacements and keeps the file's line endings", () => {
  expect(applyEdits("a\nb\nc\n", [{ oldText: "b", newText: "B" }, { oldText: "c", newText: "C" }])).toEqual({ text: "a\nB\nC\n", lines: [2, 3] });
  expect(applyEdits("﻿one\r\ntwo\r\n", [{ oldText: "one\ntwo", newText: "1\n2" }]).text).toBe("﻿1\r\n2\r\n");
  expect(() => applyEdits("x x", [{ oldText: "x", newText: "y" }])).toThrow(/more than once/);
  expect(() => applyEdits("abc", [{ oldText: "z", newText: "y" }])).toThrow(/not found/);
  expect(() => applyEdits("abcdef", [{ oldText: "abc", newText: "1" }, { oldText: "cde", newText: "2" }])).toThrow(/overlap/);
  expect(() => applyEdits("abc", [])).toThrow(/at least one/);
});

it("keeps the end of a long output within the limits", () => {
  const lines = Array.from({ length: 3000 }, (_, i) => String(i + 1));
  const cut = tail(lines.join("\n"));
  expect(cut).toMatchObject({ cut: true, total: 3000, shown: 2000 });
  expect(cut.kept.split("\n")[0]).toBe("1001");
  expect(tail("short")).toEqual({ kept: "short", cut: false, total: 1, shown: 1 });
});

it("reads, writes and edits files, relative to the task's shell", async () => {
  const { call } = shell();
  expect(textOf(await call("write", { path: "notes/a.txt", content: "one\ntwo\nthree\n" }))).toBe(`Wrote 14 bytes to ${path.join(root, "notes/a.txt")}`);
  expect(textOf(await call("edit", { path: "~/notes/a.txt", edits: [{ oldText: "two", newText: "2" }] }))).toMatch(/Applied 1 edit .* line 2/);
  expect(fs.readFileSync(path.join(root, "notes/a.txt"), "utf8")).toBe("one\n2\nthree\n");
  const failed = await call("edit", { path: "notes/a.txt", edits: [{ oldText: "2", newText: "x" }, { oldText: "missing", newText: "y" }] });
  expect(failed.isError).toBe(true);
  // Nothing is written unless every edit applies.
  expect(fs.readFileSync(path.join(root, "notes/a.txt"), "utf8")).toBe("one\n2\nthree\n");
  expect(textOf(await call("read", { path: path.join(root, "notes/a.txt"), offset: 2, limit: 1 }))).toBe("2\n\n[Showing lines 2-2 of 4. Use offset=3 to continue.]");
  expect(await call("read", { path: "nope.txt" })).toEqual({ content: [{ type: "text", text: `No such file or directory: ${path.join(root, "nope.txt")}` }], isError: true });
  expect((await call("read", { path: "notes" })).isError).toBe(true);
  fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([1, 0, 2]));
  expect(textOf(await call("read", { path: "bin.dat" }))).toMatch(/binary/);
  // A picture comes back as one.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  fs.writeFileSync(path.join(root, "dot.png"), png);
  expect((await call("read", { path: "dot.png" })).content[1]).toEqual({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
});

it.skipIf(!tmux)("runs bash in tmux, one shell per task that keeps its directory and exports", async () => {
  const { call } = shell();
  fs.mkdirSync(path.join(root, "proj"), { recursive: true });
  expect(await call("bash", { command: "cd proj && export GREETING=你好 && echo started" })).toEqual({ content: [{ type: "text", text: "started" }] });
  expect(textOf(await call("bash", { command: 'echo "$GREETING from $(pwd)"; env | grep -c TOKEN || true' }))).toBe(`你好 from ${path.join(root, "proj")}\n0`);
  // Relative paths follow the shell.
  await call("write", { path: "here.txt", content: "x" });
  expect(fs.existsSync(path.join(root, "proj", "here.txt"))).toBe(true);
  // Another task has a shell of its own.
  expect(textOf(await call("bash", { command: "pwd" }, "task_2"))).toBe(root);
  // Failures say so, with their output.
  expect(await call("bash", { command: "echo oops >&2; exit_code() { return 3; }; exit_code" })).toEqual({ content: [{ type: "text", text: "oops\n\nCommand exited with code 3" }], isError: true });
  // No input to wait for: a reader sees the end of input at once.
  expect(textOf(await call("bash", { command: "read -r line; echo \"got [$line]\"" }))).toBe("got []");
  // A long output keeps its end and names the file with the rest.
  const long = textOf(await call("bash", { command: "seq 1 3000" }));
  expect(long).toMatch(/^1001\n/);
  const full = /Full output: (\S+)\]/.exec(long)![1]!;
  expect(fs.readFileSync(full, "utf8").split("\n")[0]).toBe("1");
});

it.skipIf(!tmux)("interrupts a command past its timeout, and starts over after the shell exits", async () => {
  const { call } = shell();
  const slow = await call("bash", { command: "echo before; sleep 30", timeout: 1 }, "task_3");
  expect(slow.isError).toBe(true);
  expect(textOf(slow)).toMatch(/^before\n\n\[Timed out after 1 s and interrupted/);
  expect(textOf(await call("bash", { command: "echo after" }, "task_3"))).toBe("after");
  await call("bash", { command: "cd /tmp" }, "task_3");
  expect(textOf(await call("bash", { command: "exit 4" }, "task_3"))).toMatch(/The shell exited/);
  expect(textOf(await call("bash", { command: "pwd" }, "task_3"))).toBe(root);
}, 30_000);
