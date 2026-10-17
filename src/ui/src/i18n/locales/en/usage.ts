import type { usage as zh } from "../zh/usage";

export const usage: typeof zh = {
  title: "Token usage",
  readFailed: "Couldn't load usage",
  chart: "Daily usage",
  user: "User",
  allUsers: "All users",
  unavailable: (names: string[]) => `Data for ${names.join(", ")} can't be read right now and isn't included in the totals.`,
  noUsage: "No usage recorded in this period.",
  columns: {
    user: "User",
    date: "Date",
    total: "Total tokens",
    share: "Share",
    input: "Input",
    cached: "Cached",
    output: "Output",
  },
  roles: {
    owner: "Owner",
    member: "Member",
  },
  notAvailable: "Unavailable",
  daily: (who: string) => `Daily breakdown · ${who}`,
  allUsersTotal: "All users combined",
  note: "Total tokens = input + output; cached tokens are counted in input. Covers Clawpage Agent's Codex / Claude runs and dispatch calls. Excludes external clients, image generation and Jev calls, and doesn't reflect subscription limits or billing.",
  historyNote: "History is backfilled only from saved Codex events; older Claude and dispatch usage, and anything never reported, can't be recovered. Usage that wasn't reported before an interruption may be missing; calls spanning midnight count on the day their usage report arrived.",
  coverage: (name: string, since: string | null, first: string | null) => `${name}: ${since ? `live tracking since ${since}` : "live tracking starts when the account's executor starts"}; ${first ? `earliest record ${first}` : "no records yet"}`,
};
