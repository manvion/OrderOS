'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { Check, ChefHat, CircleDot, ExternalLink, Package, Phone, Truck } from 'lucide-react';
import { formatMoney } from '@dinedirect/shared';
import { storefrontApi, type TrackedOrder } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/primitives';
import { useTenantHref } from './tenant-provider';

// Leaflet touches `window` on import, so the map can never be server-rendered.
// The tracking page itself still SSRs — only this island is deferred.
const CourierMap = dynamic(
  () => import('@/components/shared/courier-map').then((m) => m.CourierMap),
  {
    ssr: false,
    loading: () => <div className="shimmer h-full min-h-[260px] w-full rounded-2xl" />,
  },
);

const PICKUP_STEPS = [
  { status: 'PENDING', label: 'Order placed', icon: Check },
  { status: 'ACCEPTED', label: 'Confirmed by the kitchen', icon: Check },
  { status: 'PREPARING', label: 'Being prepared', icon: ChefHat },
  { status: 'READY', label: 'Ready for pickup', icon: Package },
  { status: 'COMPLETED', label: 'Collected', icon: Check },
] as const;

const DELIVERY_STEPS = [
  { status: 'PENDING', label: 'Order placed', icon: Check },
  { status: 'ACCEPTED', label: 'Confirmed by the kitchen', icon: Check },
  { status: 'PREPARING', label: 'Being prepared', icon: ChefHat },
  { status: 'READY', label: 'Finding a driver', icon: Package },
  { status: 'DRIVER_ASSIGNED', label: 'Driver collecting your order', icon: Truck },
  { status: 'OUT_FOR_DELIVERY', label: 'On its way to you', icon: Truck },
  { status: 'DELIVERED', label: 'Delivered', icon: Check },
] as const;

const TERMINAL = ['COMPLETED', 'DELIVERED', 'CANCELLED'];

export function OrderTracker({
  slug,
  token,
  initialOrder,
}: {
  slug: string;
  token: string;
  initialOrder: TrackedOrder;
}) {
  const [order, setOrder] = useState(initialOrder);
  const href = useTenantHref();

  /**
   * Poll while the order is live.
   *
   * Faster (4s) once a driver is actually moving, because that's when the map is
   * the thing the customer is staring at and a stale pin is the whole failure.
   * Still fast (6s) while the food is in the kitchen -- this used to be 20s on the
   * theory that "nothing visible changes minute to minute", but every status
   * change (accepted, preparing, ready) is exactly the moment the customer IS
   * watching, right after paying, and a 20s lag there reads as broken, not calm.
   * Stops entirely once the order is terminal.
   */
  useEffect(() => {
    if (TERMINAL.includes(order.status)) return;

    const isMoving = order.status === 'DRIVER_ASSIGNED' || order.status === 'OUT_FOR_DELIVERY';
    const intervalMs = isMoving ? 4_000 : 6_000;

    const interval = setInterval(async () => {
      try {
        setOrder(await storefrontApi.track(slug, token));
      } catch {
        // Transient. The next tick retries.
      }
    }, intervalMs);

    return () => clearInterval(interval);
  }, [slug, token, order.status]);

  const steps = order.fulfillment === 'DELIVERY' ? DELIVERY_STEPS : PICKUP_STEPS;
  const currentIndex = steps.findIndex((s) => s.status === order.status);
  const isCancelled = order.status === 'CANCELLED';
  const isDone = order.status === 'DELIVERED' || order.status === 'COMPLETED';
  const isUnpaid = order.payment?.status === 'PENDING';

  const delivery = order.delivery;
  const showMap =
    order.fulfillment === 'DELIVERY' &&
    !isCancelled &&
    Boolean(delivery?.courierLatitude ?? order.restaurant.latitude);

  const etaMinutes = delivery?.dropoffEta
    ? Math.max(1, Math.round((new Date(delivery.dropoffEta).getTime() - Date.now()) / 60_000))
    : null;

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 pb-20 sm:px-6">
      {/* Headline. The single most important sentence on the page, so it gets to
          be big and to say something human. */}
      <header className="mb-6">
        <p className="text-sm font-medium text-muted-foreground">Order #{order.orderNumber}</p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight sm:text-4xl">
          {isCancelled
            ? 'This order was cancelled'
            : isUnpaid
              ? 'Waiting for payment'
              : isDone
                ? 'Enjoy your food'
                : etaMinutes && order.status === 'OUT_FOR_DELIVERY'
                  ? `Arriving in about ${etaMinutes} min`
                  : `${order.restaurant.name} is on it`}
        </h1>
      </header>

      {/*
        THE CODE. Given to the kitchen and to the customer, so both are looking at
        the same digits -- the last 3 of the order number, the same number that's
        headlined this page and every text this customer has already gotten.

        Pickup: they read it out at the counter, and "order for John" stops being a
        problem when there are two Johns. Dine-in: it's on the ticket with the table
        number. Delivery: the courier reads it off their app and staff match it to
        the bag — the failure this prevents is the expensive one, where the food is
        gone, two customers are furious, and neither order can be remade for free.

        Hidden once the food is delivered or collected: at that point it is clutter.
      */}
      {!isCancelled && !isUnpaid && !isDone && (
        <div className="mb-6 flex items-center justify-between gap-4 rounded-2xl border-2 border-dashed p-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              {order.fulfillment === 'PICKUP'
                ? 'Give this code at the counter'
                : order.fulfillment === 'DINE_IN'
                  ? 'Your order code'
                  : 'Your driver will confirm this code'}
            </p>
            <p className="mt-1.5 font-mono text-4xl font-black tracking-widest">
              {order.orderNumber.slice(-3)}
            </p>
          </div>

          {order.fulfillment === 'DINE_IN' && order.tableNumber && (
            <div className="shrink-0 text-right">
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Table
              </p>
              <p className="mt-1.5 text-4xl font-black">{order.tableNumber}</p>
            </div>
          )}
        </div>
      )}

      {isUnpaid && (
        <Card className="mb-6 border-amber-300 bg-amber-50">
          <CardContent className="p-4 text-sm text-amber-900">
            We haven&apos;t received your payment yet. If you closed the payment page before
            finishing, this order will be cancelled automatically.
          </CardContent>
        </Card>
      )}

      {/* THE MAP. Above everything else — when a driver is en route, this is the
          only thing the customer actually wants. */}
      {showMap && (
        <Card className="mb-6 overflow-hidden">
          <div className="h-72 sm:h-80">
            <CourierMap
              className="h-full"
              brandColor={order.restaurant.brandPrimaryColor}
              restaurant={
                order.restaurant.latitude && order.restaurant.longitude
                  ? { latitude: order.restaurant.latitude, longitude: order.restaurant.longitude }
                  : null
              }
              dropoff={
                order.deliveryLatitude && order.deliveryLongitude
                  ? { latitude: order.deliveryLatitude, longitude: order.deliveryLongitude }
                  : null
              }
              courier={
                delivery?.courierLatitude && delivery?.courierLongitude
                  ? { latitude: delivery.courierLatitude, longitude: delivery.courierLongitude }
                  : null
              }
              trail={delivery?.pings ?? []}
            />
          </div>

          {delivery?.courierName && (
            <CardContent className="flex flex-wrap items-center justify-between gap-3 border-t p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-brand/10 text-lg">
                  🚗
                </div>
                <div>
                  <p className="font-semibold leading-tight">{delivery.courierName}</p>
                  <p className="text-xs text-muted-foreground">
                    {delivery.courierVehicle ?? 'On the way'}
                    {etaMinutes ? ` · about ${etaMinutes} min away` : ''}
                  </p>
                </div>
              </div>

              {delivery.trackingUrl && (
                <Button asChild variant="outline" size="sm">
                  <a href={delivery.trackingUrl} target="_blank" rel="noopener noreferrer">
                    Uber&apos;s map
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </Button>
              )}
            </CardContent>
          )}
        </Card>
      )}

      {/* The thank-you state. The order is done; say so warmly and get out of the way. */}
      {isDone && (
        <Card className="mb-6 border-emerald-200 bg-emerald-50">
          <CardContent className="p-6 text-center">
            <p className="text-2xl">🎉</p>
            <p className="mt-2 font-semibold text-emerald-900">
              Thanks for ordering directly with {order.restaurant.name}
            </p>
            <p className="mt-1 text-sm text-emerald-800">
              No marketplace took a cut — more of what you paid stayed with the people who cooked
              your food.
            </p>
            <Button asChild variant="brand" className="mt-4">
              <a href={href('/menu')}>Order again</a>
            </Button>
          </CardContent>
        </Card>
      )}

      {!isCancelled && !isDone && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-base">Progress</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="relative">
              {steps.map((step, index) => {
                const done = currentIndex >= 0 && index < currentIndex;
                const active = index === currentIndex;
                const Icon = step.icon;
                const isLast = index === steps.length - 1;

                return (
                  <li key={step.status} className="relative flex gap-4 pb-5 last:pb-0">
                    {/* The connecting rail. Filled behind completed steps, so the
                        timeline reads as a progress bar rather than a list. */}
                    {!isLast && (
                      <span
                        className={`absolute left-[15px] top-8 h-full w-0.5 ${
                          done ? 'bg-emerald-500' : 'bg-border'
                        }`}
                        aria-hidden
                      />
                    )}

                    <span
                      className={`relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors ${
                        done
                          ? 'bg-emerald-500 text-white'
                          : active
                            ? 'bg-brand text-brand-foreground ring-4 ring-brand/20'
                            : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {active ? (
                        <CircleDot className="h-4 w-4 animate-pulse" />
                      ) : (
                        <Icon className="h-4 w-4" />
                      )}
                    </span>

                    <span
                      className={`pt-1 text-sm ${
                        active ? 'font-semibold' : done ? '' : 'text-muted-foreground'
                      }`}
                    >
                      {step.label}
                    </span>
                  </li>
                );
              })}
            </ol>
          </CardContent>
        </Card>
      )}

      <Card className="mb-6">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Your order</CardTitle>
          <Badge variant={isCancelled ? 'destructive' : 'secondary'}>
            {order.fulfillment.replace('_', ' ').toLowerCase()}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="space-y-3">
            {order.items.map((item, i) => (
              <li key={i} className="flex justify-between gap-4 text-sm">
                <div>
                  <span className="font-medium">
                    {item.quantity} × {item.name}
                  </span>
                  {item.modifiers.length > 0 && (
                    <p className="text-muted-foreground">
                      {item.modifiers.map((m) => m.name).join(', ')}
                    </p>
                  )}
                </div>
                <span className="shrink-0 tabular-nums">
                  {formatMoney(item.totalCents, order.currency)}
                </span>
              </li>
            ))}
          </ul>

          <div className="space-y-1.5 border-t pt-4 text-sm">
            <Row label="Subtotal" cents={order.subtotalCents} currency={order.currency} />
            {order.serviceFeeCents > 0 && (
              <Row label="Service fee" cents={order.serviceFeeCents} currency={order.currency} />
            )}
            {order.deliveryFeeCents > 0 && (
              <Row label="Delivery" cents={order.deliveryFeeCents} currency={order.currency} />
            )}
            <Row label="Tax" cents={order.taxCents} currency={order.currency} />
            {order.tipCents > 0 && (
              <Row label="Tip" cents={order.tipCents} currency={order.currency} />
            )}
            <div className="flex justify-between pt-2 text-base font-semibold">
              <span>Total</span>
              <span className="tabular-nums">{formatMoney(order.totalCents, order.currency)}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-4 p-6">
          <div className="text-sm">
            <p className="font-medium">{order.restaurant.name}</p>
            <p className="text-muted-foreground">
              {order.restaurant.street}, {order.restaurant.city}
            </p>
          </div>
          <Button asChild variant="outline" size="sm">
            <a href={`tel:${order.restaurant.phone}`}>
              <Phone className="h-3.5 w-3.5" />
              Call the restaurant
            </a>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, cents, currency }: { label: string; cents: number; currency: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{formatMoney(cents, currency)}</span>
    </div>
  );
}
