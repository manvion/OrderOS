/**
 * Business hours. Stored on Restaurant as JSON.
 *
 * Times are "HH:mm" strings in the restaurant's own IANA timezone (not UTC) —
 * a restaurant that closes at 22:00 closes at 22:00 local, regardless of DST.
 * Overnight windows are supported: close < open means the window crosses midnight.
 */

export const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface HoursWindow {
  open: string; // "09:00"
  close: string; // "22:00" (or "02:00" for an overnight close)
}

export interface DayHours {
  closed: boolean;
  /** Multiple windows support split shifts, e.g. lunch 11-14 and dinner 17-22. */
  windows: HoursWindow[];
}

export type BusinessHours = Record<Weekday, DayHours>;

export const DEFAULT_BUSINESS_HOURS: BusinessHours = WEEKDAYS.reduce((acc, day) => {
  acc[day] = { closed: false, windows: [{ open: '11:00', close: '22:00' }] };
  return acc;
}, {} as BusinessHours);

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Local wall-clock parts for `at` in the given IANA timezone. */
function localParts(at: Date, timezone: string): { weekday: Weekday; minutes: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(at);
  const weekday = parts.find((p) => p.type === 'weekday')!.value.toLowerCase() as Weekday;
  const hour = Number(parts.find((p) => p.type === 'hour')!.value);
  const minute = Number(parts.find((p) => p.type === 'minute')!.value);
  return { weekday, minutes: hour * 60 + minute };
}

function previousWeekday(day: Weekday): Weekday {
  const i = WEEKDAYS.indexOf(day);
  return WEEKDAYS[(i + WEEKDAYS.length - 1) % WEEKDAYS.length];
}

/**
 * Is the restaurant open at `at`? Handles split shifts and overnight windows
 * (a window opened yesterday that runs past midnight still counts as open).
 */
export function isOpenAt(hours: BusinessHours, timezone: string, at: Date = new Date()): boolean {
  const { weekday, minutes } = localParts(at, timezone);

  const inWindowToday = (hours[weekday]?.closed === false ? hours[weekday].windows : []).some(
    (w) => {
      const open = toMinutes(w.open);
      const close = toMinutes(w.close);
      // Overnight window: open today, closes tomorrow.
      if (close <= open) return minutes >= open;
      return minutes >= open && minutes < close;
    },
  );
  if (inWindowToday) return true;

  // A window that started yesterday and crossed midnight may still be running.
  const yesterday = previousWeekday(weekday);
  const y = hours[yesterday];
  if (!y || y.closed) return false;
  return y.windows.some((w) => {
    const open = toMinutes(w.open);
    const close = toMinutes(w.close);
    return close <= open && minutes < close;
  });
}
