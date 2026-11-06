export type TokenCounts = { input: number; output: number; cached: number; cacheWrite: number };
/** `usd`: the estimated cost at list API prices, null when the account's model has no price on record. */
export type UsageDay = TokenCounts & { date: string; total: number; usd: number | null };
export type AccountUsage = {
  id: string; username: string; role: string; available: boolean;
  collectionStartedAt: number | null; firstRecordAt: number | null;
  days: UsageDay[]; totals: TokenCounts & { total: number; usd: number | null };
  /** The model the cost is estimated at (the account's own); `quota`: today's use of a member's daily tokens. */
  model: string | null; quota: QuotaStatus | null;
};
export type UsageReport = { timezone: string; days: number; dates: string[]; accounts: AccountUsage[]; generatedAt: number };
/** A member's use of today's tokens; the day turns over at `resetsAt`. */
export type QuotaStatus = { limit: number; used: number; resetsAt: number; exceeded: boolean };
