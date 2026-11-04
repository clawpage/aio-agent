import type { Config } from "../config.js";
import type { Logger } from "../../common/logger.js";
import type { Analytics } from "../analytics.js";
import type { TaskService } from "../tasks/service.js";
import { t } from "../i18n/index.js";
import { KB_KINDS } from "./kernel.js";
import { listChanges, nodeChanges, restoreNode, undoChange } from "./ledger.js";
import { SharedKbError, type SharedKbs } from "./shared.js";

/**
 * The shared knowledge bases the account belongs to, managed by its agents as
 * tools of aio_task_kb (gateway.ts): everything the console's knowledge page
 * does for the signed-in person (docs/SHARED-KB.md §5, §3.4, §4), through the
 * same SharedKbs methods, so membership and the administrator's rights are
 * checked exactly as there. A library the account is not in does not exist here.
 */

export const LIBRARY_POLICY =
  "Shared knowledge bases are managed with these tools, with the same rights the person has on the console's knowledge page, acting as the person: kb_library_create sets one up (a name and the rules of what it keeps, or a preset), kb_libraries lists the person's libraries with their members, rules, domains and open invitation links, kb_library_manage renames one, changes its rules, makes or revokes an invitation link, leaves, removes a member, hands over administration or dissolves it, kb_library_join joins from a link the person gives you, kb_library_edit writes and organises its entries, and kb_library_history with kb_library_undo look back and undo. " +
  "Never open the console or its knowledge page in a browser for any of this, and never ask the person to do it there themselves; these tools do it directly. " +
  "Create a library or write entries when the person asks for it or their request clearly needs it. An invitation link lets anyone who has it join for 7 days: make one when the person wants someone to join and give it to them to pass on; do not send it to anyone yourself unless they asked you to. Remove a member, hand over administration, leave or dissolve (which deletes the library and all its entries for every member and cannot be undone) only when the person explicitly asked for that; otherwise ask them first. " +
  "Entries you write with kb_library_edit are recorded as the person's own words, so write only what they said or confirmed or what this task established; something you only came across while working goes through kb_propose with library, so the library's maintainer checks it against its rules. Never write passwords, codes, ID or card numbers.";

const LIBRARY = { type: "string", description: "The library's id or exact name, as kb_libraries lists it" };

export const LIBRARY_TOOLS = [
  {
    name: "kb_libraries",
    description: "The shared knowledge bases the person belongs to: each one's id, name, administrator, members, rules (what it keeps), domains, and open invitation links.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "kb_library_create",
    description: "Create a shared knowledge base with the person as its administrator and only member; invite others with kb_library_manage action invite. The rules say what the library keeps and what it does not; its maintainer and every member follow them.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "At most 40 characters, e.g. \"家庭日用品\" (\"Household supplies\")" }, // i18n-exempt: an example of what people type, for the executor
        rules: { type: "string", description: "What it keeps and what it does not, in the person's language (at most 4000 characters); omit to start from preset" },
        preset: { type: "string", enum: ["family", "project", "blank"], description: "Rules to start from when rules is omitted: family (a household's circumstances, preferences, schedules, services), project (goals, decisions, conventions, procedures), blank (none); default blank" },
      },
      required: ["name"],
    },
  },
  {
    name: "kb_library_manage",
    description: "Manage one shared knowledge base: rename (name), set_rules (rules), invite (returns a link anyone can use to join for 7 days; give it to the person), revoke_invite (invite id from kb_libraries), leave (the administrator hands over first, unless nobody else is left: then leaving dissolves it), and, for its administrator only, remove_member (member), make_admin (member), dissolve (deletes it for everyone, cannot be undone).",
    inputSchema: {
      type: "object",
      properties: {
        library: LIBRARY,
        action: { type: "string", enum: ["rename", "set_rules", "invite", "revoke_invite", "leave", "remove_member", "make_admin", "dissolve"] },
        name: { type: "string", description: "For rename" },
        rules: { type: "string", description: "For set_rules: the whole new text; earlier versions are kept" },
        invite: { type: "string", description: "For revoke_invite" },
        member: { type: "string", description: "For remove_member and make_admin: a member's name as kb_libraries lists it" },
      },
      required: ["library", "action"],
    },
  },
  {
    name: "kb_library_join",
    description: "Join a shared knowledge base from an invitation link the person gave you (…/knowledge?join=…).",
    inputSchema: { type: "object", properties: { link: { type: "string", description: "The invitation link, or the token after join=" } }, required: ["link"] },
  },
  {
    name: "kb_library_edit",
    description: "Write a shared knowledge base's entries as the person: create_entry (title, kind, domain, summary, claims), update_entry (node, and any of title, summary, domain, kind), delete_entry (node), add_claim (node, text), update_claim (claim, text), delete_claim (claim). Every save is one change in the library's history that any member can undo. Find entries with kb_search and kb_get.",
    inputSchema: {
      type: "object",
      properties: {
        library: LIBRARY,
        action: { type: "string", enum: ["create_entry", "update_entry", "delete_entry", "add_claim", "update_claim", "delete_claim"] },
        node: { type: "string", description: "An entry (node) id of this library" },
        claim: { type: "string", description: "A claim id of this library, from kb_get" },
        title: { type: "string" },
        kind: { type: "string", enum: [...KB_KINDS], description: "Default fact" },
        domain: { type: "string", description: "One of the library's domains (kb_libraries), default other" },
        summary: { type: "string", description: "One or two sentences (optional)" },
        claims: { type: "array", items: { type: "string" }, description: "For create_entry: up to 20 statements, one fact each" },
        text: { type: "string", description: "For add_claim and update_claim: the statement" },
      },
      required: ["library", "action"],
    },
  },
  {
    name: "kb_library_history",
    description: "A shared knowledge base's changes, newest first: id, who, what kind (maintainer, edit, undo, restore), which entry, when, how many rows, whether undone. With node, only the changes to that entry.",
    inputSchema: { type: "object", properties: { library: LIBRARY, node: { type: "string", description: "Only this entry (optional)" } }, required: ["library"] },
  },
  {
    name: "kb_library_undo",
    description: "Undo one change of a shared knowledge base (the undo is itself a change and can be undone); refused when a later change touched the same rows, so undo that first. With node, instead put that entry back as it was right after the change (change 0: before it existed).",
    inputSchema: { type: "object", properties: { library: LIBRARY, change: { type: "integer", description: "A change id from kb_library_history" }, node: { type: "string", description: "Optional, see above" } }, required: ["library", "change"] },
  },
];

export const LIBRARY_TOOL_NAMES = new Set(LIBRARY_TOOLS.map((tool) => tool.name));

export interface LibraryToolRuntime { cfg: Config; tasks: Pick<TaskService, "locale">; sharedKb?: SharedKbs; analytics?: Pick<Analytics, "track"> }

class ToolError extends Error {}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const day = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/** One of the person's libraries by id or exact name; anything else is unknown to them. */
function libraryOf(kbs: SharedKbs, userId: string, value: unknown): string {
  const v = str(value);
  const mine = kbs.librariesOf(userId);
  const byId = mine.find((l) => l.id === v);
  if (byId) return byId.id;
  const named = mine.filter((l) => l.name === v);
  if (named.length === 1) return named[0]!.id;
  if (named.length > 1) throw new ToolError(`More than one of the person's shared knowledge bases is called "${v}"; pass its id from kb_libraries.`);
  throw new ToolError(`The person belongs to no shared knowledge base "${v}" (theirs: ${mine.map((l) => `${l.name} (${l.id})`).join(", ") || "none"}).`);
}

/** A member of the library by name or account id. */
function memberOf(kbs: SharedKbs, library: string, value: unknown): string {
  const v = str(value);
  const found = kbs.members(library).find((m) => m.username === v || m.id === v);
  if (!found) throw new ToolError(`"${v}" is not a member of this library (members: ${kbs.members(library).map((m) => m.username).join(", ")}).`);
  return found.id;
}

/** Answer one of LIBRARY_TOOLS for the account; the caller turns what it throws into a tool error. */
export function callLibraryTool(runtime: LibraryToolRuntime, userId: string, name: string, args: Record<string, unknown>, log: Logger): unknown {
  const text = (value: unknown, isError = false) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) });
  const kbs = runtime.sharedKb;
  if (!kbs) return text("Shared knowledge bases are not available on this server.", true);
  const track = (event: string) => runtime.analytics?.track(event, { userId, props: { via: "agent" } });
  try {
    if (name === "kb_libraries") {
      const libraries = kbs.librariesOf(userId);
      return text(libraries.length
        ? libraries.map((l) => {
          const lib = kbs.library(l.id)!;
          return {
            id: l.id, name: l.name, admin: kbs.usernameOf(lib.admin_id), you_are_admin: l.admin,
            members: kbs.members(l.id).map((m) => m.username),
            rules: kbs.rules(l.id).text || "(none written yet: keep what the members would all find useful)",
            domains: (kbs.db(l.id).prepare("SELECT name FROM kb_domains WHERE owner_id=? ORDER BY name").all(l.id) as Array<{ name: string }>).map((d) => d.name),
            invites: kbs.invites(l.id, userId).map((i) => ({ id: i.id, by: i.createdBy, expires: day(i.expiresAt), uses: i.uses })),
          };
        })
        : "The person belongs to no shared knowledge base; everything goes to their personal one. Create one with kb_library_create, or join one with kb_library_join.");
    }
    if (name === "kb_library_create") {
      const preset = ["family", "project", "blank"].includes(str(args.preset)) ? (str(args.preset) as "family" | "project" | "blank") : "blank";
      const rules = typeof args.rules === "string" && args.rules.trim() ? args.rules : t(runtime.tasks.locale()).knowledge.presets[preset];
      const id = kbs.create(userId, args.name, rules);
      track("shared_kb_create");
      log.info("shared library created by an agent", { library: id });
      return text({ id, name: kbs.library(id)!.name, rules: kbs.rules(id).text, note: "Created; the person is its administrator and only member. To bring others in, make an invitation link with kb_library_manage action invite." });
    }
    if (name === "kb_library_join") {
      const link = str(args.link);
      let token = link;
      try { token = new URL(link).searchParams.get("join") ?? link; } catch { /* a bare token */ }
      const id = kbs.join(token, userId);
      track("shared_kb_join");
      return text(`Joined the shared knowledge base "${kbs.library(id)!.name}" (${id}).`);
    }
    const library = libraryOf(kbs, userId, args.library);
    const action = str(args.action);
    if (name === "kb_library_manage") {
      log.info("shared library managed by an agent", { library, action });
      switch (action) {
        case "rename": kbs.rename(library, userId, args.name); return text(`Renamed to "${kbs.library(library)!.name}".`);
        case "set_rules": return text(`Rules saved as version ${kbs.setRules(library, userId, args.rules ?? "")}.`);
        case "invite": {
          const invite = kbs.createInvite(library, userId);
          track("shared_kb_invite");
          return text({ invite: invite.id, url: `https://${runtime.cfg.primaryHost}/knowledge?join=${encodeURIComponent(invite.token)}`, expires: day(invite.expiresAt),
            note: "Anyone with this link can join until it expires or is revoked; it is shown only now. Give it to the person to send on." });
        }
        case "revoke_invite": kbs.revokeInvite(library, userId, str(args.invite)); return text("Invitation link revoked.");
        case "leave": return text(kbs.leave(library, userId).dissolved ? "Left; nobody else was in it, so the library is dissolved." : "Left the library; what the person wrote stays in it.");
        case "remove_member": kbs.removeMember(library, userId, memberOf(kbs, library, args.member)); return text("Removed from the library.");
        case "make_admin": kbs.transfer(library, userId, memberOf(kbs, library, args.member)); return text("Administration handed over.");
        case "dissolve": kbs.dissolve(library, userId); track("shared_kb_dissolve"); return text("The library is dissolved and deleted for every member.");
        default: return text(`unknown action ${action}`, true);
      }
    }
    if (name === "kb_library_edit") {
      const node = str(args.node), claim = str(args.claim);
      switch (action) {
        case "create_entry": return text({ node: kbs.createEntry(library, userId, args) });
        case "update_entry": kbs.updateNode(library, userId, node, args); return text("Entry saved.");
        case "delete_entry": kbs.deleteNode(library, userId, node); return text("Entry deleted (it can be undone from the history).");
        case "add_claim": return text({ claim: kbs.addClaim(library, userId, node, args.text) });
        case "update_claim": kbs.updateClaim(library, userId, claim, args.text); return text("Claim saved.");
        case "delete_claim": kbs.deleteClaim(library, userId, claim); return text("Claim deleted.");
        default: return text(`unknown action ${action}`, true);
      }
    }
    const db = kbs.db(library);
    if (name === "kb_library_history") {
      const node = str(args.node);
      const changes = node ? nodeChanges(db, node) : listChanges(db);
      return text(changes.length ? changes.map((c) => ({ ...c, by: kbs.usernameOf(c.by), at: day(c.at) })) : "No changes yet.");
    }
    if (name === "kb_library_undo") {
      const node = str(args.node);
      const r = node ? restoreNode(db, node, Number(args.change), userId) : undoChange(db, Number(args.change), userId);
      if (!r) return text("No such change", true);
      if (!r.ok) return text(`Refused: later changes touched the same rows (${r.conflicts.length}); undo the later ones first.`, true);
      return text(r.change === null ? "Nothing to undo." : `Done, as change ${r.change}.`);
    }
    return text(`unknown tool ${name}`, true);
  } catch (err) {
    if (err instanceof SharedKbError || err instanceof ToolError) return text(err.message, true);
    throw err;
  }
}
