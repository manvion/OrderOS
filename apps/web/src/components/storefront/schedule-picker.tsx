'use client';

import { useEffect, useState } from 'react';
import type { DayOption, Slot } from '@/lib/schedule-slots';

/**
 * A calendar-style "schedule for later" picker: a horizontal strip of upcoming days
 * (like the date rail in a food app) and, under it, tappable time chips for the
 * chosen day.
 *
 * Days the restaurant is closed are shown but dimmed and can't be picked; selecting
 * one surfaces a plain "closed" message rather than pretending times exist. Only real
 * open times are ever offered as chips, so a closed time can't be chosen by accident.
 */
export function SchedulePicker({
  slots,
  days,
  value,
  onChange,
  restaurantName,
}: {
  slots: Slot[];
  days: DayOption[];
  value: string;
  onChange: (iso: string) => void;
  restaurantName: string;
}) {
  const openDayKeys = new Set(slots.map((s) => s.day));
  const valueDay = slots.find((s) => s.iso === value)?.day;
  const firstOpen = days.find((d) => openDayKeys.has(d.key))?.key;

  const [pickedDay, setPickedDay] = useState(valueDay ?? firstOpen ?? days[0]?.key);

  // Follow an externally-set time (e.g. when "Schedule for later" is first chosen).
  useEffect(() => {
    if (valueDay && valueDay !== pickedDay) setPickedDay(valueDay);
  }, [valueDay, pickedDay]);

  const selectDay = (key: string) => {
    setPickedDay(key);
    const first = slots.find((s) => s.day === key);
    onChange(first?.iso ?? '');
  };

  const times = slots.filter((s) => s.day === pickedDay);
  const pickedLabel = days.find((d) => d.key === pickedDay)?.label ?? 'this day';

  return (
    <div className="space-y-3">
      {/* Day rail */}
      <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {days.map((d) => {
          const open = openDayKeys.has(d.key);
          const active = d.key === pickedDay;
          return (
            <button
              key={d.key}
              type="button"
              disabled={!open}
              onClick={() => selectDay(d.key)}
              className={`flex min-w-[4.25rem] shrink-0 flex-col items-center rounded-2xl border px-3 py-2.5 transition-colors ${
                active
                  ? 'border-brand bg-brand text-brand-foreground'
                  : open
                    ? 'hover:border-brand/50 hover:bg-accent/50'
                    : 'cursor-not-allowed opacity-40'
              }`}
            >
              <span className="text-xs font-medium">{d.label}</span>
              <span className="text-lg font-bold leading-tight tabular-nums">{d.dayNum}</span>
              <span className="text-[10px] uppercase tracking-wide opacity-70">
                {open ? d.month : 'Closed'}
              </span>
            </button>
          );
        })}
      </div>

      {/* Times, or a closed note. */}
      {times.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {times.map((s) => (
            <button
              key={s.iso}
              type="button"
              onClick={() => onChange(s.iso)}
              className={`rounded-full border px-4 py-2 text-sm font-medium tabular-nums transition-colors ${
                value === s.iso
                  ? 'border-brand bg-brand text-brand-foreground'
                  : 'hover:border-brand/50 hover:bg-accent/50'
              }`}
            >
              {s.time}
            </button>
          ))}
        </div>
      ) : (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          {restaurantName} is closed {pickedLabel === 'Today' ? 'today' : `on ${pickedLabel}`} —
          pick another day above.
        </p>
      )}
    </div>
  );
}
