import { embedMediaLinks, extractFileRefs, type FileRef } from "./fileRefs";
import { SANDBOX_WORKSPACE_ROOT, type WorkspaceFileKind } from "./sandboxLink";
import type { FileMessage } from "./types";

/**
 * The files page: every file the AI made in the main session - the workspace files a
 * reply links or shows - sorted onto a few shelves by type. Web links are not files,
 * and what the person sent is not the AI's: attachments are uploaded to
 * `uploads/` (the control plane's upload directory), so a reply pointing back at one
 * leaves it out.
 */
export type FileShelf = "all" | "images" | "documents" | "media" | "other";
export const FILE_SHELVES: readonly FileShelf[] = ["all", "images", "documents", "media", "other"];

const UPLOADS = `${SANDBOX_WORKSPACE_ROOT}/uploads/`;

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
  /** The task to open for the reply it came from. */
  taskId: string;
  taskTitle: string;
  /** When the reply finished. */
  at: number;
}

/**
 * The files of the replies (newest first), each file once, where it last came up.
 * A reply is parsed with the same Markdown walk the conversation renders it with, so
 * a file is listed exactly when the conversation shows it.
 */
export function libraryFiles(messages: readonly FileMessage[]): LibraryFile[] {
  const seen = new Set<string>();
  const files: LibraryFile[] = [];
  for (const message of messages) {
    for (const ref of extractFileRefs(embedMediaLinks(message.result))) {
      if (seen.has(ref.path) || ref.path.startsWith(UPLOADS)) continue;
      seen.add(ref.path);
      files.push({ ...ref, taskId: message.taskId, taskTitle: message.title, at: message.completedAt ?? message.createdAt });
    }
  }
  return files;
}
