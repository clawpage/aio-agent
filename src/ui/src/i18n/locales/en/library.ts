import type { library as zh } from "../zh/library";

export const library: typeof zh = {
  title: "Files",
  sub: "Pictures, documents and other files the AI made in the main chat, all in one place",
  back: "← Back to files",
  shelfGroup: "Filter by type",
  shelves: { all: "All", images: "Images", documents: "Documents", media: "Audio & video", other: "Other" },
  openTask: (title: string) => `Open the conversation “${title}”`,
  emptyTitle: "No files yet",
  emptyBody: "Ask the AI for a spreadsheet, report or image, and the files it makes show up here on their own.",
  shelfEmpty: "No files of this type yet.",
  loading: "Loading…",
  loadFailed: "Couldn't load the files",
  retry: "Retry",
  noMore: "That's everything",
};
