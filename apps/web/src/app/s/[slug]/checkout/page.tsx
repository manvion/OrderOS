'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Plus, ShoppingBag, Truck, UtensilsCrossed } from 'lucide-react';
import { formatMoney, type BusinessHours } from '@dinedirect/shared';
import { toast } from 'sonner';
import { scheduleSlots, upcomingDays } from '@/lib/schedule-slots';
import {
  storefrontApi,
  ApiRequestError,
  type Address,
  type DeliveryQuote,
  type OrderPayment,
} from '@/lib/api';
import { useCart, useCartTotals } from '@/lib/cart-store';
import { AddressAutocomplete } from '@/components/storefront/address-autocomplete';
import { SchedulePicker } from '@/components/storefront/schedule-picker';
import { useTenant, useTenantHref } from '@/components/storefront/tenant-provider';
import { useT, useLocale } from '@/components/storefront/i18n-provider';
import { useCustomerAuth } from '@/components/storefront/customer-auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Checkbox, Label } from '@/components/ui/primitives';

const TIP_PRESETS = [0, 10, 15, 20] as const;

export default function CheckoutPage() {
  const restaurant = useTenant();
  const href = useTenantHref();
  const t = useT();
  const { locale } = useLocale();
  const router = useRouter();

  const lines = useCart((s) => s.lines);
  const fulfillment = useCart((s) => s.fulfillment);
  const setFulfillment = useCart((s) => s.setFulfillment);
  const tipCents = useCart((s) => s.tipCents);
  const setTip = useCart((s) => s.setTip);
  const tableNumber = useCart((s) => s.tableNumber);
  const qrCodeId = useCart((s) => s.qrCodeId);
  const promoCode = useCart((s) => s.promoCode);
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

  // A dine-in order scanned from a table can settle at the counter instead of paying
  // online. Only offered for table orders — never pickup/delivery, where unpaid food
  // walks out the door. Defaults to paying now.
  const isDineInTable = fulfillment === 'DINE_IN' && !!tableNumber;
  const [payMode, setPayMode] = useState<'now' | 'desk'>('now');
  const payAtDesk = isDineInTable && payMode === 'desk';

  const subtotalCents = useCart((s) => s.subtotalCents());

  // Real "schedule for later" slots — only times the kitchen is open, in the
  // restaurant's own timezone, from ~prep-time out to the 14-day horizon. Replaces a
  // free datetime picker that let people choose closed times (and read them in the
  // customer's timezone, not the restaurant's).
  const slots = useMemo(
    () =>
      scheduleSlots(restaurant.businessHours as BusinessHours | null, restaurant.timezone, {
        leadMinutes: Math.max(30, restaurant.prepTimeMinutes),
      }),
    [restaurant.businessHours, restaurant.timezone, restaurant.prepTimeMinutes],
  );

  // "As soon as possible" only works while the kitchen is open. When it's closed we
  // don't hide the option — we prompt them to pick a time instead of silently failing.
  const closedAsap = !restaurant.isOpen && !scheduledFor;

  // The calendar-style day rail for the scheduler (next two weeks in the shop's tz).
  const scheduleDayStrip = useMemo(() => upcomingDays(restaurant.timezone, 14), [restaurant.timezone]);

  // Once a real Uber quote lands, price the order with THAT fee rather than the
  // restaurant's default — otherwise the total shown here wouldn't match the one
  // the server computes and the customer would see it change at Stripe.
  const deliveryFeeOverride =
    quote?.deliverable && fulfillment === 'DELIVERY' ? quote.customerFeeCents : undefined;
  const totals = useCartTotals(restaurant, deliveryFeeOverride);

  const availableFulfillments = useMemo(
    () =>
      [
        restaurant.pickupEnabled && { value: 'PICKUP' as const, label: t.checkout.pickup, icon: ShoppingBag },
        restaurant.deliveryEnabled && { value: 'DELIVERY' as const, label: t.checkout.delivery, icon: Truck },
        restaurant.dineInEnabled && {
          value: 'DINE_IN' as const,
          label: t.checkout.dineIn,
          icon: UtensilsCrossed,
        },
      ].filter(Boolean) as Array<{
        value: 'PICKUP' | 'DELIVERY' | 'DINE_IN';
        label: string;
        icon: typeof ShoppingBag;
      }>,
    [restaurant, t],
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
  //
  // NOT while `submitting`: on success, handleSubmit clears the cart THEN sets
  // window.location.href to Stripe. Clearing is synchronous; leaving the page
  // for an external URL is not. That gap was long enough for this exact effect
  // to fire on the now-empty cart and win the race with router.replace, kicking
  // a customer who had just paid back to the menu instead of on to Stripe. The
  // cart being empty while a payment redirect is in flight is expected, not a
  // reason to leave.
  useEffect(() => {
    if (lines.length === 0 && !submitting) router.replace(href('/menu'));
  }, [lines.length, submitting, router, href]);

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

  // The minimum applies to DELIVERY only. It's the last gate rather than a block on a
  // previous screen, so switching to pickup here immediately lets the order through.
  const belowMinimum = fulfillment === 'DELIVERY' && subtotalCents < restaurant.minOrderCents;

  const canSubmit =
    lines.length > 0 &&
    customer.name.trim().length > 0 &&
    customer.phone.trim().length >= 7 &&
    customer.email.includes('@') &&
    (fulfillment !== 'DELIVERY' || (addressComplete && quote?.deliverable === true)) &&
    !belowMinimum &&
    !closedAsap &&
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
          ...(payAtDesk ? { payAtDesk: true } : {}),
          ...(promoCode ? { promoCode } : {}),
          // So their texts and emails come back in the language they ordered in.
          locale,
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

      // Where the customer lands once paid — the tracking page for this order,
      // derived from the current storefront path so it works on a subdomain or /s/slug.
      const trackUrl = `${window.location.pathname.replace(/\/checkout\/?$/, '')}/track/${response.trackingToken}?paid=1`;

      // Pay at desk: nothing to charge online. The order is placed and already on the
      // kitchen board; send them straight to the tracker to await their food.
      if (response.payAtDesk || response.payment.provider === 'AT_DESK') {
        window.location.href = `${window.location.pathname.replace(/\/checkout\/?$/, '')}/track/${response.trackingToken}?placed=1`;
        return;
      }

      if (response.payment.provider === 'RAZORPAY') {
        // India: Razorpay Checkout is a client-side modal, not a redirect.
        await openRazorpayCheckout(response.payment, {
          orderId: response.orderId,
          slug: restaurant.slug,
          themeColor: restaurant.brandPrimaryColor,
          onPaid: () => {
            window.location.href = trackUrl;
          },
          onDismiss: () => setSubmitting(false),
        });
        return;
      }

      // Everyone else: Stripe hosted checkout.
      window.location.href = response.payment.checkoutUrl;
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

  // Same exception as the redirect effect above: an empty cart while a
  // successful payment redirect is in flight isn't "nothing to see here".
  if (lines.length === 0 && !submitting) return null;

  return (
    <form onSubmit={handleSubmit} className="container max-w-2xl space-y-6 py-8">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">{t.checkout.title}</h1>
        <Button asChild variant="ghost" size="sm">
          <Link href={href('/menu')} prefetch>
            <Plus className="h-4 w-4" />
          {t.cart.addMore}
          </Link>
        </Button>
      </div>

      {/* Fulfillment */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {/* One option isn't a question. A radio group with a single choice is a
                decision the customer doesn't have, dressed up as one they do. */}
            {availableFulfillments.length === 1
              ? availableFulfillments[0].value === 'DELIVERY'
                ? t.checkout.deliveredToYou
                : availableFulfillments[0].value === 'PICKUP'
                  ? t.checkout.collectFromUs
                  : t.checkout.dineInWithUs
              : t.checkout.howToGet}
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
              {t.checkout.orderingForTable} <strong>{tableNumber}</strong>.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Contact */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t.checkout.yourDetails}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">{t.checkout.name}</Label>
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
              <Label htmlFor="phone">{t.checkout.mobileNumber}</Label>
              <Input
                id="phone"
                type="tel"
                value={customer.phone}
                onChange={(e) => setCustomer({ ...customer, phone: e.target.value })}
                required
                autoComplete="tel"
                placeholder="+1 415 555 0123"
              />
              <p className="text-xs text-muted-foreground">{t.checkout.willText}</p>
              {fieldErrors['customer.phone'] && (
                <p className="text-sm text-destructive">{fieldErrors['customer.phone']}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">{t.checkout.email}</Label>
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
            <CardTitle className="text-base">{t.checkout.whereBring}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Saved addresses. The single reason a customer bothers to have an
                account: never type your address again. */}
            {profile && profile.addresses.length > 0 && (
              <div className="space-y-2">
                <Label>{t.checkout.savedAddresses}</Label>
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
                <Label htmlFor="city">{t.checkout.city}</Label>
                <Input
                  id="city"
                  value={address.city}
                  onChange={(e) => setAddress({ ...address, city: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="state">{t.checkout.state}</Label>
                <Input
                  id="state"
                  value={address.state}
                  onChange={(e) => setAddress({ ...address, state: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="postalCode">{t.checkout.zip}</Label>
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
                {t.checkout.checkingDelivery}
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
                {t.checkout.saveAddress}
              </label>
            )}

            {/*
              OUT OF RANGE. Its own treatment, because it is not a failure — it is a
              definite answer, and the customer has a clear next move (switch to
              pickup) that we should hand them rather than make them find.
            */}
            {quote && !quote.deliverable && quote.outOfRange && !quoting && (
              <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
                <p className="text-sm font-semibold text-amber-900">{t.checkout.tooFar}</p>
                <p className="mt-1 text-sm text-amber-800">{quote.reason}</p>

                {restaurant.pickupEnabled && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => setFulfillment('PICKUP')}
                  >
                    {t.checkout.switchToPickup}
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
                    {t.checkout.canDeliverFor}{' '}
                    <strong>{formatMoney(quote.customerFeeCents, restaurant.currency)}</strong>
                    {quote.dropoffEta && (
                      <>
                        {' '}
                        · {t.checkout.arrivingAround}{' '}
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
            <CardTitle className="text-base">{t.checkout.when}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Select
              value={scheduledFor ? 'later' : 'asap'}
              onChange={(e) => setScheduledFor(e.target.value === 'asap' ? '' : (slots[0]?.iso ?? ''))}
            >
              <option value="asap">{t.checkout.asap}</option>
              {slots.length > 0 && <option value="later">{t.checkout.scheduleLater}</option>}
            </Select>

            {scheduledFor && slots.length > 0 && (
              <SchedulePicker
                slots={slots}
                days={scheduleDayStrip}
                value={scheduledFor}
                onChange={setScheduledFor}
                restaurantName={restaurant.name}
              />
            )}

            {closedAsap && slots.length > 0 && (
              <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                {restaurant.name} is closed right now — choose “{t.checkout.scheduleLater}” to book a
                time.
              </p>
            )}

            {!restaurant.isOpen && slots.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No upcoming times are available right now.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Tip */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t.checkout.addTip}</CardTitle>
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
                  {percent === 0 ? t.checkout.tipNone : `${percent}%`}
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
          <Label htmlFor="order-notes">{t.checkout.notesForRestaurant}</Label>
          <Textarea
            id="order-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={500}
            placeholder={t.checkout.notesPlaceholder}
          />
        </CardContent>
      </Card>

      {/* Summary */}
      {totals && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t.checkout.summary}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label={t.checkout.subtotal} cents={totals.subtotalCents} currency={restaurant.currency} />
            {totals.discountCents > 0 && (
              <div className="flex justify-between text-brand">
                <span className="font-medium">{t.checkout.discount}</span>
                <span className="tabular-nums">
                  -{formatMoney(totals.discountCents, restaurant.currency)}
                </span>
              </div>
            )}
            {totals.serviceFeeCents > 0 && (
              <Row
                label={t.checkout.serviceFee}
                cents={totals.serviceFeeCents}
                currency={restaurant.currency}
              />
            )}
            {totals.deliveryFeeCents > 0 && (
              <Row
                label={t.checkout.deliveryFee}
                cents={totals.deliveryFeeCents}
                currency={restaurant.currency}
              />
            )}
            {/* GST + QST as separate named lines, matching the final receipt. */}
            {totals.taxLines.length > 0 ? (
              totals.taxLines.map((line) => (
                <Row
                  key={line.name}
                  label={line.name}
                  cents={line.amountCents}
                  currency={restaurant.currency}
                />
              ))
            ) : (
              <Row label={t.checkout.tax} cents={totals.taxCents} currency={restaurant.currency} />
            )}
            {totals.tipCents > 0 && (
              <Row label={t.checkout.tip} cents={totals.tipCents} currency={restaurant.currency} />
            )}
            <div className="flex justify-between border-t pt-3 text-base font-semibold">
              <span>{t.checkout.total}</span>
              <span className="tabular-nums">
                {formatMoney(totals.totalCents, restaurant.currency)}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* One last chance to add something before paying — right next to Pay. */}
      <Button asChild variant="outline" size="lg" className="w-full">
        <Link href={href('/menu')} prefetch>
          <Plus className="h-4 w-4" />
        {t.cart.addMore}
        </Link>
      </Button>

      {belowMinimum && (
        <p className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          Delivery orders have a {formatMoney(restaurant.minOrderCents, restaurant.currency)}{' '}
          minimum. Add{' '}
          {formatMoney(restaurant.minOrderCents - subtotalCents, restaurant.currency)} more, or
          switch to pickup above.
        </p>
      )}

      {/* Dine-in at a table: pay now, or run it on the table and settle at the counter. */}
      {isDineInTable && (
        <div className="grid grid-cols-2 gap-2">
          {(['now', 'desk'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setPayMode(mode)}
              className={`rounded-xl border p-3 text-left transition ${
                payMode === mode
                  ? 'border-brand ring-2 ring-brand/30'
                  : 'border-border hover:border-brand/40'
              }`}
            >
              <span className="block text-sm font-semibold">
                {mode === 'now' ? 'Pay now' : 'Pay at desk'}
              </span>
              <span className="block text-xs text-muted-foreground">
                {mode === 'now' ? 'Card, online' : 'Settle at the counter'}
              </span>
            </button>
          ))}
        </div>
      )}

      <Button type="submit" variant="brand" size="lg" className="w-full" disabled={!canSubmit}>
        {submitting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            {payAtDesk ? 'Placing order…' : t.checkout.takingToPayment}
          </>
        ) : payAtDesk ? (
          <>Place order · {formatMoney(totals?.totalCents ?? 0, restaurant.currency)} at desk</>
        ) : (
          <>
            {t.checkout.pay} {formatMoney(totals?.totalCents ?? 0, restaurant.currency)}
          </>
        )}
      </Button>

      <p className="text-center text-xs text-muted-foreground">
        {payAtDesk
          ? 'Your order goes to the kitchen now. Pay at the counter when you’re done.'
          : t.checkout.redirectNote}
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
// --- Razorpay (India) checkout modal ---------------------------------------

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

/** Load Razorpay's Checkout script once; resolves false if it can't be fetched. */
function loadRazorpayScript(): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') return resolve(false);
    if (window.Razorpay) return resolve(true);
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });
}

/**
 * Open Razorpay Checkout (UPI / cards / netbanking / wallets) for an India order.
 * On success the modal hands back a signed result, which we post to the API to
 * verify and mark the order paid; then we send the customer to their tracking page.
 */
async function openRazorpayCheckout(
  payment: Extract<OrderPayment, { provider: 'RAZORPAY' }>,
  opts: {
    orderId: string;
    slug: string;
    themeColor: string;
    onPaid: () => void;
    onDismiss: () => void;
  },
) {
  const ready = await loadRazorpayScript();
  if (!ready || !window.Razorpay) {
    toast.error('Could not open the payment window. Check your connection and try again.');
    opts.onDismiss();
    return;
  }

  const rzp = new window.Razorpay({
    key: payment.keyId,
    amount: payment.amount,
    currency: payment.currency,
    name: payment.restaurantName,
    order_id: payment.razorpayOrderId,
    prefill: {
      name: payment.prefill.name,
      email: payment.prefill.email,
      contact: payment.prefill.contact,
    },
    theme: { color: opts.themeColor },
    handler: async (res: { razorpay_payment_id: string; razorpay_signature: string }) => {
      try {
        await storefrontApi.verifyRazorpay(opts.slug, opts.orderId, {
          razorpayPaymentId: res.razorpay_payment_id,
          razorpaySignature: res.razorpay_signature,
        });
        opts.onPaid();
      } catch {
        toast.error(
          'We could not confirm your payment. If money was deducted it will be reflected shortly — contact the restaurant if not.',
        );
        opts.onDismiss();
      }
    },
    modal: { ondismiss: opts.onDismiss },
  });
  rzp.open();
}
