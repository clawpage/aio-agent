import { describe, expect, it } from "vitest";
import { fileOperationError, interpretShellResult, requireAbsoluteSandboxPath, shellQuote } from "../../src/server/http/api";

describe("sandbox shell result interpretation", () => {
  it("accepts a completed command with exit code 0", () => {
    const outcome = interpretShellResult({
      success: true,
      message: "Command executed",
      data: { session_id: "s1", status: "completed", exit_code: 0, output: "ok" },
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.exitCode).toBe(0);
  });

  it("rejects a completed command with a non-zero exit code", () => {
    const outcome = interpretShellResult({
      success: true,
      message: "Command executed",
      data: { session_id: "s1", status: "completed", exit_code: 1, output: "mkdir: cannot create directory" },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("退出码 1");
  });

  it("rejects a still-running command instead of claiming success", () => {
    const outcome = interpretShellResult({ success: true, data: { session_id: "s1", status: "running" } });
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe("running");
    expect(outcome.message).toContain("仍在运行");
  });

  it("rejects an envelope-level failure", () => {
    const outcome = interpretShellResult({ success: false, message: "Sandbox busy" });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe("Sandbox busy");
  });

  it("treats a missing exit code as unverified", () => {
    const outcome = interpretShellResult({ success: true, data: { status: "completed" } });
    expect(outcome.ok).toBe(false);
  });
});

describe("file operation errors", () => {
  it("surfaces a structured FileOperationError", () => {
    expect(fileOperationError({ error_type: "permission_denied", message: "EACCES: permission denied" })).toBe(
      "EACCES: permission denied",
    );
    expect(fileOperationError({ error_type: "not_found" })).toBe("not_found");
  });

  it("ignores successful payloads", () => {
    expect(fileOperationError({ file: "/home/gem/x", bytes_written: 3 })).toBeNull();
    expect(fileOperationError(null)).toBeNull();
    expect(fileOperationError("text")).toBeNull();
  });
});

describe("sandbox path validation", () => {
  it("accepts absolute paths inside the sandbox", () => {
    expect(requireAbsoluteSandboxPath("/home/gem/workspace/a.txt")).toEqual({ ok: true, path: "/home/gem/workspace/a.txt" });
  });

  it("normalises traversal away", () => {
    expect(requireAbsoluteSandboxPath("/home/gem/../gem/./a")).toEqual({ ok: true, path: "/home/gem/a" });
    expect(requireAbsoluteSandboxPath("/../../etc/passwd")).toEqual({ ok: true, path: "/etc/passwd" });
  });

  it("rejects relative, empty and control-character paths", () => {
    expect(requireAbsoluteSandboxPath("relative/path").ok).toBe(false);
    expect(requireAbsoluteSandboxPath("").ok).toBe(false);
    expect(requireAbsoluteSandboxPath("/tmp/a\nb").ok).toBe(false);
  });

  it("quotes shell arguments so a path cannot break out", () => {
    expect(shellQuote("/tmp/a b")).toBe("'/tmp/a b'");
    expect(shellQuote("/tmp/it's")).toBe("'/tmp/it'\\''s'");
    expect(shellQuote("/tmp/$(whoami)")).toBe("'/tmp/$(whoami)'");
  });
});
