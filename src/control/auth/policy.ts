import type { Db } from "../db.js";
import { getUser } from "./owner.js";

/** Runs on the control plane's own ChatGPT login through the member gateway, which adds it on the host. */
export const MEMBER_GPT_MODEL = "gpt-6.1-sol";
/** Runs on Claude Code through the member gateway, with the owner's credential kept on the host. */
export const MEMBER_CLAUDE_MODEL = "claude-sonnet-5-5";
/** What a member runs unless the administrator assigned otherwise. */
export const MEMBER_MODEL = MEMBER_GPT_MODEL;
/** The models an administrator may assign to a member (`bin/set-user-model.mjs`). */
export const MEMBER_MODELS: readonly string[] = [MEMBER_GPT_MODEL, MEMBER_CLAUDE_MODEL];
export const MEMBER_EFFORT = "high";
export function isMember(db: Db, userId: string): boolean {
  return getUser(db, userId)?.role === "member";
}
/** Presentation metadata is private to the owner; this is not output-text censorship. */
export function publicPayload(value: unknown): any {
  if (Array.isArray(value)) return value.map(publicPayload);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !["model", "model_provider", "modelProvider", "effort", "reasoningEffort", "developerInstructions", "systemPrompt", "prompt"].includes(key)
  ).map(([key, v]) => [key, publicPayload(v)]));
}
