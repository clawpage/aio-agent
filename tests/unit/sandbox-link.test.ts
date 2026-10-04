import { describe, expect, it } from "vitest";
import {
  isWebLink,
  isSandboxLink,
  isWorkspaceFilePath,
  workspaceFileKind,
  workspaceFilePathFromHref,
  SANDBOX_WORKSPACE_ROOT,
} from "../../src/ui/src/sandboxLink.js";

describe("sandbox link classification", () => {
  it("accepts only absolute http/https web URLs", () => {
    for (const href of ["http://example.com", "https://example.com/a?b=1#c"]) {
      expect(isWebLink(href), href).toBe(true);
    }
    for (const href of [
      "",
      "/home/gem/workspace/a.png",
      "//example.com/x",
      "mailto:owner@example.com",
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "file:///etc/passwd",
      "#frag",
      "foo/bar",
    ]) {
      expect(isWebLink(href), href).toBe(false);
    }
  });

  it("only sends private IP web URLs to the sandbox, without resolving domain names", () => {
    for (const host of ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.10", "127.0.0.1", "0.0.0.0", "169.254.1.1", "100.64.0.1", "100.127.255.255", "[::1]", "[::]", "[fd00::1]", "[fc00::1]", "[fe80::1]", "[febf::1]", "[::ffff:192.168.1.1]", "[::ffff:10.0.0.1]"]) {
      expect(isSandboxLink(`https://${host}:8443/path?q=1#part`), host).toBe(true);
    }
    for (const host of ["example.com", "localhost", "private.local", "192.168.1.1.evil.com", "8.8.8.8", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "[2001:4860:4860::8888]", "[::ffff:8.8.8.8]"]) {
      expect(isSandboxLink(`https://${host}/`), host).toBe(false);
    }
    // URL parsing normalizes shorthand, integer and hexadecimal IPv4 forms.
    expect(isSandboxLink("http://127.1/")).toBe(true);
    expect(isSandboxLink("http://0x7f000001/")).toBe(true);
    expect(isSandboxLink("https://192.168.1.1@public.example/")).toBe(false);
    expect(isSandboxLink("file://192.168.1.1/test")).toBe(false);
  });

  it("accepts decoded absolute workspace paths and rejects everything else", () => {
    expect(workspaceFilePathFromHref(`${SANDBOX_WORKSPACE_ROOT}/garden-line-drawing.png`)).toBe(
      `${SANDBOX_WORKSPACE_ROOT}/garden-line-drawing.png`,
    );
    // Marked percent-encodes non-ASCII; decoding restores the real path.
    expect(workspaceFilePathFromHref(`${SANDBOX_WORKSPACE_ROOT}/%E4%B8%AD%E6%96%87.png`)).toBe(
      `${SANDBOX_WORKSPACE_ROOT}/中文.png`,
    );
    expect(workspaceFilePathFromHref(SANDBOX_WORKSPACE_ROOT)).toBe(SANDBOX_WORKSPACE_ROOT);

    for (const href of [
      "",
      "a.png",
      "//evil.example.com/x",
      "https://example.com/x.png",
      "/etc/passwd",
      "/home/gem/workspace-evil/x.png",
      `${SANDBOX_WORKSPACE_ROOT}/../.ssh/id_rsa`,
      `${SANDBOX_WORKSPACE_ROOT}/%2e%2e/.ssh/id_rsa`,
      `${SANDBOX_WORKSPACE_ROOT}/a\\b.png`,
      `${SANDBOX_WORKSPACE_ROOT}/bad\nname.png`,
      "%E0%A4%A",
    ]) {
      expect(workspaceFilePathFromHref(href), href).toBeNull();
    }
  });

  it("validates decoded paths directly and rejects traversal", () => {
    expect(isWorkspaceFilePath(`${SANDBOX_WORKSPACE_ROOT}/a/b/c.png`)).toBe(true);
    expect(isWorkspaceFilePath(`${SANDBOX_WORKSPACE_ROOT}/..`)).toBe(false);
    expect(isWorkspaceFilePath("/home/gem/other/x")).toBe(false);
    expect(isWorkspaceFilePath("relative/x")).toBe(false);
    expect(isWorkspaceFilePath("")).toBe(false);
  });

  it("classifies every kind the preview dialog can render", () => {
    for (const ext of ["png", "PNG", "jpg", "jpeg", "webp", "gif", "avif", "bmp"]) {
      expect(workspaceFileKind(`${SANDBOX_WORKSPACE_ROOT}/x.${ext}`), ext).toBe("image");
    }
    expect(workspaceFileKind(`${SANDBOX_WORKSPACE_ROOT}/x.pdf`)).toBe("pdf");
    expect(workspaceFileKind(`${SANDBOX_WORKSPACE_ROOT}/x.docx`)).toBe("word");
    expect(workspaceFileKind(`${SANDBOX_WORKSPACE_ROOT}/x.xlsx`)).toBe("excel");
    expect(workspaceFileKind(`${SANDBOX_WORKSPACE_ROOT}/x.pptx`)).toBe("ppt");
    // Markdown source and HTML are shown as escaped text, never markup; SVG is a picture in an <img>.
    expect(workspaceFileKind(`${SANDBOX_WORKSPACE_ROOT}/x.txt`)).toBe("text");
    expect(workspaceFileKind(`${SANDBOX_WORKSPACE_ROOT}/x.html`)).toBe("text");
    expect(workspaceFileKind(`${SANDBOX_WORKSPACE_ROOT}/x.svg`)).toBe("image");
    expect(workspaceFileKind(`${SANDBOX_WORKSPACE_ROOT}/x.png.txt`)).toBe("text");
    // Nothing is guessed: an unknown extension is download-only.
    expect(workspaceFileKind(`${SANDBOX_WORKSPACE_ROOT}/x`)).toBe("unsupported");
    expect(workspaceFileKind(`${SANDBOX_WORKSPACE_ROOT}/x.exe`)).toBe("unsupported");
  });
});
