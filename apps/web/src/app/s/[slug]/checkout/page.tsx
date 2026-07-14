'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Loader2, ShoppingBag, Truck, UtensilsCrossed } from 'lucide-react';
import { formatMoney } from '@dinedirect/shared';
import { toast } from 'sonner';
import { storefrontApi, ApiRequestError, type Address, type DeliveryQuote } from '@/lib/api';
import { useCart, useCartTotals } from '@/lib/cart-store';
import { AddressAutocomplete } from '@/components/storefront/address-autocomplete';
import { useTenant, useTenantHref } from '@/components/storefront/tenant-provider';
import { useCustomerAuth } from '@/components/storefront/customer-auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Checkbox, Label } from '@/components/ui/primitives';

const TIP_PRESETS = [0, 10, 15, 20] as const;

export default function CheckoutPage() {
  const restaurant = useTenant();
  const href = useTenantHref();
  const router = useRouter();

  const lines = useCart((s) => s.lines);
  const fulfillment = useCart((s) => s.fulfillment);
  const setFulfillment = useCart((s) => s.setFulfillment);
  const tipCents = useCart((s) => s.tipCents);
  const setTip = useCart((s) => s.setTip);
  const tableNumber = useCart((s) => s.tableNumber);
  const qrCodeId = useCart((s) => s.qrCodeId);
  const clear = useCart((s) => s.clear);

  // NOT Clerk's hook: the storefront must render with no auth provider at all.
  const { getToken, isSignedIn } = useCustomerAuth();

  const [customer, setCustomer] = useState({ name: '', phone: '', email: '' });
  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);
  const [saveAddress, setSaveAddress] = useState(false);

  /**
   * The account, if there is one.
   *
   * This is the ONLY thing being signed in changes about checkout: we can fill the
   * form in for them. Everything else — the pricing, the validation, the Stripe
   * session, the order — is identical for a guest. There is no gated path.
   */
  const { data: profile } = useQuery({
    queryKey: ['storefront-profile', restaurant.slug],
    queryFn: async () => {
      const token = await getToken();
      if (!token) return null;
      return storefrontApi.getProfile(restaurant.slug, token);
    },
    enabled: Boolean(isSignedIn),
    staleTime: 5 * 60_000,
  });
  // Default to the RESTAURANT's country, not 'US'. A Toronto restaurant's customers
  // are overwhelmingly in Canada, and a hardcoded 'US' meant every one of them was
  // geocoded, quoted and taxed against the wrong country until they noticed the field.
  const [address, setAddress] = useState<Address>({
    street: '',
    city: '',
    state: '',
    postalCode: '',
    country: restaurant.country ?? 'US',
  });
  const [notes, setNotes] = useState('');
  const [scheduledFor, setScheduledFor] = useState('');
  const [quote, setQuote] = useState<DeliveryQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const subtotalCents = useCart((s) => s.subtotalCents());

  // Once a real Uber quote lands, price the order with THAT fee rather than the
  // restaurant's default — otherwise the total shown here wouldn't match the one
  // the server computes and the customer would see it change at Stripe.
  const deliveryFeeOverride =
    quote?.deliverable && fulfillment === 'DELIVERY' ? quote.customerFeeCents : undefined;
  const totals = useCartTotals(restaurant, deliveryFeeOverride);

  const availableFulfillments = useMemo(
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
   * Snap the selection to something this restaurant actually offers.
   *
   * A restaurant can run ANY combination — delivery only, pickup only, dine-in
   * only, or a mix. But the cart defaults to PICKUP, so a DELIVERY-ONLY restaurant
   * would sit here with PICKUP silently selected, and the order would be rejected
   * by the API ("pickup is not available at this restaurant") only after the
   * customer had filled in the entire form. Select the first thing they DO offer.
   */
  useEffect(() => {
    if (availableFulfillments.length === 0) return;
    if (!availableFulfillments.some((o) => o.value === fulfillment)) {
      setFulfillment(availableFulfillments[0].value);
    }
  }, [availableFulfillments, fulfillment, setFulfillment]);

  const addressComplete =
    address.street.length > 2 &&
    address.city.length > 1 &&
    address.state.length > 1 &&
    address.postalCode.length > 2;

  /**
   * Ask for a delivery quote once the address is complete, debounced — every call
   * hits Uber's API, so firing one per keystroke would be both slow and rude.
   */
  useEffect(() => {
    if (fulfillment !== 'DELIVERY' || !addressComplete) {
      setQuote(null);
      return;
    }

    let cancelled = false;
    setQuoting(true);

    const timer = setTimeout(async () => {
      try {
        const result = await storefrontApi.getDeliveryQuote(restaurant.slug, {
          address,
          orderValueCents: subtotalCents,
        });
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
  }, [fulfillment, addressComplete, address, restaurant.slug, subtotalCents]);

  // An empty cart on checkout means they got here by URL or completed an order in
  // another tab. Nothing to buy — go back to the menu.
  useEffect(() => {
    if (lines.length === 0) router.replace(href('/menu'));
  }, [lines.length, router, href]);

  /**
   * Fill the form in for a returning customer.
   *
   * Only fills EMPTY fields — never overwrites something they've already typed.
   * A profile fetch that resolves late and clobbers the address someone is halfway
   * through correcting is infuriating, and it's the classic bug in this pattern.
   */
  useEffect(() => {
    if (!profile) return;

    setCustomer((current) => ({
      name: current.name || profile.customer.name,
      phone: current.phone || profile.customer.phone,
      email: current.email || profile.customer.email || '',
    }));

    const defaultAddress = profile.addresses.find((a) => a.isDefault) ?? profile.addresses[0];
    if (defaultAddress) {
      setSelectedAddressId((current) => current ?? defaultAddress.id);
      setAddress((current) =>
        current.street
          ? current
          : {
              street: defaultAddress.street,
              city: defaultAddress.city,
              state: defaultAddress.state,
              postalCode: defaultAddress.postalCode,
              country: defaultAddress.country,
            },
      );
    }
  }, [profile]);

  const applyTipPercent = (percent: number) => {
    setTip(Math.round(((totals?.subtotalCents ?? 0) * percent) / 100));
  };

  const canSubmit =
    lines.length > 0 &&
    customer.name.trim().length > 0 &&
    customer.phone.trim().length >= 7 &&
    customer.email.includes('@') &&
    (fulfillment !== 'DELIVERY' || (addressComplete && quote?.deliverable === true)) &&
    !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFieldErrors({});
    setSubmitting(true);

    try {
      // Signed in? Send the token, and the order attaches to their account. Guest?
      // Send nothing, and everything works exactly the same. That symmetry is the
      // point — there is no second-class checkout here.
      const token = isSignedIn ? await getToken() : null;

      const response = await storefrontApi.createOrderAs(
        restaurant.slug,
        {
          items: lines.map((l) => ({
            productId: l.productId,
            quantity: l.quantity,
            notes: l.notes,
            // Only ids go over the wire. The server looks every price up itself.
            modifierIds: l.modifiers.map((m) => m.modifierId),
          })),
          fulfillment,
          customer,
          ...(fulfillment === 'DELIVERY' ? { deliveryAddress: address } : {}),
          ...(scheduledFor ? { scheduledFor: new Date(scheduledFor).toISOString() } : {}),
          tipCents,
          notes: notes.trim() || undefined,
          ...(tableNumber ? { tableNumber } : {}),
          ...(qrCodeId ? { qrCodeId } : {}),
        },
        token ?? undefined,
      );

      // Save the address for next time, if they asked. Fire-and-forget: a failure
      // here must never block a paid order — they can save it again later.
      if (token && saveAddress && fulfillment === 'DELIVERY' && !selectedAddressId) {
        void storefrontApi.saveAddress(restaurant.slug, token, address).catch(() => {});
      }

      // Clear the cart before leaving: if the customer bounces back from Stripe
      // with the back button, a stale cart would let them place the order twice.
      clear();
      window.location.href = response.checkoutUrl;
    } catch (err) {
      setSubmitting(false);

      if (err instanceof ApiRequestError) {
        if (err.isValidationError && err.body.fieldErrors) {
          setFieldErrors(err.body.fieldErrors);
        }
        toast.error(err.body.message);
        return;
      }
      toast.error('Something went wrong. Please try again.');
    }
  };

  if (lines.length === 0) return null;

  return (
    <form onSubmit={handleSubmit} className="container max-w-2xl space-y-6 py-8">
      <h1 className="text-2xl font-bold tracking-tight">Checkout</h1>

      {/* Fulfillment */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {/* One option isn't a question. A radio group with a single choice is a
                decision the customer doesn't have, dressed up as one they do. */}
            {availableFulfillments.length === 1
              ? availableFulfillments[0].value === 'DELIVERY'
                ? 'Delivered to you'
                : availableFulfillments[0].value === 'PICKUP'
                  ? 'Collect from us'
                  : 'Dine in with us'
              : 'How would you like it?'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div
            className={`grid gap-2 ${
              availableFulfillments.length === 1 ? 'grid-cols-1' : 'sm:grid-cols-3'
            }`}
          >
            {availableFulfillments.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => setFulfillment(value)}
                className={`flex flex-col items-center gap-2 rounded-xl border p-4 transition-colors ${
                  fulfillment === value
                    ? 'border-brand bg-brand/5'
                    : 'hover:border-brand/40 hover:bg-accent/50'
                }`}
              >
                <Icon className="h-5 w-5" />
                <span className="text-sm font-medium">{label}</span>
              </button>
            ))}
          </div>

          {tableNumber && fulfillment === 'DINE_IN' && (
            <p className="mt-3 text-sm text-muted-foreground">
              Ordering for <strong>table {tableNumber}</strong>.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Contact */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={customer.name}
              onChange={(e) => setCustomer({ ...customer, name: e.target.value })}
              required
              autoComplete="name"
            />
            {fieldErrors['customer.name'] && (
              <p className="text-sm text-destructive">{fieldErrors['customer.name']}</p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="phone">Mobile number</Label>
              <Input
                id="phone"
                type="tel"
                value={customer.phone}
                onChange={(e) => setCustomer({ ...customer, phone: e.target.value })}
                required
                autoComplete="tel"
                placeholder="+1 415 555 0123"
              />
              <p className="text-xs text-muted-foreground">
                We&apos;ll text you when your order is ready.
              </p>
              {fieldErrors['customer.phone'] && (
                <p className="text-sm text-destructive">{fieldErrors['customer.phone']}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={customer.email}
                onChange={(e) => setCustomer({ ...customer, email: e.target.value })}
                required
                autoComplete="email"
              />
              {fieldErrors['customer.email'] && (
                <p className="text-sm text-destructive">{fieldErrors['customer.email']}</p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Delivery address */}
      {fulfillment === 'DELIVERY' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Where should we bring it?</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Saved addresses. The single reason a customer bothers to have an
                account: never type your address again. */}
            {profile && profile.addresses.length > 0 && (
              <div className="space-y-2">
                <Label>Saved addresses</Label>
                <div className="grid gap-2">
                  {profile.addresses.map((saved) => (
                    <button
                      key={saved.id}
                      type="button"
                      onClick={() => {
                        setSelectedAddressId(saved.id);
                        setAddress({
                          street: saved.street,
                          city: saved.city,
                          state: saved.state,
                          postalCode: saved.postalCode,
                          country: saved.country,
                        });
                      }}
                      className={`rounded-xl border p-3 text-left text-sm transition-colors ${
                        selectedAddressId === saved.id
                          ? 'border-brand-subtle bg-brand-subtle'
                          : 'hover:bg-accent/50'
                      }`}
                    >
                      <p className="font-medium">
                        {saved.label ?? saved.street}
                        {saved.isDefault && (
                          <span className="ml-2 text-xs text-muted-foreground">default</span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {saved.street}, {saved.city} {saved.postalCode}
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Picking a suggestion fills city/state/postcode AND gives us the
                provider's exact coordinates, so the delivery quote below is measured
                against a real point rather than a re-guess of the prose. Typing by
                hand still works everywhere — see AddressAutocomplete. */}
            <AddressAutocomplete
              slug={restaurant.slug}
              value={address}
              onChange={(next) => {
                // Typing or picking a new address means they aren't using the saved one.
                setSelectedAddressId(null);
                setAddress(next);
              }}
            />

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="city">City</Label>
                <Input
                  id="city"
                  value={address.city}
                  onChange={(e) => setAddress({ ...address, city: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="state">State</Label>
                <Input
                  id="state"
                  value={address.state}
                  onChange={(e) => setAddress({ ...address, state: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="postalCode">ZIP</Label>
                <Input
                  id="postalCode"
                  value={address.postalCode}
                  onChange={(e) => setAddress({ ...address, postalCode: e.target.value })}
                  required
                />
              </div>
            </div>

            {quoting && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Checking delivery…
              </p>
            )}

            {/* Offered only to signed-in customers typing a NEW address. Offering
                a guest the chance to "save" something they have nowhere to save it
                to would be a lie. */}
            {isSignedIn && !selectedAddressId && addressComplete && (
              <label className="flex cursor-pointer items-center gap-2.5 rounded-xl border p-3 text-sm">
                <Checkbox
                  checked={saveAddress}
                  onChange={(e) => setSaveAddress(e.target.checked)}
                />
                Save this address for next time
              </label>
            )}

            {/*
              OUT OF RANGE. Its own treatment, because it is not a failure — it is a
              definite answer, and the customer has a clear next move (switch to
              pickup) that we should hand them rather than make them find.
            */}
            {quote && !quote.deliverable && quote.outOfRange && !quoting && (
              <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
                <p className="text-sm font-semibold text-amber-900">Too far to deliver</p>
                <p className="mt-1 text-sm text-amber-800">{quote.reason}</p>

                {restaurant.pickupEnabled && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => setFulfillment('PICKUP')}
                  >
                    Switch to pickup instead
                  </Button>
                )}
              </div>
            )}

            {/* Everything that isn't the out-of-range case above. */}
            {quote && !quoting && !(!quote.deliverable && quote.outOfRange) && (
              <div
                className={`rounded-lg p-3 text-sm ${
                  quote.deliverable
                    ? 'bg-emerald-50 text-emerald-900'
                    : 'bg-destructive/10 text-destructive'
                }`}
              >
                {quote.deliverable ? (
                  <>
                    We can deliver here for{' '}
                    <strong>{formatMoney(quote.customerFeeCents, restaurant.currency)}</strong>
                    {quote.dropoffEta && (
                      <>
                        {' '}
                        · arriving around{' '}
                        {new Date(quote.dropoffEta).toLocaleTimeString([], {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </>
                    )}
                  </>
                ) : (
                  quote.reason
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Scheduling */}
      {restaurant.scheduledOrdersEnabled && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">When?</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Select
              value={scheduledFor ? 'later' : 'asap'}
              onChange={(e) => setScheduledFor(e.target.value === 'asap' ? '' : nextSlot())}
            >
              <option value="asap">As soon as possible</option>
              <option value="later">Schedule for later</option>
            </Select>

            {scheduledFor && (
              <Input
                type="datetime-local"
                value={scheduledFor}
                min={nextSlot()}
                onChange={(e) => setScheduledFor(e.target.value)}
              />
            )}
          </CardContent>
        </Card>
      )}

      {/* Tip */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a tip</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-4 gap-2">
            {TIP_PRESETS.map((percent) => {
              const cents = Math.round(((totals?.subtotalCents ?? 0) * percent) / 100);
              const active = tipCents === cents;
              return (
                <button
                  key={percent}
                  type="button"
                  onClick={() => applyTipPercent(percent)}
                  className={`rounded-lg border p-3 text-sm font-medium transition-colors ${
                    active ? 'border-brand bg-brand/5' : 'hover:bg-accent/50'
                  }`}
                >
                  {percent === 0 ? 'None' : `${percent}%`}
                  {percent > 0 && (
                    <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                      {formatMoney(cents, restaurant.currency)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Notes */}
      <Card>
        <CardContent className="space-y-2 p-6">
          <Label htmlFor="order-notes">Notes for the restaurant</Label>
          <Textarea
            id="order-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={500}
            placeholder="Buzzer is broken, please call on arrival…"
          />
        </CardContent>
      </Card>

      {/* Summary */}
      {totals && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Subtotal" cents={totals.subtotalCents} currency={restaurant.currency} />
            {totals.serviceFeeCents > 0 && (
              <Row
                label="Service fee"
                cents={totals.serviceFeeCents}
                currency={restaurant.currency}
              />
            )}
            {totals.deliveryFeeCents > 0 && (
              <Row
                label="Delivery"
                cents={totals.deliveryFeeCents}
                currency={restaurant.currency}
              />
            )}
            <Row label="Tax" cents={totals.taxCents} currency={restaurant.currency} />
            {totals.tipCents > 0 && (
              <Row label="Tip" cents={totals.tipCents} currency={restaurant.currency} />
            )}
            <div className="flex justify-between border-t pt-3 text-base font-semibold">
              <span>Total</span>
              <span className="tabular-nums">
                {formatMoney(totals.totalCents, restaurant.currency)}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      <Button type="submit" variant="brand" size="lg" className="w-full" disabled={!canSubmit}>
        {submitting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Taking you to payment…
          </>
        ) : (
          <>Pay {formatMoney(totals?.totalCents ?? 0, restaurant.currency)}</>
        )}
      </Button>

      <p className="text-center text-xs text-muted-foreground">
        You&apos;ll be redirected to a secure payment page. We never see your card details.
      </p>
    </form>
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

/** The earliest slot the API will accept: 30 minutes out, formatted for datetime-local. */
function nextSlot(): string {
  const d = new Date(Date.now() + 30 * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
