export const time = {
  justNow: "刚刚",
  minutesAgo: (n: number) => `${n} 分钟前`,
  today: (clock: string) => `今天 ${clock}`,
  yesterday: (clock: string) => `昨天 ${clock}`,
  /** `year` is null within the current year. */
  date: (year: number | null, month: number, day: number, clock: string) => `${year === null ? "" : `${year}年`}${month}月${day}日 ${clock}`,
  seconds: (s: number) => `${s} 秒`,
  minutesSeconds: (m: number, s: number) => `${m} 分 ${s} 秒`,
  hoursMinutes: (h: number, m: number) => `${h} 小时 ${m} 分`,
  running: (duration: string) => `已处理 ${duration}`,
  took: (duration: string) => `处理用时 ${duration}`,
  durationHint: "从开始执行到结束的经过时间，不含分配、排队及执行前等待补充的时间；包含执行中等待确认的时间。",
  groups: {
    today: "今天",
    yesterday: "昨天",
    /** `weekday` is 0 (Sunday) to 6. */
    weekday: (weekday: number, month: number, day: number) => `${["周日", "周一", "周二", "周三", "周四", "周五", "周六"][weekday]} · ${month}月${day}日`,
    month: (month: number) => `${month}月`,
    yearMonth: (year: number, month: number) => `${year}年${month}月`,
  },
};
