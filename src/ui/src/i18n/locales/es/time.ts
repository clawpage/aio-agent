import type { time as zh } from '../zh/time';
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const FULL_MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const WEEKDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
export const time: typeof zh = {
  justNow: 'Ahora', minutesAgo: (n: number) => `Hace ${n} min`, today: (clock: string) => `Hoy ${clock}`, yesterday: (clock: string) => `Ayer ${clock}`,
  date: (year: number | null, month: number, day: number, clock: string) => `${day} ${MONTHS[month - 1]}${year === null ? '' : ` ${year}`}, ${clock}`,
  seconds: (s: number) => `${s}s`, minutesSeconds: (m: number, s: number) => `${m}m ${s}s`, hoursMinutes: (h: number, m: number) => `${h}h ${m}m`,
  running: (duration: string) => `En ejecución durante ${duration}`, took: (duration: string) => `Duración: ${duration}`, durationHint: 'Tiempo desde el inicio hasta el final de la ejecución. Excluye la asignación, la cola y la espera de respuestas antes de empezar; incluye la espera de confirmación durante la ejecución.',
  groups: { today: 'Hoy', yesterday: 'Ayer', weekday: (weekday: number, month: number, day: number) => `${WEEKDAYS[weekday]} · ${day} ${MONTHS[month - 1]}`, month: (month: number) => FULL_MONTHS[month - 1], yearMonth: (year: number, month: number) => `${FULL_MONTHS[month - 1]} ${year}` },
};
