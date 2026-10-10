import type { gadget as zh } from "../zh/gadget";

export const gadget: typeof zh = {
  fallbackTitle: "Voice gadget",
  subtitle: "Voice gadget conversations · Read-only",
  logLabel: (title: string) => `Conversation with ${title}`,
  readFailed: "Couldn't load conversations",
  loading: "Loading conversations…",
  unbound: "The voice gadget isn't bound to its own account; its messages are in the main chat.",
  empty: "No conversations yet.",
  loadingOlder: "Loading…",
  loadOlder: "Load earlier conversations",
  failed: {
    failed: "Reply failed",
    unknown: "Result unknown",
    interrupted: "Stopped",
  },
  noReply: "No reply",
  errorDetail: (error: string) => `: ${error}`,
  answering: "Replying…",
};
