import type { usage as zh } from '../zh/usage';
export const usage: typeof zh = {
  readFailed: "用量讀取失敗",
  unavailable: (names: string[]) => `${names.join("、")} 的資料暫時無法讀取，未計入合計。`,
  noUsage: "這段期間沒有已記錄的用量。",
  columns: {
    user: "使用者",
    total: "總 token",
    share: "佔比",
    input: "輸入",
    cached: "其中快取",
    output: "輸出",
    cost: "估算費用",
    quota: "今日額度",
    noPrice: "未定價",
  },
  roles: {
    owner: "擁有者",
    member: "成員",
  },
  notAvailable: "不可用",
  note: "token 總量 = 輸入 + 輸出，快取已包含在輸入中。統計一站的 Codex / Claude 執行與派單呼叫；不包含外部用戶端、圖片生成和 Jev 呼叫，也不代表訂閱額度或帳單。",
  historyNote: "歷史僅回填已儲存的 Codex 事件；舊 Claude、舊派單及未上報用量無法補齊。中斷時未收到報告的消耗可能缺失，跨日呼叫依收到用量報告的日期記帳。",
  /** `since`: when live collection began (null: not yet); `first`: the earliest record (null: none). */
  coverage: (name: string, since: string | null, first: string | null) => `${name}：即時採集${since ? `自 ${since}` : "待帳號執行器啟動"}；${first ? `最早記錄 ${first}` : "暫無記錄"}`,
  costNote: "估算費用按各帳號目前模型的 API 標價折算（美元/百萬 token：GPT-6.1 Sol 輸入 2、快取 0.10、輸出 10；GPT-6.1 Terra 1 / 0.05 / 5；Claude Sonnet 5.5 輸入 2、快取讀 0.20、快取寫 2.50、輸出 10），不是實際帳單：控制面走訂閱登入，不按 token 付費；定時任務實際用 Terra，也按帳號模型計，略偏高。價格來自第三方彙整，未經官方頁面核實。",
  quotaNote: "成員每日免費 1 億 token（輸入含快取 + 輸出），每天美西時間 2:00 重置、不累計，只計上線後的用量；用完當天暫停服務。擁有者不受限。",
};
