import { WEEKDAYS, type BusinessHours } from '@dinedirect/shared';

/**
 * The bookable "schedule for later" times for a storefront.
 *
 * A free datetime picker let customers choose a time the kitchen is closed, which the
 * server then rejected — and it read the time in the CUSTOMER's timezone, not the
 * restaurant's, so even a valid-looking choice could be wrong. This instead offers
 * only real slots: times inside the restaurant's opening hours, in the restaurant's
 * own timezone, from `leadMinutes` out to the 14-day scheduling horizon.
 */

export interface Slot {
  /** The exact instant, UTC ISO — sent to the API as scheduledFor. */
  iso: string;
  /** The calendar day it falls on, in the restaurant's tz (YYYY-MM-DD) — for grouping. */
  day: string;
  /** Friendly day name: "Today", "Tomorrow", or "Mon, Jul 21". */
  dayLabel: string;
  /** Time only, in the restaurant's tz, e.g. "6:30 PM". */
  time: string;
}

/** Offset (ms) the zone has at `date`: wallClock(tz) − UTC. */
function tzOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const map: Record<string, number> = {};
  for (const p of dtf.formatToParts(date)) if (p.type !== 'literal') map[p.type] = Number(p.value);
  const asUTC = Date.UTC(map.year, map.month - 1, map.day, map.hour, map.minute, map.second);
  return asUTC - date.getTime();
}

/** The UTC instant of a wall-clock time in `timeZone`. */
function zonedWallTimeToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  timeZone: string,
): Date {
  const naiveUTC = Date.UTC(y, mo - 1, d, h, mi, 0);
  return new Date(naiveUTC - tzOffsetMs(new Date(naiveUTC), timeZone));
}

/** Today's calendar date in `timeZone`. */
function todayInTz(timeZone: string): { y: number; mo: number; d: number } {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const map: Record<string, number> = {};
  for (const p of dtf.formatToParts(new Date())) if (p.type !== 'literal') map[p.type] = Number(p.value);
  return { y: map.year, mo: map.month, d: map.day };
}

export function scheduleSlots(
  hours: BusinessHours | null | undefined,
  timeZone: string,
  opts: { leadMinutes: number; days?: number; stepMinutes?: number } = { leadMinutes: 30 },
): Slot[] {
  if (!hours) return [];
  const step = opts.stepMinutes ?? 15;
  const days = opts.days ?? 7;
  const now = Date.now();
  const earliest = now + Math.max(15, opts.leadMinutes) * 60_000;
  const horizon = now + 14 * 24 * 60 * 60_000;

  const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' });
  const dayKeyFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const dayNameFmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

  const today = todayInTz(timeZone);
  const todayKey = `${today.y}-${String(today.mo).padStart(2, '0')}-${String(today.d).padStart(2, '0')}`;
  const tomorrow = new Date(Date.UTC(today.y, today.mo - 1, today.d + 1));
  const tomorrowKey = `${tomorrow.getUTCFullYear()}-${String(tomorrow.getUTCMonth() + 1).padStart(2, '0')}-${String(tomorrow.getUTCDate()).padStart(2, '0')}`;

  const slots: Slot[] = [];
  const seen = new Set<string>();

  for (let offset = 0; offset < days; offset++) {
    const cal = new Date(Date.UTC(today.y, today.mo - 1, today.d + offset));
    const y = cal.getUTCFullYear();
    const mo = cal.getUTCMonth() + 1;
    const d = cal.getUTCDate();
    const day = hours[WEEKDAYS[cal.getUTCDay()]];
    if (!day || day.closed) continue;

    for (const w of day.windows) {
      const [oh, om] = w.open.split(':').map(Number);
      let [ch, cm] = w.close.split(':').map(Number);
      let start = oh * 60 + om;
      let close = ch * 60 + cm;
      if (close <= start) close += 24 * 60; // overnight

      // Stop one step before close — nobody schedules a pickup for closing time.
      for (let m = start; m + step <= close; m += step) {
        const instant = zonedWallTimeToUtc(y, mo, d + Math.floor(m / (24 * 60)), Math.floor(m / 60) % 24, m % 60, timeZone);
        const t = instant.getTime();
        if (t < earliest || t > horizon) continue;
        const iso = instant.toISOString();
        if (seen.has(iso)) continue;
        seen.add(iso);
        const dayKey = dayKeyFmt.format(instant);
        const dayLabel =
          dayKey === todayKey ? 'Today' : dayKey === tomorrowKey ? 'Tomorrow' : dayNameFmt.format(instant);
        slots.push({ iso, day: dayKey, dayLabel, time: timeFmt.format(instant) });
      }
    }
  }

  slots.sort((a, b) => a.iso.localeCompare(b.iso));
  return slots.slice(0, 240);
}
