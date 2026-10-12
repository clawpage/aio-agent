import type { time as zh } from '../zh/time';
export const time: typeof zh = {
  justNow: "剛剛",
  minutesAgo: (n: number) => `${n} 分鐘前`,
  today: (clock: string) => `今天 ${clock}`,
  yesterday: (clock: string) => `昨天 ${clock}`,
  /** `year` is null within the current year. */
  date: (year: number | null, month: number, day: number, clock: string) => `${year === null ? "" : `${year}年`}${month}月${day}日 ${clock}`,
  seconds: (s: number) => `${s} 秒`,
  minutesSeconds: (m: number, s: number) => `${m} 分 ${s} 秒`,
  hoursMinutes: (h: number, m: number) => `${h} 小時 ${m} 分`,
  running: (duration: string) => `已處理 ${duration}`,
  took: (duration: string) => `處理用時 ${duration}`,
  durationHint: "從開始執行到結束的經過時間，不含分配、排隊及執行前等待補充的時間；包含執行中等待確認的時間。",
  groups: {
    today: "今天",
    yesterday: "昨天",
    /** `weekday` is 0 (Sunday) to 6. */
    weekday: (weekday: number, month: number, day: number) => `${["週日", "週一", "週二", "週三", "週四", "週五", "週六"][weekday]} · ${month}月${day}日`,
    month: (month: number) => `${month}月`,
    yearMonth: (year: number, month: number) => `${year}年${month}月`,
  },
};
