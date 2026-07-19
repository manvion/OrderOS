'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useApi, useDashboard } from './dashboard-provider';
import { ApiRequestError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/primitives';

/**
 * Table reservations settings — "simple capacity per slot".
 *
 * The owner turns bookings on and sets how many they'll take per slot, the slot
 * length, the biggest party, the minimum notice, and how far ahead the calendar
 * opens. Availability is derived from these plus their opening hours.
 */
export function ReservationsSettings() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { restaurant, can } = useDashboard();

  const [enabled, setEnabled] = useState(restaurant?.reservationsEnabled ?? false);
  const [capacity, setCapacity] = useState(restaurant?.reservationCapacityPerSlot ?? 0);
  const [slot, setSlot] = useState(restaurant?.reservationSlotMinutes ?? 30);
  const [maxParty, setMaxParty] = useState(restaurant?.reservationMaxPartySize ?? 10);
  const [lead, setLead] = useState(restaurant?.reservationLeadHours ?? 2);
  const [windowDays, setWindowDays] = useState(restaurant?.reservationWindowDays ?? 30);

  const save = useMutation({
    mutationFn: () =>
      api.updateCurrent({
        reservationsEnabled: enabled,
        reservationCapacityPerSlot: capacity,
        reservationSlotMinutes: slot,
        reservationMaxPartySize: maxParty,
        reservationLeadHours: lead,
        reservationWindowDays: windowDays,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.success('Reservation settings saved.');
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not save'),
  });

  if (!restaurant) return null;
  const readOnly = !can('MANAGER');

  const changed =
    enabled !== restaurant.reservationsEnabled ||
    capacity !== restaurant.reservationCapacityPerSlot ||
    slot !== restaurant.reservationSlotMinutes ||
    maxParty !== restaurant.reservationMaxPartySize ||
    lead !== restaurant.reservationLeadHours ||
    windowDays !== restaurant.reservationWindowDays;

  const num = (v: string, min: number, max: number) =>
    Math.max(min, Math.min(max, Math.round(Number(v) || 0)));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Table reservations</CardTitle>
        <CardDescription>
          Let customers book a table from your site. Availability comes from your opening
          hours and the capacity you set here.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        <div className="grid gap-2 sm:grid-cols-2">
          {(
            [
              { value: false, label: 'Off' },
              { value: true, label: 'Taking bookings' },
            ] as const
          ).map(({ value, label }) => (
            <button
              key={label}
              type="button"
              disabled={readOnly}
              onClick={() => setEnabled(value)}
              className={`rounded-xl border p-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                enabled === value ? 'border-brand-subtle bg-brand-subtle' : 'hover:bg-accent/50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {enabled && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Tables per time slot" hint="How many bookings you'll take at once">
              <Input
                type="number"
                min={0}
                max={100}
                value={capacity}
                onChange={(e) => setCapacity(num(e.target.value, 0, 100))}
                disabled={readOnly}
              />
            </Field>
            <Field label="Slot length (minutes)" hint="e.g. 30 → 6:00, 6:30, 7:00…">
              <Input
                type="number"
                min={15}
                max={240}
                step={15}
                value={slot}
                onChange={(e) => setSlot(num(e.target.value, 15, 240))}
                disabled={readOnly}
              />
            </Field>
            <Field label="Largest party" hint="Bigger groups are told to call">
              <Input
                type="number"
                min={1}
                max={50}
                value={maxParty}
                onChange={(e) => setMaxParty(num(e.target.value, 1, 50))}
                disabled={readOnly}
              />
            </Field>
            <Field label="Minimum notice (hours)" hint="A 7pm table can't be booked at 6:59">
              <Input
                type="number"
                min={0}
                max={168}
                value={lead}
                onChange={(e) => setLead(num(e.target.value, 0, 168))}
                disabled={readOnly}
              />
            </Field>
            <Field label="Booking window (days ahead)" hint="How far out the calendar opens">
              <Input
                type="number"
                min={1}
                max={180}
                value={windowDays}
                onChange={(e) => setWindowDays(num(e.target.value, 1, 180))}
                disabled={readOnly}
              />
            </Field>
          </div>
        )}

        {enabled && capacity === 0 && (
          <p className="text-xs text-amber-600">
            Set “tables per time slot” to at least 1, or no times will be offered.
          </p>
        )}

        {!readOnly && changed && (
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save reservation settings'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
