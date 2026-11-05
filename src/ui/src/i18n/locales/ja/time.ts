import type { time as zh } from '../zh/time';

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

export const time: typeof zh = {
  justNow: 'たった今',
  minutesAgo: (n: number) => `${n} 分前`,
  today: (clock: string) => `今日 ${clock}`,
  yesterday: (clock: string) => `昨日 ${clock}`,
  /** `year` is null within the current year. */
  date: (year: number | null, month: number, day: number, clock: string) => `${year === null ? '' : `${year}年`}${month}月${day}日 ${clock}`,
  seconds: (s: number) => `${s} 秒`,
  minutesSeconds: (m: number, s: number) => `${m} 分 ${s} 秒`,
  hoursMinutes: (h: number, m: number) => `${h} 時間 ${m} 分`,
  running: (duration: string) => `${duration} 経過`,
  took: (duration: string) => `処理時間 ${duration}`,
  durationHint: '実行開始から終了までの経過時間です。振り分け・待機中、および実行前の補足待ちの時間は含みません。実行中の確認待ちの時間は含みます。',
  groups: {
    today: '今日',
    yesterday: '昨日',
    /** `weekday` is 0 (Sunday) to 6. */
    weekday: (weekday: number, month: number, day: number) => `${month}月${day}日（${WEEKDAYS[weekday]}）`,
    month: (month: number) => `${month}月`,
    yearMonth: (year: number, month: number) => `${year}年${month}月`,
  },
};
