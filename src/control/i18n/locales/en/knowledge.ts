import type { knowledge as zh } from "../zh/knowledge.js";
export const knowledge: typeof zh = {
  notFound: "There's no such shared library, or you're not a member of it",
  adminOnly: "Only the administrator can do that",
  badName: (max: number) => `The name can't be empty and has at most ${max} characters`,
  rulesTooLong: (max: number) => `Rules have at most ${max} characters`,
  sensitive: "This looks like it contains a password, a code, an ID number or a card number, which never go into a knowledge base",
  inviteInvalid: "This invitation link is invalid, expired or revoked",
  transferFirst: "You're the administrator: hand that over to another member before you leave",
  cannotRemoveSelf: "You can't remove yourself; use Leave instead",
  notMember: "That person isn't a member of this library",
  required: "This can't be empty",
  tooLong: (max: number) => `At most ${max} characters`,
  badDomain: "There's no such domain",
  needContent: "Write at least one statement or a summary",
  undoConflict: (n: number) => `${n === 1 ? "One place was" : `${n} places were`} changed again after this change; undo the later changes first`,
  presets: {
    family: "Keep: family members' circumstances and preferences (food, allergies, routines, clothing sizes and so on), health and medical arrangements, the children's school and activities, family schedules and agreements, the stores and services the family uses (cleaning, repairs, doctors), how the family's devices and accounts work (never passwords), and decisions made together.\nDon't keep: things that concern only one person and help nobody else; work; one-off details; any passwords, codes, ID or card numbers.",
    project: "Keep: the project's goals and scope, decisions and why they were made, conventions (naming, process, who does what), key procedures and pitfalls, the people and systems involved, important links.\nDon't keep: small talk; temporary details only one task needs; personal matters; any keys, passwords or tokens.",
    blank: "",
  },
};
