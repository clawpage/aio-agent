export const usage = {
  title: "token 用量",
  readFailed: "用量读取失败",
  chart: "每日用量",
  user: "用户",
  allUsers: "所有用户",
  unavailable: (names: string[]) => `${names.join("、")} 的数据暂时无法读取，未计入合计。`,
  noUsage: "这个时间段没有已记录用量。",
  columns: {
    user: "用户",
    date: "日期",
    total: "总 token",
    share: "占比",
    input: "输入",
    cached: "其中缓存",
    output: "输出",
  },
  roles: {
    owner: "所有者",
    member: "成员",
  },
  notAvailable: "不可用",
  daily: (who: string) => `每日明细 · ${who}`,
  allUsersTotal: "所有用户合计",
  note: "token 总量 = 输入 + 输出，缓存已包含在输入中。统计一站的 Codex / Claude 执行与派单调用；不包含外部客户端、图片生成和 Jev 调用，也不代表订阅额度或账单。",
  historyNote: "历史仅回填已保存的 Codex 事件；旧 Claude、旧派单及未上报用量无法补齐。中断时未收到报告的消耗可能缺失，跨日调用按收到用量报告的日期记账。",
  /** `since`: when live collection began (null: not yet); `first`: the earliest record (null: none). */
  coverage: (name: string, since: string | null, first: string | null) => `${name}：实时采集${since ? `自 ${since}` : "待账号执行器启动"}；${first ? `最早记录 ${first}` : "暂无记录"}`,
};
