export const gadget = {
  /** Shown while the gadget's account is unknown or unbound. */
  fallbackTitle: "语音配件",
  subtitle: "语音配件的对话记录 · 只读",
  logLabel: (title: string) => `${title} 的对话`,
  readFailed: "对话记录读取失败",
  loading: "正在读取对话…",
  unbound: "语音配件没有绑定独立账号，它的消息在主会话里。",
  empty: "还没有对话。",
  loadingOlder: "正在加载…",
  loadOlder: "加载更早的对话",
  failed: {
    failed: "回答失败",
    unknown: "结果未知",
    interrupted: "已停止",
  } as Record<string, string>,
  noReply: "没有回答",
  errorDetail: (error: string) => `：${error}`,
  answering: "正在回答…",
};
