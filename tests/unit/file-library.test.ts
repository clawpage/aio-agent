import { describe, expect, it } from "vitest";
import { fileShelf, libraryFiles } from "../../src/ui/src/fileLibrary.js";
import type { FileMessage } from "../../src/ui/src/types.js";

const ROOT = "/home/gem/workspace";
const message = (taskId: string, at: number, result: string): FileMessage =>
  ({ taskId, title: `任务 ${taskId}`, createdAt: at, completedAt: at + 5, result });

describe("the files page", () => {
  it("lists the files the replies show, newest first, each once where it last came up", () => {
    const files = libraryFiles([
      message("b", 200, `图在这：![](${ROOT}/tasks/b/chart.png)\n\n[报告](${ROOT}/tasks/b/report.docx)`),
      message("a", 100, `[旧报告](${ROOT}/tasks/b/report.docx)，[清单](${ROOT}/tasks/a/list.xlsx)`),
    ]);
    expect(files.map((f) => [f.path, f.taskId, f.at])).toEqual([
      [`${ROOT}/tasks/b/chart.png`, "b", 205],
      [`${ROOT}/tasks/b/report.docx`, "b", 205],
      [`${ROOT}/tasks/a/list.xlsx`, "a", 105],
    ]);
    expect(files[1]).toMatchObject({ title: "报告", kind: "word", taskTitle: "任务 b" });
  });

  it("leaves out what the person sent, web links, paths outside the workspace and paths only mentioned in code", () => {
    const files = libraryFiles([message("a", 1, [
      `原图 ![](${ROOT}/uploads/photo.jpg)，你发的 [合同](${ROOT}/uploads/合同.pdf)`,
      "[网页](https://example.com/report.pdf)",
      "[外面](/etc/passwd)",
      "`/home/gem/workspace/tasks/a/notes.md`",
      "```\n[代码](/home/gem/workspace/tasks/a/code.py)\n```",
    ].join("\n\n"))]);
    expect(files).toEqual([]);
  });

  it("shows an audio or video link on a line of its own like the conversation does, and keeps it", () => {
    const files = libraryFiles([message("a", 1, `[录音](${ROOT}/tasks/a/cry.mp3)`)]);
    expect(files.map((f) => f.kind)).toEqual(["audio"]);
  });

  it("puts each kind on a shelf", () => {
    expect(["image", "video", "audio", "pdf", "word", "excel", "ppt", "text", "unsupported"].map((k) => fileShelf(k as never)))
      .toEqual(["images", "media", "media", "documents", "documents", "documents", "documents", "documents", "other"]);
  });
});
