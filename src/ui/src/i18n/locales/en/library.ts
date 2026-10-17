import type { library as zh } from "../zh/library";

export const library: typeof zh = {
  title: "Files",
  sub: "Pictures, documents and other files from the main chat, all in one place",
  back: "← Back to files",
  shelfGroup: "Filter by type",
  shelves: { all: "All", images: "Images", documents: "Documents", media: "Audio & video", other: "Other" },
  fromYou: "You sent",
  fromAi: "AI reply",
  openTask: (title: string) => `Open the conversation “${title}”`,
  emptyTitle: "No files yet",
  emptyBody: "Send pictures or documents in the main chat, or ask the AI for a spreadsheet, report or image. The files show up here on their own.",
  shelfEmpty: "No files of this type yet.",
  loading: "Loading…",
  loadFailed: "Couldn't load the files",
  retry: "Retry",
  noMore: "That's everything",
};
