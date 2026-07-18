'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CalendarDays, Loader2, PartyPopper, Users, UtensilsCrossed } from 'lucide-react';
import { toast } from 'sonner';
import { formatMoney } from '@dinedirect/shared';
import { storefrontApi, ApiRequestError, type CateringPackage } from '@/lib/api';
import { useTenant, useTenantHref } from '@/components/storefront/tenant-provider';
import { useT } from '@/components/storefront/i18n-provider';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Label,
} from '@/components/ui/primitives';

/** Today as YYYY-MM-DD, for the date input's min. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function StorefrontCateringPage() {
  const restaurant = useTenant();
  const href = useTenantHref();
  const t = useT();
  const params = useSearchParams();
  const [form, setForm] = useState<{ mode: 'custom' | CateringPackage } | null>(null);

  // Stripe drops the customer back here after paying (or cancelling).
  useEffect(() => {
    if (params.get('paid') === '1') {
      toast.success('Payment received — your catering is confirmed. We’ll be in touch with details.');
      window.history.replaceState(null, '', window.location.pathname);
    } else if (params.get('cancelled') === '1') {
      toast('Payment cancelled — nothing was charged.');
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, [params]);

  const { data: offering, isLoading } = useQuery({
    queryKey: ['catering', restaurant.slug],
    queryFn: () => storefrontApi.getCatering(restaurant.slug),
  });

  if (!restaurant.cateringEnabled) {
    return (
      <div className="mx-auto max-w-lg px-4 py-24 text-center">
        <p className="text-lg font-semibold">Catering isn’t available here</p>
        <Button asChild variant="outline" className="mt-4">
          <a href={href('/menu')}>Back to the menu</a>
        </Button>
      </div>
    );
  }

  const packages = offering?.packages ?? [];

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <header className="text-center">
        <span className="inline-flex items-center gap-2 rounded-full bg-brand-subtle px-3 py-1 text-xs font-semibold uppercase tracking-widest text-brand">
          <PartyPopper className="h-3.5 w-3.5" />
          {t.catering.eyebrow}
        </span>
        <h1 className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">{t.catering.heading}</h1>
        <p className="mx-auto mt-3 max-w-xl text-muted-foreground">{t.catering.intro}</p>
      </header>

      {/* Packages */}
      {isLoading ? (
        <div className="mt-10 grid gap-5 sm:grid-cols-2">
          <div className="h-56 animate-pulse rounded-2xl bg-muted" />
          <div className="h-56 animate-pulse rounded-2xl bg-muted" />
        </div>
      ) : packages.length > 0 ? (
        <div className="mt-10 grid gap-5 sm:grid-cols-2">
          {packages.map((pkg) => (
            <div key={pkg.id} className="flex flex-col rounded-2xl border bg-card p-6 shadow-soft">
              <h3 className="text-lg font-bold">{pkg.name}</h3>
              {pkg.description && (
                <p className="mt-1.5 flex-1 whitespace-pre-line text-sm text-muted-foreground">
                  {pkg.description}
                </p>
              )}
              <div className="mt-4 flex items-end justify-between">
                <div>
                  <p className="text-2xl font-black tracking-tight">
                    {formatMoney(pkg.pricePerPersonCents, restaurant.currency)}
                    <span className="text-sm font-medium text-muted-foreground"> {t.catering.perPerson}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t.catering.minimum} {pkg.minPeople} {t.catering.people}
                    {pkg.maxPeople ? ` · ${t.catering.upTo} ${pkg.maxPeople}` : ''}
                  </p>
                </div>
                <Button variant="brand" onClick={() => setForm({ mode: pkg })}>
                  {t.catering.orderThis}
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {/* Custom */}
      <div className="mt-8 flex flex-col items-center gap-3 rounded-2xl border border-dashed p-8 text-center">
        <UtensilsCrossed className="h-7 w-7 text-brand" />
        <h3 className="text-lg font-semibold">{t.catering.customTitle}</h3>
        <p className="max-w-md text-sm text-muted-foreground">{t.catering.customIntro}</p>
        <Button variant="outline" onClick={() => setForm({ mode: 'custom' })}>
          {t.catering.requestCustom}
        </Button>
      </div>

      <div className="mt-8 text-center">
        <Button asChild variant="ghost">
          <a href={href('/menu')}>{t.catering.backToMenu}</a>
        </Button>
      </div>

      {form && (
        <CateringForm
          slug={restaurant.slug}
          currency={restaurant.currency}
          pkg={form.mode === 'custom' ? null : form.mode}
          onClose={() => setForm(null)}
        />
      )}
    </div>
  );
}

function CateringForm({
  slug,
  currency,
  pkg,
  onClose,
}: {
  slug: string;
  currency: string;
  pkg: CateringPackage | null;
  onClose: () => void;
}) {
  const t = useT();
  const [headCount, setHeadCount] = useState(String(pkg?.minPeople ?? 20));
  const [eventDate, setEventDate] = useState('');
  const [fulfillment, setFulfillment] = useState<'PICKUP' | 'DELIVERY'>('PICKUP');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState('');

  const people = Math.max(0, Math.round(Number(headCount) || 0));
  const total = pkg ? pkg.pricePerPersonCents * people : 0;

  const submit = useMutation({
    mutationFn: () =>
      storefrontApi.submitCatering(slug, {
        type: pkg ? 'PACKAGE' : 'CUSTOM',
        packageId: pkg?.id,
        customerName: name.trim(),
        customerEmail: email.trim(),
        customerPhone: phone.trim(),
        headCount: people,
        eventDate,
        fulfillment,
        deliveryAddress: fulfillment === 'DELIVERY' ? deliveryAddress.trim() : undefined,
        message: message.trim() || undefined,
      }),
    onSuccess: ({ checkoutUrl }) => {
      if (checkoutUrl) {
        window.location.href = checkoutUrl; // off to pay
        return;
      }
      onClose();
      toast.success(
        pkg
          ? 'Request received — the restaurant will contact you to arrange payment.'
          : 'Request sent — the restaurant will be in touch soon.',
      );
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not send your request'),
  });

  const valid =
    name.trim() &&
    email.trim() &&
    phone.trim().length >= 7 &&
    people >= (pkg?.minPeople ?? 1) &&
    eventDate &&
    (fulfillment !== 'DELIVERY' || deliveryAddress.trim());

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{pkg ? pkg.name : t.catering.customTitle}</DialogTitle>
          <DialogDescription>
            {pkg
              ? `${formatMoney(pkg.pricePerPersonCents, currency)} ${t.catering.perPerson} · ${t.catering.minimum} ${pkg.minPeople}`
              : t.catering.customIntro}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="cf-people">{t.catering.numberOfPeople}</Label>
              <Input
                id="cf-people"
                type="number"
                min={pkg?.minPeople ?? 1}
                value={headCount}
                onChange={(e) => setHeadCount(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cf-date">{t.catering.eventDate}</Label>
              <Input
                id="cf-date"
                type="date"
                min={todayIso()}
                value={eventDate}
                onChange={(e) => setEventDate(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cf-fulfil">{t.catering.pickupOrDelivery}</Label>
            <Select
              id="cf-fulfil"
              value={fulfillment}
              onChange={(e) => setFulfillment(e.target.value as 'PICKUP' | 'DELIVERY')}
            >
              <option value="PICKUP">{t.common.pickup}</option>
              <option value="DELIVERY">{t.common.delivery}</option>
            </Select>
          </div>

          {fulfillment === 'DELIVERY' && (
            <div className="space-y-1.5">
              <Label htmlFor="cf-address">{t.catering.deliveryAddress}</Label>
              <Textarea
                id="cf-address"
                value={deliveryAddress}
                onChange={(e) => setDeliveryAddress(e.target.value)}
                placeholder="Street, unit, city, postcode"
                className="min-h-[52px]"
              />
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="cf-name">{t.catering.yourName}</Label>
              <Input id="cf-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cf-phone">{t.catering.phone}</Label>
              <Input id="cf-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cf-email">{t.catering.email}</Label>
            <Input id="cf-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cf-msg">{pkg ? t.catering.notesOptional : t.catering.tellUsEvent}</Label>
            <Textarea
              id="cf-msg"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={
                pkg ? 'Timing, dietary needs, anything else.' : 'Menu ideas, headcount, dietary needs, timing…'
              }
              className="min-h-[70px]"
            />
          </div>

          {pkg && (
            <div className="flex items-center justify-between rounded-xl bg-muted/50 px-4 py-3">
              <span className="text-sm text-muted-foreground">
                {people} × {formatMoney(pkg.pricePerPersonCents, currency)}
              </span>
              <span className="text-lg font-bold tabular-nums">{formatMoney(total, currency)}</span>
            </div>
          )}

          <Button
            variant="brand"
            className="w-full"
            disabled={!valid || submit.isPending}
            onClick={() => submit.mutate()}
          >
            {submit.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : pkg ? (
              `${t.catering.pay} ${formatMoney(total, currency)}`
            ) : (
              t.catering.sendRequest
            )}
          </Button>
          {pkg && (
            <p className="text-center text-xs text-muted-foreground">{t.catering.afterPaying}</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
