'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CalendarCheck, Check, Users } from 'lucide-react';
import { toast } from 'sonner';
import { ApiRequestError, storefrontApi, type ReservationSettings } from '@/lib/api';
import { useTenant } from './tenant-provider';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/primitives';

/** YYYY-MM-DD for a Date, in the browser's local calendar. */
function toDateInput(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The customer's table-booking flow.
 *
 * Pick a day and party size → we fetch the live slots → pick a time → leave a name
 * and number. The slot the customer taps carries its exact UTC instant (`iso`), so
 * the booking is never ambiguous across timezones or DST.
 */
export function ReserveForm({ settings }: { settings: ReservationSettings }) {
  const restaurant = useTenant();
  const slug = restaurant.slug;

  const today = useMemo(() => new Date(), []);
  const maxDate = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + settings.windowDays);
    return d;
  }, [settings.windowDays]);

  const [date, setDate] = useState(toDateInput(today));
  const [partySize, setPartySize] = useState(2);
  const [slotIso, setSlotIso] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [confirmed, setConfirmed] = useState<{ time: string; date: string } | null>(null);

  const slots = useQuery({
    queryKey: ['reservation-availability', slug, date],
    queryFn: () => storefrontApi.getReservationAvailability(slug, date),
    enabled: Boolean(date),
  });

  const book = useMutation({
    mutationFn: () => {
      if (!slotIso) throw new Error('Pick a time');
      return storefrontApi.book(slug, {
        customerName: name.trim(),
        customerPhone: phone.trim(),
        customerEmail: email.trim() || undefined,
        partySize,
        reservedAt: slotIso,
        notes: notes.trim() || undefined,
      });
    },
    onSuccess: (res) => {
      const when = new Date(res.reservedAt);
      setConfirmed({
        time: when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        date: when.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }),
      });
    },
    onError: (err) => {
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not book that table');
      // The slot may have just filled — refresh availability.
      void slots.refetch();
      setSlotIso(null);
    },
  });

  if (confirmed) {
    return (
      <div className="mx-auto max-w-md px-5 py-24 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-brand-subtle">
          <Check className="h-7 w-7 text-brand" />
        </div>
        <h1 className="mt-5 font-display text-3xl font-semibold tracking-tight">You&apos;re booked!</h1>
        <p className="mt-3 text-muted-foreground">
          A table for {partySize} at {restaurant.name} on {confirmed.date} at {confirmed.time}.
        </p>
        {email.trim() && (
          <p className="mt-1 text-sm text-muted-foreground">We&apos;ve emailed you a confirmation.</p>
        )}
      </div>
    );
  }

  const canBook = Boolean(slotIso && name.trim().length >= 2 && phone.trim().length >= 7);

  return (
    <div className="mx-auto max-w-2xl px-5 py-12 sm:px-8">
      <h1 className="font-display text-4xl font-semibold tracking-tight">Reserve a table</h1>
      <p className="mt-2 text-muted-foreground">Book online at {restaurant.name}.</p>

      <div className="mt-8 space-y-6">
        {/* Date + party */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="res-date">Date</Label>
            <Input
              id="res-date"
              type="date"
              value={date}
              min={toDateInput(today)}
              max={toDateInput(maxDate)}
              onChange={(e) => {
                setDate(e.target.value);
                setSlotIso(null);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="res-party">Party size</Label>
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
              <select
                id="res-party"
                value={partySize}
                onChange={(e) => setPartySize(Number(e.target.value))}
                className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
              >
                {Array.from({ length: settings.maxPartySize }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n} {n === 1 ? 'guest' : 'guests'}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Slots */}
        <div className="space-y-2">
          <Label>Time</Label>
          {slots.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading times…</p>
          ) : (slots.data?.length ?? 0) === 0 ? (
            <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
              No times available on this day — try another date.
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {slots.data!.map((s) => (
                <button
                  key={s.iso}
                  type="button"
                  disabled={!s.available}
                  onClick={() => setSlotIso(s.iso)}
                  className={`rounded-lg border py-2.5 text-sm font-medium tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
                    slotIso === s.iso
                      ? 'border-brand bg-brand text-brand-foreground'
                      : 'hover:bg-accent/50'
                  }`}
                >
                  {s.time}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Contact */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="res-name">Name</Label>
            <Input id="res-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="res-phone">Phone</Label>
            <Input id="res-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="res-email">Email (for your confirmation)</Label>
            <Input id="res-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="res-notes">Anything we should know? (optional)</Label>
            <Textarea
              id="res-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="A birthday, a highchair, a dietary need…"
              maxLength={500}
            />
          </div>
        </div>

        <Button
          variant="brand"
          size="lg"
          className="w-full"
          disabled={!canBook || book.isPending}
          onClick={() => book.mutate()}
        >
          <CalendarCheck className="h-4 w-4" />
          {book.isPending ? 'Booking…' : 'Book table'}
        </Button>
      </div>
    </div>
  );
}
