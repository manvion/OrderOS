'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  CircleAlert,
  CreditCard,
  ExternalLink,
  Languages,
  Lock,
  Rocket,
} from 'lucide-react';
import { toast } from 'sonner';
import { usesRazorpay, type BusinessHours } from '@dinedirect/shared';
import { useApi, useDashboard, useRequireRole } from '@/components/dashboard/dashboard-provider';
import { AboutEditor } from '@/components/dashboard/about-editor';
import { BrandingEditor } from '@/components/dashboard/branding-editor';
import { SocialLinksEditor } from '@/components/dashboard/social-links-editor';
import { BusinessLocationForm } from '@/components/dashboard/business-location-form';
import { ContactDetailsForm } from '@/components/dashboard/contact-details-form';
import { HoursEditor } from '@/components/dashboard/hours-editor';
import { LegalIdentityForm } from '@/components/dashboard/legal-identity-form';
import { ApiRequestError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label, Skeleton, Switch } from '@/components/ui/primitives';

export default function SettingsPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { restaurant, can, hasFeature } = useDashboard();
  useRequireRole('OWNER', '/dashboard');
  const searchParams = useSearchParams();

  // India collects through Razorpay Route, everyone else through Stripe.
  const isIndia = restaurant ? usesRazorpay(restaurant.country) : false;

  const { data: stripe, isLoading: loadingStripe } = useQuery({
    queryKey: ['stripe', 'status', restaurant?.id],
    queryFn: () => api.getStripeStatus(),
    enabled: Boolean(restaurant) && !isIndia,
  });

  const { data: razorpay, isLoading: loadingRazorpay } = useQuery({
    queryKey: ['razorpay', 'status', restaurant?.id],
    queryFn: () => api.getRazorpayStatus(),
    enabled: Boolean(restaurant) && isIndia,
  });

  const connectRazorpay = useMutation({
    mutationFn: () => api.createRazorpayOnboarding(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['razorpay'] });
      toast.success(
        'Razorpay account created. Finish your KYC on Razorpay, then Refresh status here.',
        { duration: 9000 },
      );
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiRequestError ? err.body.message : 'Could not start Razorpay onboarding',
        { duration: 9000 },
      ),
  });

  const { data: readiness } = useQuery({
    queryKey: ['publish-readiness', restaurant?.id],
    queryFn: () => api.getPublishReadiness(),
    enabled: Boolean(restaurant),
  });

  // Coming back from Stripe's onboarding flow. We don't trust ?connected=1 — the
  // query above re-asks Stripe whether they can actually take a card.
  useEffect(() => {
    if (searchParams.get('connected')) {
      void queryClient.invalidateQueries({ queryKey: ['stripe'] });
      void queryClient.invalidateQueries({ queryKey: ['publish-readiness'] });
    }
  }, [searchParams, queryClient]);

  // See the address block below: an unpublished page 404s for the public, so the
  // owner gets a token-gated look instead of a dead link.
  const openPreview = useMutation({
    mutationFn: () => api.createPreviewLink(),
    onSuccess: ({ url }) => {
      window.open(url, '_blank');
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not open a preview'),
  });

  const manageStripe = useMutation({
    mutationFn: () => api.createStripeManageLink(),
    onSuccess: ({ url }) => window.open(url, '_blank'),
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not open Stripe'),
  });

  const connectStripe = useMutation({
    mutationFn: () => api.createStripeOnboardingLink(),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    // Stripe's rejections name the actual problem ("Connect is not enabled on
    // this account", "country not supported") and the API now passes that
    // through. Swallowing it into a generic line turned every one of those
    // into the same unfixable bug report: "stripe setup is not working".
    onError: (err) =>
      toast.error(
        err instanceof ApiRequestError ? err.body.message : 'Could not start Stripe onboarding',
        { duration: 10000 },
      ),
  });

  const publish = useMutation({
    mutationFn: () => api.publish(),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.success('You are live! Your ordering page is open for business.');
    },
    onError: (err) => {
      // The API returns the specific blockers. Show the first one rather than a
      // generic "failed", so the owner knows what to fix.
      if (err instanceof ApiRequestError) {
        const blockers = err.body.blockers as string[] | undefined;
        toast.error(blockers?.[0] ?? err.body.message);
        return;
      }
      toast.error('Could not publish');
    },
  });

  const saveLanguage = useMutation({
    mutationFn: (menuLanguage: 'EN' | 'FR' | 'BOTH') => api.updateCurrent({ menuLanguage }),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.success('Content language updated');
    },
    onError: () => toast.error('Could not update the language'),
  });

  if (!restaurant) return null;

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">{restaurant.name}</p>
      </div>

      {/* Publishing */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Rocket className="h-4 w-4" />
            Your ordering page
          </CardTitle>
          <CardDescription>
            {restaurant.isPublished
              ? 'Live and taking orders.'
              : 'Not live yet — customers cannot order.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {readiness && (
            <>
              <div className="rounded-lg border p-3">
                {!hasFeature('WEBSITE_STOREFRONT') ? (
                  /* Starter is QR-only: it has no shareable website, so we never
                     print the public URL — seeing it invites sharing an address the
                     plan doesn't include, and reveals the domain. Customers reach the
                     menu by scanning a code; staff can still open a private preview. */
                  <>
                    <p className="text-xs text-muted-foreground">Your ordering page</p>
                    <div className="mt-1 flex flex-wrap items-center gap-3">
                      <span className="text-sm">Customers order by scanning your QR codes.</span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openPreview.mutate()}
                        disabled={openPreview.isPending}
                      >
                        {openPreview.isPending ? 'Opening…' : 'Preview'}
                        <ExternalLink className="h-3 w-3" />
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-xs text-muted-foreground">Your address</p>
                    {restaurant?.isPublished ? (
                      <a
                        href={readiness.storefrontUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1.5 font-mono text-sm font-medium hover:underline"
                      >
                        {readiness.storefrontUrl}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      /* Before publish, the bare address 404s BY DESIGN (unpublished pages
                         are invisible to the public). Rendering it as a link taught every
                         owner to click it and file the 404 as a bug. Instead: the address
                         as text, and a Preview button that mints a 30-minute staff pass. */
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="font-mono text-sm font-medium">{readiness.storefrontUrl}</span>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openPreview.mutate()}
                          disabled={openPreview.isPending}
                        >
                          {openPreview.isPending ? 'Opening…' : 'Preview'}
                          <ExternalLink className="h-3 w-3" />
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </div>

              {readiness.blockers.length > 0 && (
                <ul className="space-y-2 text-sm">
                  {readiness.blockers.map((blocker) => (
                    <li key={blocker} className="flex items-center gap-2">
                      <CircleAlert className="h-4 w-4 shrink-0 text-destructive" />
                      {blocker}
                    </li>
                  ))}
                </ul>
              )}

              {readiness.warnings.length > 0 && (
                <ul className="space-y-2 text-sm text-muted-foreground">
                  {readiness.warnings.map((warning) => (
                    <li key={warning} className="flex items-center gap-2">
                      <CircleAlert className="h-4 w-4 shrink-0 text-amber-500" />
                      {warning}
                    </li>
                  ))}
                </ul>
              )}

              {!restaurant.isPublished && can('OWNER') && (
                <Button
                  onClick={() => publish.mutate()}
                  disabled={!readiness.ready || publish.isPending}
                >
                  {publish.isPending ? 'Publishing…' : 'Publish my page'}
                </Button>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Content language — sets which language(s) menus & catering are written in,
          and drives the AI-fill language options everywhere. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Languages className="h-4 w-4" />
            Content language
          </CardTitle>
          <CardDescription>
            The language(s) you write your menu and catering in. Choosing both turns on a
            French / English / both option wherever you use AI fill.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 sm:grid-cols-3">
            {(
              [
                { value: 'EN', label: 'English' },
                { value: 'FR', label: 'French' },
                { value: 'BOTH', label: 'English & French' },
              ] as const
            ).map(({ value, label }) => (
              <button
                key={value}
                type="button"
                disabled={!can('OWNER') || saveLanguage.isPending}
                onClick={() => saveLanguage.mutate(value)}
                className={`rounded-xl border p-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  (restaurant.menuLanguage ?? 'EN') === value
                    ? 'border-brand-subtle bg-brand-subtle'
                    : 'hover:bg-accent/50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Where they are. Sits ABOVE the legal card on purpose: the country chosen here
          decides what the tax field below is even called, and whether it is required. */}
      <ContactDetailsForm />

      <BusinessLocationForm />

      {/* Who the restaurant is to a tax authority — what makes a receipt a valid invoice. */}
      <LegalIdentityForm />

      {/* Stripe */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CreditCard className="h-4 w-4" />
            Payments
          </CardTitle>
          <CardDescription>
            {isIndia
              ? 'India: money goes straight from your customer to your Razorpay account (UPI, PhonePe, Google Pay, cards). We never hold it.'
              : 'Money goes straight from your customer to your Stripe account. We never hold it.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isIndia ? (
            loadingRazorpay ? (
              <Skeleton className="h-10 w-full" />
            ) : razorpay?.enabled ? (
              <div className="flex items-center gap-2 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                Connected. You can take UPI, PhonePe, Google Pay, cards and more.
              </div>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  {razorpay?.connected
                    ? 'Finish your KYC on Razorpay to start taking payments, then Refresh status.'
                    : 'Connect Razorpay to take UPI (PhonePe, Google Pay, Paytm), cards, netbanking and wallets.'}
                </p>
                {can('OWNER') && !razorpay?.connected && (
                  <Button onClick={() => connectRazorpay.mutate()} disabled={connectRazorpay.isPending}>
                    {connectRazorpay.isPending ? 'Connecting…' : 'Connect Razorpay'}
                  </Button>
                )}
                {razorpay?.connected && (
                  <Button
                    variant="outline"
                    onClick={() => queryClient.invalidateQueries({ queryKey: ['razorpay'] })}
                  >
                    Refresh status
                  </Button>
                )}
              </>
            )
          ) : loadingStripe ? (
            <Skeleton className="h-10 w-full" />
          ) : stripe?.chargesEnabled ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                Connected. You can take payments
                {stripe.payoutsEnabled ? ' and receive payouts.' : ', but payouts are still pending.'}
              </div>
              {/* Connected is not finished: banks change, cards expire. Stripe's own
                  Express dashboard is where all of that lives; we just mint the door. */}
              {can('MANAGER') && (
                <Button
                  variant="outline"
                  onClick={() => manageStripe.mutate()}
                  disabled={manageStripe.isPending}
                >
                  {manageStripe.isPending ? 'Opening…' : 'Manage payouts & details'}
                  <ExternalLink className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {stripe?.connected
                  ? 'Stripe still needs some details from you before you can take payments.'
                  : 'Connect Stripe to start taking orders.'}
              </p>

              {stripe?.requirementsDue && stripe.requirementsDue.length > 0 && (
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {stripe.requirementsDue.slice(0, 5).map((req) => (
                    <li key={req}>· {req.replace(/[._]/g, ' ')}</li>
                  ))}
                </ul>
              )}

              {can('OWNER') && (
                <Button onClick={() => connectStripe.mutate()} disabled={connectStripe.isPending}>
                  {connectStripe.isPending
                    ? 'Opening Stripe…'
                    : stripe?.connected
                      ? 'Finish Stripe setup'
                      : 'Connect Stripe'}
                </Button>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Logo + brand colour. The upload endpoint existed from day one with
          nothing calling it, so every restaurant was logo-less while the setup
          checklist told them to add one. */}
      <BrandingEditor />

      {/* The one part of their site they write themselves. Everything else on the
          storefront is generated from data they already keep current — but nobody can
          generate "we've ground the beef ourselves since 1998". */}
      <AboutEditor />

      {/* Social profiles — a row of brand icons in the storefront footer. */}
      <SocialLinksEditor />

      {/*
        Opening hours. Load-bearing, not cosmetic: isOpenAt() gates whether the
        storefront will accept an ASAP order at all, so until this existed every
        restaurant was silently stuck on the seeded 11:00-22:00 default.
      */}
      <HoursEditor
        initialHours={restaurant.businessHours as BusinessHours}
        timezone={restaurant.timezone}
      />

      <DeliverySettings />
    </div>
  );
}

function DeliverySettings() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { restaurant, can, hasFeature } = useDashboard();

  const [form, setForm] = useState({
    pickupEnabled: restaurant?.pickupEnabled ?? true,
    deliveryEnabled: restaurant?.deliveryEnabled ?? false,
    dineInEnabled: restaurant?.dineInEnabled ?? false,
    scheduledOrdersEnabled: restaurant?.scheduledOrdersEnabled ?? false,
    uberDirectEnabled: restaurant?.uberDirectEnabled ?? false,
    doorDashEnabled: restaurant?.doorDashEnabled ?? false,
    selfDeliveryEnabled: restaurant?.selfDeliveryEnabled ?? false,
    porterEnabled: restaurant?.porterEnabled ?? false,
    deliveryFeeCents: restaurant?.deliveryFeeCents ?? 499,
    deliveryRadiusMeters: restaurant?.deliveryRadiusMeters ?? 8000,
    minOrderCents: restaurant?.minOrderCents ?? 0,
    serviceFeeCents: restaurant?.serviceFeeCents ?? 0,
    // taxRateBps is deliberately NOT here. It is derived from the tax components in
    // BusinessLocationForm, and if this form still carried it, saving "prep time" would
    // POST a stale rate and silently overwrite the itemised tax the owner just set.
    prepTimeMinutes: restaurant?.prepTimeMinutes ?? 20,
  });

  const save = useMutation({
    mutationFn: () => api.updateDeliverySettings(form),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.success('Settings saved');
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not save'),
  });

  if (!restaurant) return null;
  const readOnly = !can('MANAGER');
  // Courier delivery is a paid capability. Pickup and dine-in stay on every plan.
  const deliveryLocked = !hasFeature('DELIVERY');
  // India uses Porter for auto-dispatch; Uber Direct / DoorDash Drive don't operate
  // there, so those toggles are hidden and Porter is shown instead.
  const isIndia = usesRazorpay(restaurant.country);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Fulfillment &amp; fees</CardTitle>
        <CardDescription>How customers get their food, and what it costs them.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-3">
          <Toggle
            label="Pickup"
            hint="Customers collect from you"
            checked={form.pickupEnabled}
            onChange={(pickupEnabled) => setForm({ ...form, pickupEnabled })}
            disabled={readOnly}
          />
          <Toggle
            label="Delivery"
            hint={deliveryLocked ? 'Available on Growth — upgrade to enable' : 'You or a courier deliver'}
            checked={form.deliveryEnabled && !deliveryLocked}
            onChange={(deliveryEnabled) => setForm({ ...form, deliveryEnabled })}
            disabled={readOnly || deliveryLocked}
            locked={deliveryLocked}
          />
          <Toggle
            label="Dine in"
            hint="Table ordering via QR codes"
            checked={form.dineInEnabled}
            onChange={(dineInEnabled) => setForm({ ...form, dineInEnabled })}
            disabled={readOnly}
          />
          <Toggle
            label="Scheduled orders"
            hint="Customers can order ahead for a later time"
            checked={form.scheduledOrdersEnabled}
            onChange={(scheduledOrdersEnabled) => setForm({ ...form, scheduledOrdersEnabled })}
            disabled={readOnly}
          />
          {!isIndia && (
            <>
              <Toggle
                label="Uber Direct"
                hint="Dispatch an Uber courier when an order is marked ready"
                checked={form.uberDirectEnabled && !deliveryLocked}
                onChange={(uberDirectEnabled) => setForm({ ...form, uberDirectEnabled })}
                // Dispatching a courier for a restaurant that doesn't do delivery is
                // nonsense, so the toggle is only meaningful once delivery is on — and
                // delivery itself needs a plan that includes it.
                disabled={readOnly || !form.deliveryEnabled || deliveryLocked}
              />
              <Toggle
                label="DoorDash Drive"
                hint="Dispatch a DoorDash courier when an order is marked ready"
                checked={form.doorDashEnabled && !deliveryLocked}
                onChange={(doorDashEnabled) => setForm({ ...form, doorDashEnabled })}
                disabled={readOnly || !form.deliveryEnabled || deliveryLocked}
              />
            </>
          )}
          {isIndia && (
            <Toggle
              label="Porter"
              hint="Dispatch a Porter courier when an order is marked ready (India)"
              checked={form.porterEnabled && !deliveryLocked}
              onChange={(porterEnabled) => setForm({ ...form, porterEnabled })}
              disabled={readOnly || !form.deliveryEnabled || deliveryLocked}
            />
          )}
          <Toggle
            label="We have our own driver"
            hint="Deliver it yourself instead of paying for a courier"
            checked={form.selfDeliveryEnabled && !deliveryLocked}
            onChange={(selfDeliveryEnabled) => setForm({ ...form, selfDeliveryEnabled })}
            disabled={readOnly || !form.deliveryEnabled || deliveryLocked}
          />

          {/* Two couriers is not twice the setup — it is a running auction on every
              order, and the saving is real money. Say so, because a restaurant looking
              at two toggles has no reason to guess that turning both on is strictly
              better than either alone. */}
          {form.uberDirectEnabled && form.doorDashEnabled && (
            <p className="rounded-lg bg-emerald-50 p-3 text-xs text-emerald-900">
              Both couriers are on. We price every delivery with each of them and send the cheaper
              one — and if one is having a bad day, the other still collects the order.
            </p>
          )}

          {/* Both on = a real decision per order, and we tell them so rather than
              letting them discover it at the pass. */}
          {form.uberDirectEnabled && form.selfDeliveryEnabled && (
            <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
              You have both. When an order is ready, your staff choose who takes it — Uber, or your
              own driver. We won&apos;t guess, because the right answer depends on distance and who
              is on shift.
            </p>
          )}
        </div>

        <div className="grid gap-4 border-t pt-5 sm:grid-cols-2">
          <MoneyField
            label="Delivery fee"
            hint="What the customer pays you"
            cents={form.deliveryFeeCents}
            onChange={(deliveryFeeCents) => setForm({ ...form, deliveryFeeCents })}
            disabled={readOnly}
          />
          <MoneyField
            label="Service fee"
            hint="Added to every order"
            cents={form.serviceFeeCents}
            onChange={(serviceFeeCents) => setForm({ ...form, serviceFeeCents })}
            disabled={readOnly}
          />
          <MoneyField
            label="Minimum order"
            hint="Below this, customers cannot check out"
            cents={form.minOrderCents}
            onChange={(minOrderCents) => setForm({ ...form, minOrderCents })}
            disabled={readOnly}
          />

          {/*
            Tax used to be a single percentage box RIGHT HERE, which is why it is worth
            a note that it is now gone rather than moved by accident.

            One box cannot express how tax actually works: Quebec charges GST 5% + QST
            9.975% as two separately-named lines, and India charges CGST + SGST. Both
            legally require the components to be itemised on the receipt. And a rate
            entered here in isolation had no idea which jurisdiction it belonged to.

            So tax now lives with the ADDRESS, in BusinessLocationForm, where the
            jurisdiction that determines it lives — pre-filled from the country and
            region, itemised, and confirmed. Two places to set tax is one place to set it
            wrong.
          */}

          <div className="space-y-2">
            <Label htmlFor="prep">Prep time (minutes)</Label>
            <Input
              id="prep"
              type="number"
              min="1"
              max="180"
              value={form.prepTimeMinutes}
              onChange={(e) =>
                setForm({ ...form, prepTimeMinutes: Math.max(1, Number(e.target.value)) })
              }
              disabled={readOnly}
            />
            <p className="text-xs text-muted-foreground">
              What we tell customers, and when we ask Uber to collect.
            </p>
          </div>
        </div>

        {!readOnly && (
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save settings'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
  locked,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  /** Plan-locked (not just role-disabled): dims the row and shows a lock. */
  locked?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between gap-4 rounded-lg border p-3 ${locked ? 'opacity-70' : ''}`}>
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          {label}
          {locked && <Lock className="h-3 w-3 text-muted-foreground" aria-label="Upgrade to unlock" />}
        </p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

function MoneyField({
  label,
  hint,
  cents,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  cents: number;
  onChange: (cents: number) => void;
  disabled?: boolean;
}) {
  const id = label.toLowerCase().replace(/\s+/g, '-');
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        step="0.01"
        min="0"
        value={(cents / 100).toFixed(2)}
        onChange={(e) => onChange(Math.round(parseFloat(e.target.value || '0') * 100))}
        disabled={disabled}
      />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
