import { describe, expect, it } from "vitest";
import {
  documentKind,
  extensionOf,
  isInsideWorkspace,
  isRenderableKind,
  isSafeBaseName,
  quoteArg,
  requireWorkspaceFilePath,
  splitPath,
  withExtension,
} from "../../src/control/documents/paths.js";

const ROOT = "/home/gem/workspace";

describe("workspace path validation", () => {
  it("accepts a plain file inside the workspace", () => {
    const result = requireWorkspaceFilePath(`${ROOT}/report.docx`, ROOT);
    expect(result).toEqual({ ok: true, path: `${ROOT}/report.docx` });
  });

  it("normalises traversal away before the root check", () => {
    // `/home/gem/workspace/../etc/passwd` collapses to `/home/gem/etc/passwd`.
    const escaped = requireWorkspaceFilePath(`${ROOT}/../etc/passwd`, ROOT);
    expect(escaped.ok).toBe(false);
    // A traversal that stays inside is fine, and is normalised.
    expect(requireWorkspaceFilePath(`${ROOT}/a/../b.txt`, ROOT)).toEqual({ ok: true, path: `${ROOT}/b.txt` });
  });

  it("rejects anything that is not an absolute workspace file path", () => {
    for (const value of [
      "",
      "report.docx",
      "/etc/passwd",
      "/home/gem/workspace-evil/x.png",
      "//home/gem/workspace/x.png",
      `${ROOT}/a\\b.png`,
      `${ROOT}/bad\nname.png`,
      `${ROOT}/bad\u0000name.png`,
      `${ROOT}/-option.png`,
      `${ROOT}/a/-b.png`,
      ROOT,
      `${ROOT}/`,
      "/".repeat(3),
      `/${"a".repeat(5000)}`,
    ]) {
      expect(requireWorkspaceFilePath(value, ROOT).ok, JSON.stringify(value)).toBe(false);
    }
  });

  it("treats a non-string input as missing", () => {
    expect(requireWorkspaceFilePath(undefined as unknown as string, ROOT).ok).toBe(false);
    expect(requireWorkspaceFilePath(123 as unknown as string, ROOT).ok).toBe(false);
  });

  it("reports the same workspace containment the container check uses", () => {
    expect(isInsideWorkspace(`${ROOT}/a/b.png`, ROOT)).toBe(true);
    expect(isInsideWorkspace(ROOT, ROOT)).toBe(true);
    expect(isInsideWorkspace("/home/gem/workspace-evil/a.png", ROOT)).toBe(false);
    expect(isInsideWorkspace("/home/gem/etc/passwd", ROOT)).toBe(false);
  });
});

describe("document kind classification", () => {
  it("maps extensions to the right rendering strategy", () => {
    expect(documentKind(`${ROOT}/x.PNG`)).toBe("image");
    expect(documentKind(`${ROOT}/x.pdf`)).toBe("pdf");
    expect(documentKind(`${ROOT}/x.docx`)).toBe("word");
    expect(documentKind(`${ROOT}/x.doc`)).toBe("word");
    expect(documentKind(`${ROOT}/x.xlsx`)).toBe("excel");
    expect(documentKind(`${ROOT}/x.pptx`)).toBe("ppt");
    expect(documentKind(`${ROOT}/x.txt`)).toBe("text");
    expect(documentKind(`${ROOT}/x`)).toBe("unsupported");
    expect(documentKind(`${ROOT}/x.exe`)).toBe("unsupported");
    expect(documentKind(`${ROOT}/x.png.txt`)).toBe("text");
  });

  it("treats HTML and SVG as text, never as renderable markup", () => {
    expect(documentKind(`${ROOT}/x.html`)).toBe("text");
    expect(documentKind(`${ROOT}/x.svg`)).toBe("text");
    expect(isRenderableKind("text")).toBe(false);
  });

  it("only rasterisable kinds are renderable", () => {
    for (const kind of ["image", "pdf", "word", "excel", "ppt"] as const) {
      expect(isRenderableKind(kind), kind).toBe(true);
    }
    expect(isRenderableKind("unsupported")).toBe(false);
  });

  it("extensionOf ignores a dotfile and a name with no extension", () => {
    expect(extensionOf(`${ROOT}/x.docx`)).toBe("docx");
    expect(extensionOf(`${ROOT}/.env`)).toBe("");
    expect(extensionOf(`${ROOT}/x`)).toBe("");
  });
});

describe("output naming", () => {
  it("swaps the extension while keeping the stem", () => {
    expect(withExtension("report.docx", "pdf")).toBe("report.pdf");
    expect(withExtension("report", "pdf")).toBe("report.pdf");
    expect(withExtension("a.b.c.docx", "pdf")).toBe("a.b.c.pdf");
    expect(withExtension(".hidden", "pdf")).toBe("document.pdf");
  });

  it("splits a validated path", () => {
    expect(splitPath(`${ROOT}/a/b.docx`)).toEqual({ dir: `${ROOT}/a`, base: "b.docx" });
    expect(splitPath("/x")).toEqual({ dir: "/", base: "x" });
  });

  it("accepts only narrow base names for tool output", () => {
    expect(isSafeBaseName("report.docx")).toBe(true);
    for (const name of ["", ".hidden", "-flag", "a/b", "a\\b", "a\nb", "x".repeat(200)]) {
      expect(isSafeBaseName(name), JSON.stringify(name)).toBe(false);
    }
  });
});

describe("shell quoting", () => {
  it("single-quotes a value so it cannot break out", () => {
    expect(quoteArg("/home/gem/workspace/a b")).toBe("'/home/gem/workspace/a b'");
    expect(quoteArg("it's")).toBe("'it'\\''s'");
  });
});
