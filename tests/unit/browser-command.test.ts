import { describe, expect, it } from "vitest";
import { isBrowserNavigateCommand, isBrowserNavigateTool, itemOpensSandboxBrowser } from "../../src/web/src/browserCommand";
import { isSandboxLink } from "../../src/web/src/sandboxLink";

describe("isBrowserNavigateCommand", () => {
  it("accepts the command at the start of a segment", () => {
    expect(isBrowserNavigateCommand("aio browser navigate https://example.com")).toBe(true);
    expect(isBrowserNavigateCommand("aio  browser  navigate")).toBe(true);
    expect(isBrowserNavigateCommand("  aio browser navigate 'https://example.com'")).toBe(true);
  });

  it("accepts it after a shell separator", () => {
    for (const command of [
      "cd /home/gem/workspace && aio browser navigate https://example.com",
      "true || aio browser navigate https://example.com",
      "echo start; aio browser navigate https://example.com",
      "ls | aio browser navigate https://example.com",
      "echo before\naio browser navigate https://example.com",
    ]) {
      expect(isBrowserNavigateCommand(command), command).toBe(true);
    }
  });

  it("does not match text that merely contains the words", () => {
    for (const command of [
      "echo 'aio browser navigate https://example.com'",
      "grep 'aio browser navigate' log.txt",
      "# aio browser navigate https://example.com",
      'echo "run aio browser navigate later"',
      // A separator inside quotes must not be treated as a real segment break.
      'echo "x && aio browser navigate https://example.com"',
      "echo 'x && aio browser navigate https://example.com'",
      'echo "log; aio browser navigate everything"',
      "aio browser screenshot -o shot.png",
      "aio browser text",
      "some-aio browser navigate",
    ]) {
      expect(isBrowserNavigateCommand(command), command).toBe(false);
    }
  });

  it("ignores empty, whitespace and non-string commands", () => {
    expect(isBrowserNavigateCommand("")).toBe(false);
    expect(isBrowserNavigateCommand("   ")).toBe(false);
    expect(isBrowserNavigateCommand(undefined)).toBe(false);
    expect(isBrowserNavigateCommand(null)).toBe(false);
    expect(isBrowserNavigateCommand(42)).toBe(false);
  });
});

describe("itemOpensSandboxBrowser", () => {
  it("matches the CLI and MCP navigation shapes", () => {
    expect(itemOpensSandboxBrowser({ type: "commandExecution", command: "aio browser navigate x" })).toBe(true);
    expect(itemOpensSandboxBrowser({ type: "mcpToolCall", server: "aio_browser", tool: "browser_navigate" })).toBe(true);
  });

  it("ignores every other item", () => {
    expect(itemOpensSandboxBrowser({ type: "commandExecution", command: "echo hi" })).toBe(false);
    expect(itemOpensSandboxBrowser({ type: "mcpToolCall", server: "aio_browser", tool: "browser_screenshot" })).toBe(false);
    expect(itemOpensSandboxBrowser({ type: "mcpToolCall", server: "other", tool: "browser_navigate" })).toBe(false);
    expect(itemOpensSandboxBrowser({ type: "agentMessage", text: "aio browser navigate" })).toBe(false);
    expect(itemOpensSandboxBrowser(null)).toBe(false);
    expect(itemOpensSandboxBrowser(undefined)).toBe(false);
  });

  it("validates the MCP server/tool pair strictly", () => {
    expect(isBrowserNavigateTool("aio_browser", "browser_navigate")).toBe(true);
    expect(isBrowserNavigateTool("aio_browser", "browser_navigate_extra")).toBe(false);
    expect(isBrowserNavigateTool("aio_browser2", "browser_navigate")).toBe(false);
    expect(isBrowserNavigateTool("aio_browser", "browser_navigate")).toBe(true);
  });
});

describe("isSandboxLink", () => {
  it("accepts only absolute http/https URLs", () => {
    for (const href of [
      "http://example.com",
      "https://example.com/a?b=1#c",
      "HTTPS://EXAMPLE.COM",
      "http://127.0.0.1:8080/x",
    ]) {
      expect(isSandboxLink(href), href).toBe(true);
    }
  });

  it("rejects relative, fragment, protocol-relative and non-web schemes", () => {
    for (const href of [
      "",
      "/settings",
      "settings",
      "./a",
      "../a",
      "#fragment",
      "//example.com/x",
      "mailto:x@y.com",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<b>x</b>",
      "tel:+15551234567",
    ]) {
      expect(isSandboxLink(href), href).toBe(false);
    }
  });
});
