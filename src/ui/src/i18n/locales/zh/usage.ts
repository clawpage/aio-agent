export const usage = {
  readFailed: "用量读取失败",
  unavailable: (names: string[]) => `${names.join("、")} 的数据暂时无法读取，未计入合计。`,
  noUsage: "这个时间段没有已记录用量。",
  columns: {
    user: "用户",
    total: "总 token",
    share: "占比",
    input: "输入",
    cached: "其中缓存",
    output: "输出",
    cost: "估算费用",
    quota: "今日额度",
    noPrice: "未定价",
  },
  roles: {
    owner: "所有者",
    member: "成员",
  },
  notAvailable: "不可用",
  note: "token 总量 = 输入 + 输出，缓存已包含在输入中。统计一站的 Codex / Claude 执行与派单调用；不包含外部客户端、图片生成和 Jev 调用，也不代表订阅额度或账单。",
  historyNote: "历史仅回填已保存的 Codex 事件；旧 Claude、旧派单及未上报用量无法补齐。中断时未收到报告的消耗可能缺失，跨日调用按收到用量报告的日期记账。",
  /** `since`: when live collection began (null: not yet); `first`: the earliest record (null: none). */
  coverage: (name: string, since: string | null, first: string | null) => `${name}：实时采集${since ? `自 ${since}` : "待账号执行器启动"}；${first ? `最早记录 ${first}` : "暂无记录"}`,
  costNote: "估算费用按各账号当前模型的 API 标价折算（美元/百万 token：GPT-6.1 Sol 输入 2、缓存 0.10、输出 10；GPT-6.1 Terra 1 / 0.05 / 5；Claude Sonnet 5.5 输入 2、缓存读 0.20、缓存写 2.50、输出 10），不是实际账单：控制面走订阅登录，不按 token 付费；定时任务实际用 Terra，也按账号模型计，略偏高。价格来自第三方汇总，未经官方页面核实。",
  quotaNote: "成员每日免费 1 亿 token（输入含缓存 + 输出），每天美西时间 2:00 重置、不累计，只计上线后的用量；用完当天暂停服务。所有者不受限。",
};
