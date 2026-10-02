import { describe, expect, it } from "vitest";
import { attachmentRefs, extractFileRefs } from "../../src/ui/src/fileRefs.js";

const ROOT = "/home/gem/workspace";

describe("message file references", () => {
  it("finds an image and a link, in order, deduplicated", () => {
    const refs = extractFileRefs(
      [
        `![缩略图](${ROOT}/a.png)`,
        `[报告](${ROOT}/report.docx)`,
        `[再看一次](${ROOT}/a.png)`,
      ].join("\n\n"),
    );
    expect(refs.map((r) => r.path)).toEqual([`${ROOT}/a.png`, `${ROOT}/report.docx`]);
    expect(refs[0]).toMatchObject({ image: true, kind: "image", name: "a.png" });
    expect(refs[1]).toMatchObject({ image: false, kind: "word", name: "report.docx" });
  });

  it("keeps a file name containing spaces or parentheses intact", () => {
    // A hand-written regex truncated both of these.
    const refs = extractFileRefs(
      [`[a](${ROOT}/my%20report%20(2024).docx)`, `[b](<${ROOT}/with space.xlsx>)`].join("\n\n"),
    );
    expect(refs.map((r) => r.path)).toEqual([`${ROOT}/my report (2024).docx`, `${ROOT}/with space.xlsx`]);
  });

  it("decodes percent-encoded non-ASCII names", () => {
    const refs = extractFileRefs(`[中文](${ROOT}/%E4%B8%AD%E6%96%87.png)`);
    expect(refs[0]?.path).toBe(`${ROOT}/中文.png`);
    expect(refs[0]?.name).toBe("中文.png");
  });

  it("resolves reference-style links", () => {
    const refs = extractFileRefs(["[报告][r]", "", "[r]: " + `${ROOT}/report.docx`].join("\n"));
    expect(refs.map((r) => r.path)).toEqual([`${ROOT}/report.docx`]);
  });

  it("never invents a reference from a code fence or inline code", () => {
    const markdown = [
      "```",
      `[link](${ROOT}/inside-fence.png)`,
      "```",
      "",
      `Use \`[x](${ROOT}/inside-inline.png)\` to preview.`,
      "",
      `[real](${ROOT}/real.png)`,
    ].join("\n");
    expect(extractFileRefs(markdown).map((r) => r.path)).toEqual([`${ROOT}/real.png`]);
  });

  it("ignores non-workspace and unsafe hrefs", () => {
    const markdown = [
      "[web](https://example.com/a.png)",
      "[etc](/etc/passwd)",
      "[escape](" + `${ROOT}/../.ssh/id_rsa)`,
      "[sibling](/home/gem/workspace-evil/x.png)",
      `[ok](${ROOT}/ok.txt)`,
    ].join("\n\n");
    expect(extractFileRefs(markdown).map((r) => r.path)).toEqual([`${ROOT}/ok.txt`]);
  });

  it("returns nothing for empty or malformed input instead of throwing", () => {
    expect(extractFileRefs("")).toEqual([]);
    expect(extractFileRefs("no links here")).toEqual([]);
  });
});

describe("attachment cards", () => {
  it("does not percent-decode a raw attachment path", () => {
    // `attachment.path` is a real filesystem path: decoding would turn `%20`
    // into a space and drop the card for a file genuinely named with `%`.
    const refs = attachmentRefs([{ path: `${ROOT}/100%25done.png`, name: "100%25done.png" }]);
    expect(refs.map((r) => r.path)).toEqual([`${ROOT}/100%25done.png`]);
  });

  it("keeps a real name with a percent sign", () => {
    const refs = attachmentRefs([{ path: `${ROOT}/a%20b.txt` }]);
    expect(refs.map((r) => r.path)).toEqual([`${ROOT}/a%20b.txt`]);
    expect(refs[0]?.name).toBe("a%20b.txt");
  });

  it("skips attachments outside the workspace and deduplicates", () => {
    const refs = attachmentRefs([
      { path: "/etc/passwd" },
      { path: `${ROOT}/a.png` },
      { path: `${ROOT}/a.png` },
      { path: "" },
      {},
    ]);
    expect(refs.map((r) => r.path)).toEqual([`${ROOT}/a.png`]);
    expect(refs[0]?.kind).toBe("image");
  });

  it("derives a name from the path for older turns", () => {
    const refs = attachmentRefs([{ path: `${ROOT}/nested/report.docx` }]);
    expect(refs[0]).toMatchObject({ name: "report.docx", kind: "word", image: false });
  });
});

it("uses descriptive document link titles without replacing the real download name",()=>{
  const [ref]=extractFileRefs('[完整行程](/home/gem/workspace/trip.md)');
  expect(ref).toMatchObject({title:'完整行程',name:'trip.md',path:'/home/gem/workspace/trip.md'});
  expect(extractFileRefs('[下载文件](/home/gem/workspace/trip.md)')[0]?.title).toBeUndefined();
});
