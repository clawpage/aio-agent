import type { gadget as zh } from '../zh/gadget';
export const gadget: typeof zh = {
  /** Shown while the gadget's account is unknown or unbound. */
  fallbackTitle: "語音配件",
  subtitle: "語音配件的對話記錄 · 只讀",
  logLabel: (title: string) => `${title} 的對話`,
  readFailed: "對話記錄讀取失敗",
  loading: "正在讀取對話…",
  unbound: "語音配件沒有繫結獨立帳號，它的訊息在主對話裡。",
  empty: "還沒有對話。",
  loadingOlder: "正在載入…",
  loadOlder: "載入更早的對話",
  failed: {
    failed: "回答失敗",
    unknown: "結果未知",
    interrupted: "已停止",
  } as Record<string, string>,
  noReply: "沒有回答",
  errorDetail: (error: string) => `：${error}`,
  answering: "正在回答…",
};
