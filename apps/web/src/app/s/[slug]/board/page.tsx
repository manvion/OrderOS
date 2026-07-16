'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChefHat, PartyPopper } from 'lucide-react';
import { storefrontApi, type StatusBoardEntry } from '@/lib/api';
import { useTenant } from '@/components/storefront/tenant-provider';

/** "Ready in 12:45" / "Any moment now" -- null while there's nothing to count down to yet. */
function formatCountdown(estimatedReadyAt: string | null, now: number): string | null {
  if (!estimatedReadyAt) return null;
  const diffMs = new Date(estimatedReadyAt).getTime() - now;
  if (diffMs <= 0) return 'Any moment now';
  const totalSeconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `Ready in ${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * The public "now serving" board -- meant for a TV by the counter, or a link a
 * pickup/dine-in customer can pull up on their own phone to watch their order
 * without asking staff. No sign-in: identified by the last 3 digits of the
 * order number (the same number texted to them the whole way through) paired
 * with their first name.
 *
 * Delivery orders never appear -- nobody standing in the restaurant is
 * waiting on one.
 */
export default function OrderStatusBoardPage() {
  const restaurant = useTenant();

  const { data: orders } = useQuery({
    queryKey: ['status-board', restaurant.slug],
    queryFn: () => storefrontApi.getStatusBoard(restaurant.slug),
    // Fast enough that a TV mounted on a wall looks live, cheap enough that
    // nobody has to touch the screen for it to be trusted.
    refetchInterval: 6_000,
  });

  // Ticks the countdown every second, independent of the 6s refetch -- a
  // countdown that shows seconds but only updates every 6 of them isn't one.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const preparing = (orders ?? []).filter((o) => o.status !== 'READY');
  const ready = (orders ?? []).filter((o) => o.status === 'READY');

  return (
    <div className="min-h-screen bg-foreground px-6 py-10 text-background sm:px-10">
      <h1 className="text-center font-display text-3xl font-semibold tracking-tight sm:text-5xl">
        {restaurant.name}
      </h1>
      <p className="mt-2 text-center text-sm text-background/60 sm:text-base">Order status</p>

      <div className="mx-auto mt-10 grid max-w-5xl gap-8 sm:grid-cols-2">
        <BoardColumn
          icon={ChefHat}
          label="Preparing"
          entries={preparing}
          emptyText="Nothing in the kitchen right now"
          accentClass="text-amber-400"
          now={now}
        />
        <BoardColumn
          icon={PartyPopper}
          label="Ready!"
          entries={ready}
          emptyText="Nothing ready yet"
          accentClass="text-emerald-400"
          highlight
        />
      </div>
    </div>
  );
}

function BoardColumn({
  icon: Icon,
  label,
  entries,
  emptyText,
  accentClass,
  highlight,
  now,
}: {
  icon: typeof ChefHat;
  label: string;
  entries: StatusBoardEntry[];
  emptyText: string;
  accentClass: string;
  highlight?: boolean;
  now?: number;
}) {
  return (
    <div
      className={`rounded-3xl border p-6 ${
        highlight ? 'border-emerald-400/30 bg-emerald-400/5' : 'border-background/10 bg-background/5'
      }`}
    >
      <div className={`flex items-center gap-2 text-lg font-bold uppercase tracking-wide ${accentClass}`}>
        <Icon className="h-5 w-5" />
        {label}
      </div>

      {entries.length === 0 ? (
        <p className="mt-6 text-sm text-background/40">{emptyText}</p>
      ) : (
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {entries.map((o, i) => {
            const countdown = now ? formatCountdown(o.estimatedReadyAt, now) : null;
            return (
              <div
                key={`${o.shortId}-${i}`}
                className={`animate-rise rounded-2xl border border-background/10 bg-background/10 px-2 py-6 text-center ${
                  highlight ? 'shadow-floating' : ''
                }`}
              >
                {o.fulfillment === 'DINE_IN' && o.tableNumber ? (
                  <>
                    <p className="text-xs uppercase tracking-widest text-background/50">Table</p>
                    <p className="font-mono text-4xl font-black leading-none tracking-widest sm:text-5xl">
                      {o.tableNumber}
                    </p>
                  </>
                ) : (
                  <p className="font-mono text-4xl font-black leading-none tracking-widest sm:text-5xl">
                    {o.shortId}
                  </p>
                )}
                {o.customerFirstName && (
                  <p className="mt-2.5 truncate px-2 text-lg font-semibold text-background/85 sm:text-xl">
                    {o.customerFirstName}
                  </p>
                )}
                {countdown && (
                  <p className="mt-2 font-mono text-base font-semibold text-background/70 sm:text-lg">
                    {countdown}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
