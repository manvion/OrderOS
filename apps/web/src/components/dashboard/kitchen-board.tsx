'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  BellOff,
  Check,
  ChefHat,
  Clock,
  Maximize2,
  ShoppingBag,
  Truck,
  UtensilsCrossed,
} from 'lucide-react';
import { toast } from 'sonner';
import { useApi, useDashboard } from './dashboard-provider';
import { ApiRequestError, type Order } from '@/lib/api';
import { Button } from '@/components/ui/button';

/**
 * The kitchen display. This runs on a tablet propped against the pass, and it is the
 * only screen in the product that someone uses while holding a hot pan.
 *
 * Everything here follows from that:
 *
 *  - THREE COLUMNS, not a list with a status dropdown. A chef needs to see the shape
 *    of the next twenty minutes at a glance: what's new, what's cooking, what's done
 *    and waiting to go. A table with a filter is a screen you have to read.
 *
 *  - ONE BUTTON per card, and it is enormous. The next action is never ambiguous —
 *    a new order gets Accept, a cooking order gets Ready. Greasy fingers, no
 *    precision, no "are you sure".
 *
 *  - IT MAKES A NOISE. An order that arrives silently during service is an order
 *    that gets found twenty minutes later, cold, with a customer on the phone. The
 *    sound is the feature; the screen is how you deal with it afterwards.
 *
 *  - THE HANDOFF CODE IS THE BIGGEST THING ON THE CARD. Bigger than the customer's
 *    name, bigger than the order number. It is what the bag gets labelled with, and
 *    what the courier or the customer reads back. Everything else on the card is
 *    context; that code is the job.
 *
 * It polls rather than holding a socket open, because a tablet in a kitchen sleeps,
 * loses wifi behind the extractor, and gets its screen wiped with a damp cloth. A
 * poll recovers from all of that by itself. A socket needs someone to notice.
 */
const POLL_MS = 5_000;

type Column = {
  key: string;
  title: string;
  statuses: string[];
  tone: string;
};

const COLUMNS: Column[] = [
  {
    key: 'new',
    title: 'New',
    statuses: ['PENDING'],
    tone: 'border-amber-400',
  },
  {
    key: 'cooking',
    title: 'Cooking',
    // Two real backend statuses share this one visual bucket. The action button
    // below is keyed off the CARD's own status, not the column, because ACCEPTED
    // and PREPARING are different legal transitions -- ACCEPTED must become
    // PREPARING before it can become READY. A column-wide "Ready" button here
    // used to fire straight from ACCEPTED and the API correctly rejected it.
    statuses: ['ACCEPTED', 'PREPARING'],
    tone: 'border-blue-400',
  },
  {
    key: 'ready',
    title: 'Ready',
    // Ready orders sit here until they physically leave: collected by the customer,
    // carried to a table, or handed to a courier.
    statuses: ['READY', 'DRIVER_ASSIGNED', 'OUT_FOR_DELIVERY'],
    tone: 'border-emerald-400',
  },
];

/** The one legal next step for a card, given its OWN status -- not its column's. */
function actionFor(status: string, fulfillment: string): { label: string; to: string } | undefined {
  switch (status) {
    case 'PENDING':
      return { label: 'Accept', to: 'ACCEPTED' };
    case 'ACCEPTED':
      return { label: 'Start preparing', to: 'PREPARING' };
    case 'PREPARING':
      return { label: 'Ready', to: 'READY' };
    case 'READY':
      // A delivery order at READY is Uber's problem now -- it advances on its own
      // once a courier is assigned, and the kitchen tapping "Picked up" would hide
      // a food-still-waiting order from the board while no driver is actually here.
      return fulfillment === 'DELIVERY' ? undefined : { label: 'Picked up', to: 'COMPLETED' };
    default:
      return undefined;
  }
}

const FULFILLMENT = {
  PICKUP: { icon: ShoppingBag, label: 'Pickup' },
  DELIVERY: { icon: Truck, label: 'Delivery' },
  DINE_IN: { icon: UtensilsCrossed, label: 'Dine in' },
} as const;

export function KitchenBoard() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { restaurant } = useDashboard();

  const [soundOn, setSoundOn] = useState(true);
  const seenIds = useRef<Set<string>>(new Set());
  const primed = useRef(false);

  const { data: orders, isLoading } = useQuery({
    queryKey: ['orders', 'active', restaurant?.id],
    queryFn: () => api.listActiveOrders(),
    enabled: Boolean(restaurant),
    refetchInterval: POLL_MS,
    // A kitchen tablet is picked up, looked at, and put down. Refetch the moment
    // someone actually looks at it, so the board is never stale in front of a human.
    refetchOnWindowFocus: true,
  });

  /**
   * Ring the bell for genuinely NEW orders.
   *
   * The first load primes the "seen" set without making a sound — otherwise opening
   * the board mid-service would blast a chime for every order already on the pass.
   */
  useEffect(() => {
    if (!orders) return;

    const incoming = orders.filter((o) => o.status === 'PENDING');

    if (!primed.current) {
      for (const o of incoming) seenIds.current.add(o.id);
      primed.current = true;
      return;
    }

    const fresh = incoming.filter((o) => !seenIds.current.has(o.id));
    for (const o of fresh) seenIds.current.add(o.id);

    if (fresh.length > 0 && soundOn) {
      chime();
      // A toast as well as a sound: the extractor fan is louder than a tablet.
      toast.info(`${fresh.length} new order${fresh.length === 1 ? '' : 's'}`);
    }
  }, [orders, soundOn]);

  const advance = useMutation({
    mutationFn: ({ id, to }: { id: string; to: string }) => api.setOrderStatus(id, to),
    // Move the card immediately. A chef who taps Accept and watches a spinner for
    // 400ms taps it again, and the second tap is a transition that no longer applies.
    onMutate: async ({ id, to }) => {
      await queryClient.cancelQueries({ queryKey: ['orders', 'active'] });
      const previous = queryClient.getQueryData<Order[]>(['orders', 'active', restaurant?.id]);

      queryClient.setQueryData<Order[]>(['orders', 'active', restaurant?.id], (old) =>
        (old ?? []).map((o) => (o.id === id ? { ...o, status: to } : o)),
      );

      return { previous };
    },
    onError: (err, _vars, context) => {
      // Put it back exactly where it was, and say why.
      if (context?.previous) {
        queryClient.setQueryData(['orders', 'active', restaurant?.id], context.previous);
      }
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not update the order');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['orders', 'active'] }),
  });

  const setEta = useMutation({
    mutationFn: ({ id, minutesFromNow }: { id: string; minutesFromNow: number }) =>
      api.setOrderEta(id, minutesFromNow),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['orders', 'active'] }),
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not update the ETA'),
  });

  const byColumn = useMemo(() => {
    const map = new Map<string, Order[]>();
    for (const col of COLUMNS) {
      map.set(
        col.key,
        (orders ?? [])
          .filter((o) => col.statuses.includes(o.status))
          // Oldest first. The order that has been waiting longest is the one that
          // matters, always — a board sorted newest-first buries the problem.
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      );
    }
    return map;
  }, [orders]);

  if (!restaurant) return null;

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <ChefHat className="h-6 w-6" />
            Kitchen
          </h1>
          <p className="text-sm text-muted-foreground">
            {isLoading ? 'Loading…' : `${orders?.length ?? 0} orders on the pass`}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setSoundOn((s) => !s);
              // Play it when switching ON, so they know it works before service.
              if (!soundOn) chime();
            }}
            title={soundOn ? 'Sound is on' : 'Sound is OFF — new orders will be silent'}
          >
            {soundOn ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4 text-destructive" />}
            {soundOn ? 'Sound on' : 'Sound off'}
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => void document.documentElement.requestFullscreen?.()}
          >
            <Maximize2 className="h-4 w-4" />
            Full screen
          </Button>
        </div>
      </div>

      {!soundOn && (
        <p className="mb-3 rounded-lg bg-destructive/10 p-2.5 text-center text-sm font-medium text-destructive">
          Sound is off. New orders will arrive silently.
        </p>
      )}

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-3">
        {COLUMNS.map((col) => {
          const cards = byColumn.get(col.key) ?? [];

          return (
            <div key={col.key} className="flex min-h-0 flex-col rounded-2xl border bg-muted/30 p-3">
              <div className="mb-3 flex items-center justify-between px-1">
                <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
                  {col.title}
                </h2>
                <span className="shadow-soft rounded-full bg-background px-2.5 py-0.5 text-sm font-bold tabular-nums">
                  {cards.length}
                </span>
              </div>

              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
                {cards.map((order) => (
                  <OrderCard
                    key={order.id}
                    order={order}
                    tone={col.tone}
                    action={actionFor(order.status, order.fulfillment)}
                    onAdvance={(to) => advance.mutate({ id: order.id, to })}
                    onSetEta={(minutesFromNow) => setEta.mutate({ id: order.id, minutesFromNow })}
                  />
                ))}

                {cards.length === 0 && (
                  <p className="py-10 text-center text-sm text-muted-foreground">Nothing here</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const ETA_PRESETS = [10, 15, 20, 30, 45];

function OrderCard({
  order,
  tone,
  action,
  onAdvance,
  onSetEta,
}: {
  order: Order;
  tone: string;
  action?: { label: string; to: string };
  onAdvance: (to: string) => void;
  onSetEta: (minutesFromNow: number) => void;
}) {
  const f = FULFILLMENT[order.fulfillment as keyof typeof FULFILLMENT] ?? FULFILLMENT.PICKUP;
  const Icon = f.icon;

  const waited = useElapsed(order.createdAt);

  // Only ACCEPTED/PREPARING orders have anything left to count down to --
  // PENDING hasn't been accepted yet, READY has already arrived.
  const canSetEta = order.status === 'ACCEPTED' || order.status === 'PREPARING';
  const etaMinutes = order.estimatedReadyAt
    ? Math.ceil((new Date(order.estimatedReadyAt).getTime() - Date.now()) / 60_000)
    : null;

  /**
   * How long has this been sitting there?
   *
   * Turns red past 20 minutes. Not decoration: a kitchen under pressure loses an
   * order the same way every time — it slides down the screen and nobody notices it
   * is old. The colour is what makes "old" visible from across the room.
   */
  const late = waited.minutes >= 20;

  return (
    <div className={`shadow-soft rounded-xl border-l-4 bg-background p-4 ${tone}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* The biggest thing on the card. It is what goes on the bag -- the last
              3 digits of the order number, the same thing texted to the customer
              and shown on the public status board. */}
          <p className="font-mono text-3xl font-black leading-none tracking-tight">
            {order.orderNumber.slice(-3)}
          </p>
          {/* The full order number too, small -- so this card can be cross-referenced
              against Order history or a receipt. */}
          <p className="mt-0.5 text-xs font-medium text-muted-foreground">
            #{order.orderNumber}
          </p>
          <p className="mt-1 truncate text-sm font-medium">{order.customerName}</p>
        </div>

        <div className="shrink-0 text-right">
          <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs font-semibold">
            <Icon className="h-3.5 w-3.5" />
            {order.fulfillment === 'DINE_IN' && order.tableNumber
              ? `Table ${order.tableNumber}`
              : f.label}
          </span>
          <p
            className={`mt-1.5 flex items-center justify-end gap-1 text-xs font-bold tabular-nums ${
              late ? 'text-destructive' : 'text-muted-foreground'
            }`}
          >
            <Clock className="h-3 w-3" />
            {waited.label}
          </p>
        </div>
      </div>

      <ul className="mt-3 space-y-1 border-t pt-3">
        {order.items.map((item) => (
          <li key={item.id} className="flex gap-2 text-sm">
            <span className="font-bold tabular-nums">{item.quantity}×</span>
            <span className="min-w-0">
              <span className="font-medium">{item.name}</span>
              {item.modifiers?.length > 0 && (
                <span className="block text-xs text-muted-foreground">
                  {item.modifiers.map((m) => m.name).join(', ')}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>

      {/*
        The countdown customers see on the public status board -- defaulted
        from prep time and item count, editable here in one tap when the
        default is wrong or the kitchen's running behind. Absolute presets,
        not "+5 min": easier to tap "20m" under pressure than do the mental
        math on a delta.
      */}
      {canSetEta && (
        <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3">
          <span className="text-xs font-semibold text-muted-foreground">
            {etaMinutes === null
              ? 'No ETA set'
              : etaMinutes <= 0
                ? 'Any moment now'
                : `Ready in ${etaMinutes} min`}
          </span>
          <div className="flex gap-1">
            {ETA_PRESETS.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onSetEta(m)}
                className="rounded-md border px-2 py-1 text-xs font-bold hover:bg-muted"
              >
                {m}m
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Allergies live here. A note the kitchen misses is the one that hurts someone. */}
      {order.notes && (
        <p className="mt-3 rounded-lg bg-amber-50 p-2.5 text-sm font-medium text-amber-900">
          {order.notes}
        </p>
      )}

      {action && (
        <Button
          className="mt-3 h-14 w-full text-base font-bold"
          onClick={() => onAdvance(action.to)}
        >
          <Check className="h-5 w-5" />
          {action.label}
        </Button>
      )}
    </div>
  );
}

/** Minutes since the order landed, ticking. */
function useElapsed(iso: string) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const minutes = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  return { minutes, label: minutes < 1 ? 'just now' : `${minutes}m` };
}

/**
 * The bell.
 *
 * Synthesised rather than an audio file: no asset to 404, no CDN to be blocked, and
 * it works offline — which a kitchen tablet regularly is. Two quick tones, because
 * one is easy to mistake for a notification from something else.
 */
function chime() {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();

    [880, 1320].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.frequency.value = freq;
      osc.type = 'sine';
      osc.connect(gain);
      gain.connect(ctx.destination);

      const start = ctx.currentTime + i * 0.18;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.35, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);

      osc.start(start);
      osc.stop(start + 0.18);
    });
  } catch {
    // Browsers block audio until the user has interacted with the page. Failing here
    // must never take the board down — the toast still fires, and the visual card
    // still appears. Silence is a degraded kitchen, not a broken one.
  }
}
