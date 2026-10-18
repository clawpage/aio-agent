import type { usage as zh } from '../zh/usage';
export const usage: typeof zh = {
  title: "token 用量",
  readFailed: "用量讀取失敗",
  chart: "每日用量",
  user: "使用者",
  allUsers: "所有使用者",
  unavailable: (names: string[]) => `${names.join("、")} 的資料暫時無法讀取，未計入合計。`,
  noUsage: "這段期間沒有已記錄的用量。",
  columns: {
    user: "使用者",
    date: "日期",
    total: "總 token",
    share: "佔比",
    input: "輸入",
    cached: "其中快取",
    output: "輸出",
  },
  roles: {
    owner: "擁有者",
    member: "成員",
  },
  notAvailable: "不可用",
  daily: (who: string) => `每日明細 · ${who}`,
  allUsersTotal: "所有使用者合計",
  note: "token 總量 = 輸入 + 輸出，快取已包含在輸入中。統計一站的 Codex / Claude 執行與派單呼叫；不包含外部用戶端、圖片生成和 Jev 呼叫，也不代表訂閱額度或帳單。",
  historyNote: "歷史僅回填已儲存的 Codex 事件；舊 Claude、舊派單及未上報用量無法補齊。中斷時未收到報告的消耗可能缺失，跨日呼叫依收到用量報告的日期記帳。",
  /** `since`: when live collection began (null: not yet); `first`: the earliest record (null: none). */
  coverage: (name: string, since: string | null, first: string | null) => `${name}：即時採集${since ? `自 ${since}` : "待帳號執行器啟動"}；${first ? `最早記錄 ${first}` : "暫無記錄"}`,
};
