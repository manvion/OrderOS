'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Globe,
  Loader2,
  QrCode,
  ShoppingBag,
  Truck,
  UtensilsCrossed,
  X,
} from 'lucide-react';
import {
  COUNTRIES,
  DEFAULT_BUSINESS_HOURS,
  WEEKDAYS,
  getCountry,
  getPlan,
  createRestaurantSchema,
  resolveTaxProfile,
  PLAN_TIERS,
  type BusinessHours,
  type PlanTier,
  type TaxComponent,
  type TaxCountry,
} from '@dinedirect/shared';
import { TaxStep } from './tax-step';
import { toast } from 'sonner';
import { ApiRequestError, createDashboardApi, type OrderingMode } from '@/lib/api';
import { useAuthToken } from '@/lib/auth-compat';
import { hasApexDomain, tenantUrl } from '@/lib/tenant-url';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Label, Switch } from '@/components/ui/primitives';

const STEPS = ['Your restaurant', 'Where you are', 'When you open', 'How you serve'] as const;

/**
 * Signup.
 *
 * The old version asked for eleven fields and dumped you in a dashboard, leaving
 * hours, tax and fulfillment on defaults. Every one of those defaults is a quiet
 * lie about somebody's business:
 *
 *   - tax 0%      -> they under-collect tax on every order and find out at audit
 *   - 11:00-22:00 -> a restaurant closed on Mondays takes Monday orders
 *   - pickup only -> a delivery-only kitchen offers a counter it doesn't have
 *
 * A default that is right for nobody is worse than a question. So we ask — but in
 * four short steps rather than one wall of forty fields, because a signup form
 * people abandon collects nothing at all.
 *
 * What we deliberately DON'T ask here: the menu and Stripe. Those are real work,
 * they need their own screens, and blocking someone's account creation behind them
 * is how you lose a restaurant that just wanted to look around first.
 *
 * ONE wizard, two callers:
 *
 *   mode="self"  — a restaurant signing themselves up.
 *   mode="admin" — us, onboarding them on a phone call. Same questions, plus who
 *                  owns it and what we charge.
 *
 * They are the same form on purpose. The admin panel used to have its own, shorter
 * form that never asked about tax or hours — so a restaurant WE onboarded by hand
 * went live on default hours charging 0% tax, while one that signed itself up did
 * not. Two forms means the second one is always the one that's wrong.
 */
export function SignupWizard({ mode = 'self' }: { mode?: 'self' | 'admin' }) {
  const isAdmin = mode === 'admin';
  const { getToken } = useAuthToken();
  const router = useRouter();

  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [slugTouched, setSlugTouched] = useState(false);
  const [slugStatus, setSlugStatus] = useState<'idle' | 'checking' | 'free' | 'taken'>('idle');

  const [form, setForm] = useState({
    name: '',
    slug: '',
    description: '',
    phone: '',
    email: '',
    street: '',
    city: '',
    state: '',
    postalCode: '',
    country: 'US',
    timezone: 'America/New_York',
    currency: 'USD',

    /** WEBSITE or QR_ONLY — see the OrderingMode enum. */
    orderingMode: 'WEBSITE' as OrderingMode,

    pickupEnabled: true,
    deliveryEnabled: false,
    dineInEnabled: false,

    // Admin-only. Ignored entirely in self-signup: the person filling the form IS
    // the owner, and they cannot set their own commission or plan.
    ownerEmail: '',
    ownerPassword: '',
    feePercent: '',
    planTier: 'STARTER' as PlanTier,

    prepTimeMinutes: 20,
    deliveryFeeCents: 499,
    serviceFeeCents: 0,
    minOrderCents: 0,

    /** Asked, never assumed. See the note above. */
    taxPercent: '',
    taxConfirmedZero: false,
  });

  const [hours, setHours] = useState<BusinessHours>(DEFAULT_BUSINESS_HOURS);

  // Tax, per jurisdiction. Pre-filled from a table, confirmed by the restaurant —
  // see components/onboarding/tax-step.tsx for why the confirmation IS the feature.
  const [taxCountry, setTaxCountry] = useState<TaxCountry>('US');
  const [taxRegion, setTaxRegion] = useState('');
  const [taxComponents, setTaxComponents] = useState<TaxComponent[]>([]);
  const [indiaHotel, setIndiaHotel] = useState(false);
  const [taxConfirmed, setTaxConfirmed] = useState(false);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  // Suggest the subdomain from the name until they edit it themselves.
  useEffect(() => {
    if (slugTouched) return;
    setForm((f) => ({
      ...f,
      slug: f.name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .slice(0, 40),
    }));
  }, [form.name, slugTouched]);

  /**
   * Availability check, debounced — it hits the database on every call.
   *
   * Skipped for an admin: `/restaurants/slug-available` is tenant-guarded, and a
   * platform admin holds no membership, so it would 403 on every keystroke and show
   * a permanent red cross on a name that is perfectly free. They get the answer from
   * the API on submit instead ("that address is already taken"), which is one round
   * trip rather than a lie.
   */
  useEffect(() => {
    if (isAdmin) return;
    if (form.slug.length < 3) {
      setSlugStatus('idle');
      return;
    }
    let cancelled = false;
    setSlugStatus('checking');

    const t = setTimeout(async () => {
      try {
        const api = createDashboardApi(getToken);
        const { available } = await api.checkSlug(form.slug);
        if (!cancelled) setSlugStatus(available ? 'free' : 'taken');
      } catch {
        if (!cancelled) setSlugStatus('idle');
      }
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [form.slug, getToken, isAdmin]);

  /** Everything on the address step follows from this: currency, timezones,
   *  region label and list, and whether Stripe can pay them at all. */
  const country = getCountry(form.country);

  const anyFulfillment = form.pickupEnabled || form.deliveryEnabled || form.dineInEnabled;

  // An admin cannot check the slug (see above), so format is the bar; the server has
  // the final word. A self-signup must see a green tick before moving on.
  const slugOk = isAdmin ? form.slug.trim().length > 2 : slugStatus === 'free';

  /** Can they leave this step? */
  const stepValid = [
    form.name.trim().length > 1 &&
      slugOk &&
      form.phone.length > 6 &&
      form.email.includes('@') &&
      // The owner's own email, plus (if the admin chose to set one) a password of at
      // least 8 characters. A blank password is fine — it means "send an invite".
      (!isAdmin ||
        (form.ownerEmail.includes('@') &&
          (form.ownerPassword.trim().length === 0 || form.ownerPassword.trim().length >= 8))),
    form.street.length > 2 && form.city.length > 1 && form.state.length > 1 && form.postalCode.length > 2,
    // Hours are always valid — a restaurant that's closed every day is odd, but
    // it's their business, and blocking them here helps nobody.
    true,
    // Tax must be answered: a number, OR an explicit "no tax applies to me".
    // Zero tax is a legitimate answer. NOT answering is not.
    anyFulfillment && taxConfirmed,
  ][step];

  const submit = async () => {
    setErrors({});
    setSubmitting(true);

    const payload = {
      name: form.name,
      slug: form.slug,
      description: form.description.trim() || undefined,
      phone: form.phone,
      email: form.email,
      address: {
        street: form.street,
        city: form.city,
        state: form.state,
        postalCode: form.postalCode,
        country: form.country,
      },
      timezone: form.timezone,
      currency: form.currency,
      businessHours: hours,
      orderingMode: form.orderingMode,
      pickupEnabled: form.pickupEnabled,
      deliveryEnabled: form.deliveryEnabled,
      dineInEnabled: form.dineInEnabled,
      taxComponents: taxComponents.filter((c) => c.name.trim() && c.rateBps > 0),
      taxCountry,
      taxRegion: taxRegion || undefined,
      deliveryFeeCents: form.deliveryFeeCents,
      serviceFeeCents: form.serviceFeeCents,
      minOrderCents: form.minOrderCents,
      prepTimeMinutes: form.prepTimeMinutes,
    };

    // Validate with the SAME schema the API uses, so they see field errors here
    // rather than after a round trip.
    const parsed = createRestaurantSchema.safeParse(payload);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) fieldErrors[issue.path.join('.')] = issue.message;
      setErrors(fieldErrors);
      setSubmitting(false);
      toast.error(Object.values(fieldErrors)[0] ?? 'Please check the form');
      return;
    }

    try {
      const api = createDashboardApi(getToken);

      if (isAdmin) {
        await api.adminCreateRestaurant({
          ...parsed.data,
          ownerEmail: form.ownerEmail.trim(),
          planTier: form.planTier,
          // Leave the commission blank to let the server use the plan's default rate.
          // Only send an explicit number when the admin has typed one to override it.
          ...(form.feePercent.trim()
            ? { platformFeeBps: Math.round(parseFloat(form.feePercent) * 100) }
            : {}),
          // A password creates the account immediately; blank sends an email invite.
          ...(form.ownerPassword.trim() ? { ownerPassword: form.ownerPassword } : {}),
        });
        toast.success(
          `Created. ${form.ownerEmail} has been emailed an invitation — they set their own password.`,
          { duration: 10_000 },
        );
        router.push('/admin');
        return;
      }

      await api.createRestaurant(parsed.data);
      toast.success('Your restaurant is set up. Now add your menu.');
      router.push('/dashboard/setup');
    } catch (err) {
      setSubmitting(false);
      if (err instanceof ApiRequestError) {
        if (err.body.fieldErrors) setErrors(err.body.fieldErrors);
        toast.error(err.body.message);
        return;
      }
      toast.error('Something went wrong. Please try again.');
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-5 py-12">
      {isAdmin && (
        <Button variant="ghost" size="sm" className="mb-4" onClick={() => router.push('/admin')}>
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to the console
        </Button>
      )}

      {/* Progress. Concrete steps, not a percentage. */}
      <div className="mb-8">
        <div className="flex gap-1.5">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`h-1.5 flex-1 rounded-full transition-colors ${
                i <= step ? 'bg-brand' : 'bg-muted'
              }`}
            />
          ))}
        </div>
        <p className="mt-3 text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Step {step + 1} of {STEPS.length} · {STEPS[step]}
        </p>
      </div>

      <Card className="animate-rise">
        <CardContent className="space-y-6 p-7">
          {/* ---------------- 1. Your restaurant ---------------- */}
          {step === 0 && (
            <>
              <Heading
                title="Tell us about your restaurant"
                body="This is what your customers will see."
              />

              <Field label="Restaurant name" error={errors.name}>
                <Input
                  value={form.name}
                  onChange={(e) => set('name', e.target.value)}
                  placeholder="Bella Burger"
                  autoFocus
                />
              </Field>

              <div className="space-y-2">
                <Label>Your web address</Label>
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Input
                      value={form.slug}
                      onChange={(e) => {
                        setSlugTouched(true);
                        set('slug', e.target.value.toLowerCase());
                      }}
                      className="pr-9"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2">
                      {slugStatus === 'checking' && (
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      )}
                      {slugStatus === 'free' && <Check className="h-4 w-4 text-emerald-600" />}
                      {slugStatus === 'taken' && <X className="h-4 w-4 text-destructive" />}
                    </span>
                  </div>
                  {/* Only promise a subdomain when one will actually resolve. With no
                      apex configured, the suffix disappears and the preview below
                      shows the path URL that genuinely works on THIS deployment. */}
                  {hasApexDomain() && (
                    <span className="shrink-0 text-sm text-muted-foreground">
                      .{process.env.NEXT_PUBLIC_APP_DOMAIN}
                    </span>
                  )}
                </div>
                {form.slug.length >= 3 && slugStatus === 'free' && (
                  <p className="text-sm text-muted-foreground">
                    Your ordering page: <span className="font-mono">{tenantUrl(form.slug)}</span>
                  </p>
                )}
                {slugStatus === 'taken' && (
                  <p className="text-sm text-destructive">That address is taken.</p>
                )}
                {errors.slug && <p className="text-sm text-destructive">{errors.slug}</p>}
              </div>

              <Field label="Description" hint="One or two lines. Optional.">
                <Textarea
                  value={form.description}
                  onChange={(e) => set('description', e.target.value)}
                  placeholder="Smash burgers, hand-cut fries, and milkshakes worth the calories."
                  className="min-h-[70px]"
                />
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Phone" error={errors.phone}>
                  <Input
                    type="tel"
                    value={form.phone}
                    onChange={(e) => set('phone', e.target.value)}
                    placeholder="+1 415 555 0123"
                  />
                </Field>
                <Field label="Contact email" error={errors.email}>
                  <Input
                    type="email"
                    value={form.email}
                    onChange={(e) => set('email', e.target.value)}
                  />
                </Field>
              </div>

              {/*
                Admin only: who owns this, and what we charge them.

                We create the restaurant; we do NOT create their account. The owner
                gets an invitation at this address and sets their own password. An
                account whose password we chose is an account we can silently log in
                as, and "the platform can become me without my knowledge" is not
                something a business holding its revenue with us should have to
                accept.
              */}
              {isAdmin && (
                <div className="space-y-4 rounded-xl border border-dashed p-4">
                  <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                    Platform only — the owner never sees this
                  </p>

                  <Field
                    label="Owner's email"
                    hint="Leave the password below blank to email them an invite to set their own."
                  >
                    <Input
                      type="email"
                      value={form.ownerEmail}
                      onChange={(e) => set('ownerEmail', e.target.value)}
                      placeholder="joe@joesburgers.com"
                    />
                  </Field>

                  <Field
                    label="Set a password (optional)"
                    hint="Fill this in to create their account now with this password — they can change it later. Leave blank to send an email invite instead."
                  >
                    <Input
                      type="text"
                      autoComplete="off"
                      value={form.ownerPassword}
                      onChange={(e) => set('ownerPassword', e.target.value)}
                      placeholder="At least 8 characters"
                    />
                  </Field>

                  <Field
                    label="Plan"
                    hint="Assigned now, no card required — the owner can upgrade later from their own billing page."
                  >
                    <Select
                      value={form.planTier}
                      onChange={(e) => set('planTier', e.target.value as PlanTier)}
                    >
                      {PLAN_TIERS.map((t) => {
                        const plan = getPlan(t);
                        return (
                          <option key={t} value={t}>
                            {plan.name} — {plan.tagline}
                          </option>
                        );
                      })}
                    </Select>
                  </Field>

                  <Field
                    label="Our commission (%)"
                    hint={`Leave blank to use the plan default (${(getPlan(form.planTier).commissionBps / 100).toFixed(getPlan(form.planTier).commissionBps % 100 ? 2 : 0)}%). Override only for a negotiated rate.`}
                  >
                    <Input
                      type="number"
                      step="0.1"
                      min="0"
                      max="30"
                      value={form.feePercent}
                      onChange={(e) => set('feePercent', e.target.value)}
                      placeholder={(getPlan(form.planTier).commissionBps / 100).toFixed(
                        getPlan(form.planTier).commissionBps % 100 ? 2 : 0,
                      )}
                    />
                  </Field>
                </div>
              )}
            </>
          )}

          {/* ---------------- 2. Where you are ---------------- */}
          {step === 1 && (
            <>
              <Heading
                title="Where are you?"
                body="Used for pickup directions, and as the collection point for delivery couriers."
              />

              {/*
                COUNTRY FIRST, because everything else follows from it: the currency,
                the timezones on offer, the states list, the tax regime, and whether
                Stripe can pay this restaurant at all.

                It used to be hardcoded to 'US' with no picker, while the tax step
                asked for a country separately — so a restaurant in Toronto could set
                Canadian tax and still be created as a US business, then fail Stripe
                onboarding for a reason invisible to everyone involved.
              */}
              <Field label="Country">
                <Select
                  value={form.country}
                  onChange={(e) => {
                    const next = getCountry(e.target.value);
                    setForm((f) => ({
                      ...f,
                      country: next.code,
                      // Everything downstream follows the country. Overriding these
                      // by hand is possible afterwards; guessing them is not.
                      currency: next.currency,
                      timezone: next.timezones[0],
                      state: '',
                    }));
                    if (next.taxRegime) {
                      setTaxCountry(next.taxRegime);
                      setTaxComponents(resolveTaxProfile(next.taxRegime, '', {}).components);
                      setTaxRegion('');
                      setTaxConfirmed(false);
                    }
                  }}
                >
                  {COUNTRIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>

              {/*
                Stripe Connect does not support payouts to businesses in every country
                we can otherwise serve. Say so HERE, on the form, rather than letting
                them find out after typing their bank details into Stripe's ten-minute
                onboarding — which is exactly where the goodwill runs out.
              */}
              {!country.stripeSupported && (
                <p className="rounded-lg bg-amber-50 p-3 text-sm leading-relaxed text-amber-900">
                  <strong>Heads up:</strong> Stripe cannot pay out to businesses in{' '}
                  {country.name} yet. You can set everything else up — menu, QR codes,
                  orders — but online card payments will not work until that changes. Cash
                  and in-person payment still do.
                </p>
              )}

              <Field label="Street address" error={errors['address.street']}>
                <Input value={form.street} onChange={(e) => set('street', e.target.value)} autoFocus />
              </Field>

              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="City" error={errors['address.city']}>
                  <Input value={form.city} onChange={(e) => set('city', e.target.value)} />
                </Field>

                {/* "State" in Texas, "Province" in Ontario, "County" in Kent. A form
                    that calls it the wrong thing feels like it was built for somewhere
                    else — because it was. */}
                <Field label={country.regionLabel} error={errors['address.state']}>
                  {country.regions.length > 0 ? (
                    <Select value={form.state} onChange={(e) => set('state', e.target.value)}>
                      <option value="">Choose…</option>
                      {country.regions.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input value={form.state} onChange={(e) => set('state', e.target.value)} />
                  )}
                </Field>

                <Field label={country.postalLabel} error={errors['address.postalCode']}>
                  <Input
                    value={form.postalCode}
                    onChange={(e) => set('postalCode', e.target.value)}
                  />
                </Field>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Timezone" hint="Your opening hours are in this timezone.">
                  <Select value={form.timezone} onChange={(e) => set('timezone', e.target.value)}>
                    {country.timezones.map((tz) => (
                      <option key={tz} value={tz}>
                        {tz.replace(/_/g, ' ').replace('America/', '').replace('Asia/', '')}
                      </option>
                    ))}
                  </Select>
                </Field>
                {/*
                  Currency is SHOWN, not chosen.

                  It used to be a dropdown of every currency we support, which reads as a
                  helpful option and is actually a trap: picking USD for a Toronto
                  restaurant does not convert anything, it just relabels every price on
                  the menu — the same numbers, now meaning 35% less money. There is no
                  legitimate reason for a restaurant to be paid in a currency other than
                  the one where it stands, and Stripe would refuse the payout anyway.
                */}
                <Field label="Currency" hint="Set by your country. Your menu prices are in this.">
                  <p className="flex h-10 items-center text-sm font-medium">
                    {country.currencySymbol} {country.currency}
                  </p>
                </Field>
              </div>
            </>
          )}

          {/* ---------------- 3. When you open ---------------- */}
          {step === 2 && (
            <>
              <Heading
                title="When are you open?"
                body="Customers can't place an ASAP order when you're closed. Get this right and your phone stops ringing."
              />

              <div className="space-y-2">
                {WEEKDAYS.map((day) => {
                  const d = hours[day];
                  return (
                    <div
                      key={day}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3"
                    >
                      <div className="flex items-center gap-3">
                        <Switch
                          checked={!d.closed}
                          onCheckedChange={(open) =>
                            setHours({
                              ...hours,
                              [day]: {
                                closed: !open,
                                windows: open && d.windows.length === 0
                                  ? [{ open: '11:00', close: '22:00' }]
                                  : d.windows,
                              },
                            })
                          }
                        />
                        <span className="w-24 text-sm font-medium capitalize">{day}</span>
                      </div>

                      {d.closed ? (
                        <span className="text-sm text-muted-foreground">Closed</span>
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <Input
                            type="time"
                            value={d.windows[0]?.open ?? '11:00'}
                            onChange={(e) =>
                              setHours({
                                ...hours,
                                [day]: {
                                  ...d,
                                  windows: [{ ...d.windows[0], open: e.target.value }],
                                },
                              })
                            }
                            className="h-9 w-28"
                          />
                          <span className="text-muted-foreground">–</span>
                          <Input
                            type="time"
                            value={d.windows[0]?.close ?? '22:00'}
                            onChange={(e) =>
                              setHours({
                                ...hours,
                                [day]: {
                                  ...d,
                                  windows: [{ ...d.windows[0], close: e.target.value }],
                                },
                              })
                            }
                            className="h-9 w-28"
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <p className="text-xs text-muted-foreground">
                Split shifts (lunch and dinner with a gap) can be added later in Settings.
              </p>
            </>
          )}

          {/* ---------------- 4. How you serve ---------------- */}
          {step === 3 && (
            <>
              <Heading
                title="How do you serve customers?"
                body="Pick everything that applies. You can change any of this later."
              />

              {/*
                WEBSITE or QR-ONLY.

                Plenty of restaurants have a Facebook page, no website, and no
                intention of getting one. Handing them a homepage they will never
                link to is not a gift — it's a page that ranks for their name and
                shows a half-finished site with a stock photo on it.

                So QR-only is a real mode, not a setting: no homepage, no about page,
                noindexed, and the only way in is the code on the table. Choosing it
                turns dine-in on, because the customer is standing in the room.
              */}
              <div className="grid gap-3 sm:grid-cols-2">
                <Mode
                  icon={Globe}
                  label="Website + QR"
                  hint="An ordering page at their own web address, plus QR codes if they want them."
                  checked={form.orderingMode === 'WEBSITE'}
                  onSelect={() => set('orderingMode', 'WEBSITE')}
                />
                <Mode
                  icon={QrCode}
                  label="QR only — no website"
                  hint="Customers scan a code at the table or counter. Nothing is published or indexed."
                  checked={form.orderingMode === 'QR_ONLY'}
                  onSelect={() => {
                    setForm((f) => ({
                      ...f,
                      orderingMode: 'QR_ONLY',
                      // They're in the building. Still overridable — a takeaway
                      // counter with a QR on it is also QR-only.
                      dineInEnabled: true,
                    }));
                  }}
                />
              </div>

              {form.orderingMode === 'QR_ONLY' && (
                <p className="rounded-lg bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
                  No website will be published. Print the QR codes from the dashboard and put them on
                  the tables — scanning one opens the menu straight away. They can switch a website on
                  later without losing anything.
                </p>
              )}

              <div className="grid gap-3 sm:grid-cols-3">
                <Method
                  icon={ShoppingBag}
                  label="Pickup"
                  hint="They collect"
                  checked={form.pickupEnabled}
                  onChange={(v) => set('pickupEnabled', v)}
                />
                <Method
                  icon={Truck}
                  label="Delivery"
                  hint="You or Uber"
                  checked={form.deliveryEnabled}
                  onChange={(v) => set('deliveryEnabled', v)}
                />
                <Method
                  icon={UtensilsCrossed}
                  label="Dine in"
                  hint="QR at the table"
                  checked={form.dineInEnabled}
                  onChange={(v) => set('dineInEnabled', v)}
                />
              </div>

              {!anyFulfillment && (
                <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                  Pick at least one — otherwise nobody can order anything.
                </p>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Prep time (minutes)" hint="What we tell customers.">
                  <Input
                    type="number"
                    min={1}
                    max={180}
                    value={form.prepTimeMinutes}
                    onChange={(e) => set('prepTimeMinutes', Math.max(1, Number(e.target.value)))}
                  />
                </Field>

                {form.deliveryEnabled && (
                  <Field label={`Delivery fee (${form.currency})`} hint="What the customer pays you.">
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={(form.deliveryFeeCents / 100).toFixed(2)}
                      onChange={(e) =>
                        set('deliveryFeeCents', Math.round(parseFloat(e.target.value || '0') * 100))
                      }
                    />
                  </Field>
                )}
              </div>

              {/*
                TAX. The whole reason this wizard exists.

                It used to be a single number defaulting to 0%, which is wrong three
                ways: a restaurant that never opened Settings went live
                under-collecting tax; and a single number cannot even EXPRESS Quebec
                (GST 5% + QST 9.975%) or India (CGST 2.5% + SGST 2.5%), both of which
                must be printed as separately-named lines on a legal receipt.

                So: pick your jurisdiction, we pre-fill the components, you confirm
                or correct them. The confirmation is the product — the table is a
                courtesy, and we say so out loud.
              */}
              <TaxStep
                country={taxCountry}
                region={taxRegion}
                components={taxComponents}
                indiaHotel={indiaHotel}
                // No onCountry: the tax country IS the business country, and it is set
                // by the country picker on the business-details step. Two ways to set
                // one fact is how a Toronto restaurant ends up filed as a US business.
                onRegion={(r) => {
                  setTaxRegion(r);
                  const next = resolveTaxProfile(taxCountry, r, { indiaHotelRate: indiaHotel });
                  setTaxComponents(next.components);
                }}
                onIndiaHotel={(v) => {
                  setIndiaHotel(v);
                  setTaxComponents(
                    resolveTaxProfile('IN', taxRegion, { indiaHotelRate: v }).components,
                  );
                }}
                onComponents={setTaxComponents}
                confirmed={taxConfirmed}
                onConfirm={setTaxConfirmed}
              />
            </>
          )}

          {/* Navigation */}
          <div className="flex items-center justify-between gap-3 border-t pt-6">
            <Button
              variant="ghost"
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              disabled={step === 0 || submitting}
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>

            {step < STEPS.length - 1 ? (
              <Button onClick={() => setStep((s) => s + 1)} disabled={!stepValid}>
                Continue
                <ArrowRight className="h-4 w-4" />
              </Button>
            ) : (
              <Button onClick={submit} disabled={!stepValid || submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Creating…
                  </>
                ) : (
                  <>
                    {isAdmin ? 'Create and invite the owner' : 'Create my restaurant'}
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        Next: your menu and Stripe. Those take longer, so they get their own screens.
      </p>
    </div>
  );
}

function Heading({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{body}</p>
    </div>
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
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

/** A one-of-two choice, unlike Method which is a toggle. */
function Mode({
  icon: Icon,
  label,
  hint,
  checked,
  onSelect,
}: {
  icon: typeof Truck;
  label: string;
  hint: string;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={checked}
      className={`flex items-start gap-3 rounded-xl border p-4 text-left transition-colors ${
        checked ? 'border-brand-subtle bg-brand-subtle' : 'hover:bg-accent/50'
      }`}
    >
      <Icon className="mt-0.5 h-5 w-5 shrink-0" />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          {label}
          {checked && <Check className="h-3.5 w-3.5 text-brand" />}
        </span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}

function Method({
  icon: Icon,
  label,
  hint,
  checked,
  onChange,
}: {
  icon: typeof Truck;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`flex flex-col items-center gap-1.5 rounded-xl border p-4 transition-colors ${
        checked ? 'border-brand-subtle bg-brand-subtle' : 'hover:bg-accent/50'
      }`}
    >
      <Icon className="h-5 w-5" />
      <span className="text-sm font-medium">{label}</span>
      <span className="text-xs text-muted-foreground">{hint}</span>
      {checked && <Check className="h-3.5 w-3.5 text-brand" />}
    </button>
  );
}
