export type TokenCounts = { input: number; output: number; cached: number; cacheWrite: number };
export type UsageDay = TokenCounts & { date: string; total: number };
export type AccountUsage = {
  id: string; username: string; role: string; available: boolean;
  collectionStartedAt: number | null; firstRecordAt: number | null;
  days: UsageDay[]; totals: TokenCounts & { total: number };
};
export type UsageReport = { timezone: string; days: number; dates: string[]; accounts: AccountUsage[]; generatedAt: number };
