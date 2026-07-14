'use client';

import dynamic from 'next/dynamic';
import { Check, ChefHat, CircleDot, ExternalLink, Package, Phone, Truck } from 'lucide-react';
import { formatMoney } from '@dinedirect/shared';
import type { TrackedOrder } from '@/lib/api';

/**
 * The same courier map the hosted storefront uses.
 *
 * It renders INSIDE the widget's iframe, which means a customer who ordered from
 * the restaurant's own WordPress site watches their driver move across a map
 * without ever leaving that site. That is the entire promise of the widget, and
 * a tracking view that just said "out for delivery" in text would quietly break it.
 *
 * ssr:false because Leaflet touches `window` on import.
 */
const CourierMap = dynamic(
  () => import('@/components/shared/courier-map').then((m) => m.CourierMap),
  {
    ssr: false,
    loading: () => <div className="shimmer h-full min-h-[200px] w-full rounded-xl" />,
  },
);

const PICKUP_STEPS = [
  { status: 'PENDING', label: 'Order placed', icon: Check },
  { status: 'ACCEPTED', label: 'Confirmed', icon: Check },
  { status: 'PREPARING', label: 'Being prepared', icon: ChefHat },
  { status: 'READY', label: 'Ready for pickup', icon: Package },
  { status: 'COMPLETED', label: 'Collected', icon: Check },
] as const;

const DELIVERY_STEPS = [
  { status: 'PENDING', label: 'Order placed', icon: Check },
  { status: 'ACCEPTED', label: 'Confirmed', icon: Check },
  { status: 'PREPARING', label: 'Being prepared', icon: ChefHat },
  { status: 'READY', label: 'Finding a driver', icon: Package },
  { status: 'DRIVER_ASSIGNED', label: 'Driver collecting', icon: Truck },
  { status: 'OUT_FOR_DELIVERY', label: 'On its way to you', icon: Truck },
  { status: 'DELIVERED', label: 'Delivered', icon: Check },
] as const;

export function EmbedTracking({ order }: { order: TrackedOrder }) {
  const steps = order.fulfillment === 'DELIVERY' ? DELIVERY_STEPS : PICKUP_STEPS;
  const currentIndex = steps.findIndex((s) => s.status === order.status);
  const isCancelled = order.status === 'CANCELLED';
  const isDone = order.status === 'DELIVERED' || order.status === 'COMPLETED';

  const delivery = order.delivery;
  const etaMinutes = delivery?.dropoffEta
    ? Math.max(1, Math.round((new Date(delivery.dropoffEta).getTime() - Date.now()) / 60_000))
    : null;

  const showMap =
    order.fulfillment === 'DELIVERY' &&
    !isCancelled &&
    Boolean(delivery?.courierLatitude ?? order.restaurant.latitude);

  return (
    <div className="animate-rise space-y-4 p-4">
      {/* Headline — the same sentence the customer would see on the hosted page. */}
      <div
        className={`rounded-2xl p-5 text-center ${
          isCancelled ? 'bg-destructive/10' : isDone ? 'bg-emerald-50' : 'bg-brand-subtle'
        }`}
      >
        {isDone && <p className="text-3xl">🎉</p>}
        <p
          className={`mt-1 text-lg font-bold tracking-tight ${
            isCancelled ? 'text-destructive' : isDone ? 'text-emerald-900' : ''
          }`}
        >
          {isCancelled
            ? 'Order cancelled'
            : isDone
              ? 'Enjoy your food!'
              : etaMinutes && order.status === 'OUT_FOR_DELIVERY'
                ? `Arriving in about ${etaMinutes} min`
                : 'Payment received'}
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">Order #{order.orderNumber}</p>
      </div>

      {/* THE MAP — the reason this component exists. */}
      {showMap && (
        <div className="overflow-hidden rounded-2xl border shadow-soft">
          <div className="h-56">
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
            <div className="flex items-center justify-between gap-3 border-t bg-card p-3">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-subtle text-base">
                  🚗
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold leading-tight">
                    {delivery.courierName}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {delivery.courierVehicle ?? 'On the way'}
                    {etaMinutes ? ` · ~${etaMinutes} min` : ''}
                  </p>
                </div>
              </div>

              {delivery.trackingUrl && (
                <a
                  href={delivery.trackingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex shrink-0 items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium hover:bg-accent"
                >
                  Uber
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          )}
        </div>
      )}

      {isDone && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-center">
          <p className="text-sm font-medium text-emerald-900">
            Thanks for ordering directly with {order.restaurant.name}
          </p>
          <p className="mt-1 text-xs text-emerald-800">
            No marketplace took a cut — more of what you paid stayed with the people who cooked
            your food.
          </p>
        </div>
      )}

      {!isCancelled && !isDone && (
        <ol className="relative rounded-2xl border p-4">
          {steps.map((step, index) => {
            const done = currentIndex >= 0 && index < currentIndex;
            const active = index === currentIndex;
            const Icon = step.icon;
            const isLast = index === steps.length - 1;

            return (
              <li key={step.status} className="relative flex gap-3 pb-4 last:pb-0">
                {!isLast && (
                  <span
                    className={`absolute left-[13px] top-7 h-full w-0.5 ${
                      done ? 'bg-emerald-500' : 'bg-border'
                    }`}
                    aria-hidden
                  />
                )}
                <span
                  className={`relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors ${
                    done
                      ? 'bg-emerald-500 text-white'
                      : active
                        ? 'bg-brand text-brand-foreground ring-4 ring-[color-mix(in_srgb,var(--brand)_20%,transparent)]'
                        : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {active ? (
                    <CircleDot className="h-3.5 w-3.5 animate-pulse" />
                  ) : (
                    <Icon className="h-3.5 w-3.5" />
                  )}
                </span>
                <span
                  className={`pt-0.5 text-sm ${
                    active ? 'font-semibold' : done ? '' : 'text-muted-foreground'
                  }`}
                >
                  {step.label}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      <div className="space-y-2 rounded-2xl border p-4">
        {order.items.map((item, i) => (
          <div key={i} className="flex justify-between gap-3 text-sm">
            <span>
              {item.quantity} × {item.name}
            </span>
            <span className="tabular-nums text-muted-foreground">
              {formatMoney(item.totalCents, order.currency)}
            </span>
          </div>
        ))}
        <div className="flex justify-between border-t pt-2 font-semibold">
          <span>Total</span>
          <span className="tabular-nums">{formatMoney(order.totalCents, order.currency)}</span>
        </div>
      </div>

      <a
        href={`tel:${order.restaurant.phone}`}
        className="flex items-center justify-center gap-2 rounded-xl border py-2.5 text-sm font-medium hover:bg-accent"
      >
        <Phone className="h-3.5 w-3.5" />
        Call {order.restaurant.name}
      </a>

      <p className="text-center text-xs text-muted-foreground">
        We&apos;ve texted you a link so you can track this order after closing this window.
      </p>
    </div>
  );
}
