import { attachmentRefs, embedMediaLinks, extractFileRefs, type FileRef } from "./fileRefs";
import type { WorkspaceFileKind } from "./sandboxLink";
import type { FileMessage } from "./types";

/**
 * The files page: every file the main session shows as a card or in place - what
 * the person attached, and the workspace files a reply links or shows - sorted onto
 * a few shelves by type. Web links are not files and never appear here.
 */
export type FileShelf = "all" | "images" | "documents" | "media" | "other";
export const FILE_SHELVES: readonly FileShelf[] = ["all", "images", "documents", "media", "other"];

const SHELF: Record<WorkspaceFileKind, Exclude<FileShelf, "all">> = {
  image: "images",
  video: "media", audio: "media",
  pdf: "documents", word: "documents", excel: "documents", ppt: "documents", text: "documents",
  unsupported: "other",
};

export function fileShelf(kind: WorkspaceFileKind): Exclude<FileShelf, "all"> {
  return SHELF[kind];
}

export interface LibraryFile extends FileRef {
  /** The task to open for the message it came from. */
  taskId: string;
  taskTitle: string;
  /** When it came up: sent with the message, or in the reply when that finished. */
  at: number;
  from: "you" | "ai";
}

/**
 * The files of the messages (newest first), each file once, where it last came up.
 * A reply is parsed with the same Markdown walk the conversation renders it with, so
 * a file is listed exactly when the conversation shows it.
 */
export function libraryFiles(messages: readonly FileMessage[]): LibraryFile[] {
  const seen = new Set<string>();
  const files: LibraryFile[] = [];
  const add = (refs: FileRef[], message: FileMessage, from: LibraryFile["from"], at: number): void => {
    for (const ref of refs) {
      if (seen.has(ref.path)) continue;
      seen.add(ref.path);
      files.push({ ...ref, taskId: message.taskId, taskTitle: message.title, at, from });
    }
  };
  for (const message of messages) {
    // The reply came after what was sent with it.
    if (message.result) add(extractFileRefs(embedMediaLinks(message.result)), message, "ai", message.completedAt ?? message.createdAt);
    add(attachmentRefs(message.attachments), message, "you", message.createdAt);
  }
  return files;
}
