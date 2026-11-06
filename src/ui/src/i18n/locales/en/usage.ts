import type { usage as zh } from "../zh/usage";

export const usage: typeof zh = {
  readFailed: "Couldn't load usage",
  unavailable: (names: string[]) => `Data for ${names.join(", ")} can't be read right now and isn't included in the totals.`,
  noUsage: "No usage recorded in this period.",
  columns: {
    user: "User",
    total: "Total tokens",
    share: "Share",
    input: "Input",
    cached: "Cached",
    output: "Output",
    cost: "Est. cost",
    quota: "Today",
    noPrice: "No price",
  },
  roles: {
    owner: "Owner",
    member: "Member",
  },
  notAvailable: "Unavailable",
  note: "Total tokens = input + output; cached tokens are counted in input. Covers Clawpage Agent's Codex / Claude runs and dispatch calls. Excludes external clients, image generation and Jev calls, and doesn't reflect subscription limits or billing.",
  historyNote: "History is backfilled only from saved Codex events; older Claude and dispatch usage, and anything never reported, can't be recovered. Usage that wasn't reported before an interruption may be missing; calls spanning midnight count on the day their usage report arrived.",
  coverage: (name: string, since: string | null, first: string | null) => `${name}: ${since ? `live tracking since ${since}` : "live tracking starts when the account's executor starts"}; ${first ? `earliest record ${first}` : "no records yet"}`,
  costNote: "Estimated cost uses each account's current model at API list prices (USD per million tokens: GPT-6.1 Sol input 2, cached 0.10, output 10; GPT-6.1 Terra 1 / 0.05 / 5; Claude Sonnet 5.5 input 2, cache read 0.20, cache write 2.50, output 10). It isn't billing: the control plane signs in with subscriptions and doesn't pay per token. Scheduled runs actually use Terra but are costed at the account's model, so this runs slightly high. Prices come from third-party listings and weren't checked against official pages.",
  quotaNote: "Members get 100M free tokens a day (input including cache, plus output). The day resets at 2:00 Pacific time, unused tokens don't carry over, and only usage since launch counts. Once used up, service pauses for the rest of the day. The owner has no limit.",
};
