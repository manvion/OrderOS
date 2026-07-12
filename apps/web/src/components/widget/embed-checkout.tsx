'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2, ShoppingBag, Truck, UtensilsCrossed } from 'lucide-react';
import { formatMoney } from '@orderos/shared';
import { toast } from 'sonner';
import { ApiRequestError, type DeliveryQuote, type StorefrontRestaurant } from '@/lib/api';
import type { WidgetApi } from '@/lib/widget-api';
import { useCart, useCartTotals } from '@/lib/cart-store';

const TIP_PRESETS = [0, 10, 15, 20] as const;

/**
 * Checkout inside the widget.
 *
 * Same contract as the storefront's: the browser sends product/modifier IDS and
 * never a price. The server re-reads every price and re-runs the shared pricing
 * engine, so a tampered widget on someone's own website cannot buy a discounted
 * burger — which matters more here than anywhere, because this code is running
 * on a machine we do not control, embedded in a page we do not control.
 */
export function EmbedCheckout({
  api,
  restaurant,
  sessionId,
  onCreated,
}: {
  api: WidgetApi;
  restaurant: StorefrontRestaurant;
  sessionId: string;
  onCreated: (result: { trackingToken: string; checkoutUrl: string }) => void;
}) {
  const lines = useCart((s) => s.lines);
  const fulfillment = useCart((s) => s.fulfillment);
  const setFulfillment = useCart((s) => s.setFulfillment);
  const tipCents = useCart((s) => s.tipCents);
  const setTip = useCart((s) => s.setTip);
  const subtotalCents = useCart((s) => s.subtotalCents());

  const [customer, setCustomer] = useState({ name: '', phone: '', email: '' });
  const [address, setAddress] = useState({
    street: '',
    city: '',
    state: '',
    postalCode: '',
    country: 'US',
  });
  const [quote, setQuote] = useState<DeliveryQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const deliveryFeeOverride =
    quote?.deliverable && fulfillment === 'DELIVERY' ? quote.customerFeeCents : undefined;
  const totals = useCartTotals(restaurant, deliveryFeeOverride);

  const options = useMemo(
    () =>
      [
        restaurant.pickupEnabled && { value: 'PICKUP' as const, label: 'Pickup', icon: ShoppingBag },
        restaurant.deliveryEnabled && { value: 'DELIVERY' as const, label: 'Delivery', icon: Truck },
        restaurant.dineInEnabled && {
          value: 'DINE_IN' as const,
          label: 'Dine in',
          icon: UtensilsCrossed,
        },
      ].filter(Boolean) as Array<{
        value: 'PICKUP' | 'DELIVERY' | 'DINE_IN';
        label: string;
        icon: typeof ShoppingBag;
      }>,
    [restaurant],
  );

  /**
   * Same snap as the storefront: the cart defaults to PICKUP, but a restaurant may
   * offer only delivery, or only dine-in. Selecting something they don't do means
   * the order is rejected by the API after the customer has filled in the form.
   */
  useEffect(() => {
    if (options.length === 0) return;
    if (!options.some((o) => o.value === fulfillment)) {
      setFulfillment(options[0].value);
    }
  }, [options, fulfillment, setFulfillment]);

  const addressComplete =
    address.street.length > 2 &&
    address.city.length > 1 &&
    address.state.length > 1 &&
    address.postalCode.length > 2;

  // Debounced delivery quote — each call reaches Uber, so not one per keystroke.
  useEffect(() => {
    if (fulfillment !== 'DELIVERY' || !addressComplete) {
      setQuote(null);
      return;
    }

    let cancelled = false;
    setQuoting(true);

    const timer = setTimeout(async () => {
      try {
        const result = await api.getDeliveryQuote({ address, orderValueCents: subtotalCents });
        if (!cancelled) setQuote(result);
      } catch {
        if (!cancelled) {
          setQuote({ deliverable: false, reason: 'We could not check delivery for that address' });
        }
      } finally {
        if (!cancelled) setQuoting(false);
      }
    }, 600);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [fulfillment, addressComplete, address, api, subtotalCents]);

  const canSubmit =
    lines.length > 0 &&
    customer.name.trim().length > 0 &&
    customer.phone.trim().length >= 7 &&
    customer.email.includes('@') &&
    (fulfillment !== 'DELIVERY' || (addressComplete && quote?.deliverable === true)) &&
    !submitting;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFieldErrors({});
    setSubmitting(true);

    try {
      const result = await api.createOrder({
        items: lines.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          notes: l.notes,
          modifierIds: l.modifiers.map((m) => m.modifierId),
        })),
        fulfillment,
        customer,
        ...(fulfillment === 'DELIVERY' ? { deliveryAddress: address } : {}),
        tipCents,
        sessionId,
      });

      onCreated({ trackingToken: result.trackingToken, checkoutUrl: result.checkoutUrl });
    } catch (err) {
      setSubmitting(false);
      if (err instanceof ApiRequestError) {
        if (err.body.fieldErrors) setFieldErrors(err.body.fieldErrors);
        toast.error(err.body.message);
        return;
      }
      toast.error('Something went wrong. Please try again.');
    }
  };

  return (
    <form onSubmit={submit} className="space-y-5 p-4">
      <section>
        <h2 className="mb-2 text-sm font-semibold">How would you like it?</h2>
        <div className="grid grid-cols-3 gap-2">
          {options.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => setFulfillment(value)}
              className={`flex flex-col items-center gap-1.5 rounded-xl border p-3 text-xs font-medium transition-colors ${
                fulfillment === value ? 'border-brand bg-brand/5' : 'hover:bg-accent/50'
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Your details</h2>

        <Field label="Name" error={fieldErrors['customer.name']}>
          <input
            value={customer.name}
            onChange={(e) => setCustomer({ ...customer, name: e.target.value })}
            required
            autoComplete="name"
            className="w-full rounded-lg border px-3 py-2 text-sm"
          />
        </Field>

        <Field label="Mobile number" error={fieldErrors['customer.phone']} hint="For order updates">
          <input
            type="tel"
            value={customer.phone}
            onChange={(e) => setCustomer({ ...customer, phone: e.target.value })}
            required
            autoComplete="tel"
            className="w-full rounded-lg border px-3 py-2 text-sm"
          />
        </Field>

        <Field label="Email" error={fieldErrors['customer.email']}>
          <input
            type="email"
            value={customer.email}
            onChange={(e) => setCustomer({ ...customer, email: e.target.value })}
            required
            autoComplete="email"
            className="w-full rounded-lg border px-3 py-2 text-sm"
          />
        </Field>
      </section>

      {fulfillment === 'DELIVERY' && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">Delivery address</h2>

          <input
            value={address.street}
            onChange={(e) => setAddress({ ...address, street: e.target.value })}
            placeholder="Street address"
            required
            autoComplete="street-address"
            className="w-full rounded-lg border px-3 py-2 text-sm"
          />

          <div className="grid grid-cols-3 gap-2">
            <input
              value={address.city}
              onChange={(e) => setAddress({ ...address, city: e.target.value })}
              placeholder="City"
              required
              className="rounded-lg border px-3 py-2 text-sm"
            />
            <input
              value={address.state}
              onChange={(e) => setAddress({ ...address, state: e.target.value })}
              placeholder="State"
              required
              className="rounded-lg border px-3 py-2 text-sm"
            />
            <input
              value={address.postalCode}
              onChange={(e) => setAddress({ ...address, postalCode: e.target.value })}
              placeholder="ZIP"
              required
              className="rounded-lg border px-3 py-2 text-sm"
            />
          </div>

          {quoting && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Checking delivery…
            </p>
          )}

          {quote && !quoting && (
            <p
              className={`rounded-lg p-2.5 text-xs ${
                quote.deliverable
                  ? 'bg-emerald-50 text-emerald-900'
                  : 'bg-destructive/10 text-destructive'
              }`}
            >
              {quote.deliverable
                ? `We can deliver here for ${formatMoney(quote.customerFeeCents, restaurant.currency)}`
                : quote.reason}
            </p>
          )}
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold">Add a tip</h2>
        <div className="grid grid-cols-4 gap-2">
          {TIP_PRESETS.map((percent) => {
            const cents = Math.round((subtotalCents * percent) / 100);
            const active = tipCents === cents;
            return (
              <button
                key={percent}
                type="button"
                onClick={() => setTip(cents)}
                className={`rounded-lg border py-2 text-xs font-medium transition-colors ${
                  active ? 'border-brand bg-brand/5' : 'hover:bg-accent/50'
                }`}
              >
                {percent === 0 ? 'None' : `${percent}%`}
              </button>
            );
          })}
        </div>
      </section>

      {totals && (
        <section className="space-y-1.5 border-t pt-4 text-sm">
          <Row label="Subtotal" cents={totals.subtotalCents} currency={restaurant.currency} />
          {totals.serviceFeeCents > 0 && (
            <Row label="Service fee" cents={totals.serviceFeeCents} currency={restaurant.currency} />
          )}
          {totals.deliveryFeeCents > 0 && (
            <Row label="Delivery" cents={totals.deliveryFeeCents} currency={restaurant.currency} />
          )}
          <Row label="Tax" cents={totals.taxCents} currency={restaurant.currency} />
          {totals.tipCents > 0 && (
            <Row label="Tip" cents={totals.tipCents} currency={restaurant.currency} />
          )}
          <div className="flex justify-between pt-1.5 font-semibold">
            <span>Total</span>
            <span className="tabular-nums">
              {formatMoney(totals.totalCents, restaurant.currency)}
            </span>
          </div>
        </section>
      )}

      <button
        type="submit"
        disabled={!canSubmit}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand py-3 font-semibold text-brand-foreground disabled:opacity-50"
      >
        {submitting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Opening payment…
          </>
        ) : (
          <>Pay {formatMoney(totals?.totalCents ?? 0, restaurant.currency)}</>
        )}
      </button>

      <p className="text-center text-xs text-muted-foreground">
        Payment opens in a new tab, secured by Stripe. You&apos;ll come straight back here to track
        your order.
      </p>
    </form>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium">{label}</label>
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
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
