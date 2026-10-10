import type { time as zh } from "../zh/time";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FULL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const time: typeof zh = {
  justNow: "Just now",
  minutesAgo: (n: number) => `${n} min ago`,
  today: (clock: string) => `Today ${clock}`,
  yesterday: (clock: string) => `Yesterday ${clock}`,
  date: (year: number | null, month: number, day: number, clock: string) => `${MONTHS[month - 1]} ${day}${year === null ? "" : `, ${year}`}, ${clock}`,
  seconds: (s: number) => `${s}s`,
  minutesSeconds: (m: number, s: number) => `${m}m ${s}s`,
  hoursMinutes: (h: number, m: number) => `${h}h ${m}m`,
  running: (duration: string) => `Running for ${duration}`,
  took: (duration: string) => `Took ${duration}`,
  durationHint: "Time from the start of execution to the end. Excludes assigning, queueing and waiting for your input before it started; includes waiting for confirmation while running.",
  groups: {
    today: "Today",
    yesterday: "Yesterday",
    weekday: (weekday: number, month: number, day: number) => `${WEEKDAYS[weekday]} · ${MONTHS[month - 1]} ${day}`,
    month: (month: number) => FULL_MONTHS[month - 1],
    yearMonth: (year: number, month: number) => `${FULL_MONTHS[month - 1]} ${year}`,
  },
};
