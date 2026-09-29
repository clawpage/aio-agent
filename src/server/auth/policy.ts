import type { Db } from "../db.js";
import { getUser } from "./owner.js";

export const MEMBER_MODEL = "deepseek-v4.1-flash";
export const MEMBER_SETTINGS = { model: MEMBER_MODEL, effort: "high" } as const;
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
