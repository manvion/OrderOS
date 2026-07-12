'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { useMutation } from '@tanstack/react-query';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { ApiRequestError, createDashboardApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { Label } from '@/components/ui/primitives';

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
];

/**
 * Onboard a restaurant for someone, on a phone call.
 *
 * The first fifty restaurants on any platform are set up by a human, not by a
 * signup form. This is that.
 *
 * The one thing it deliberately does NOT do is create their account. We create the
 * restaurant and email the owner an invitation; they set their own password and
 * claim it. An account whose password we chose is an account we can silently log in
 * as — and "the platform can become me without my knowledge" is not something a
 * business owner should ever have to accept from a company holding their revenue.
 */
export function AdminNewRestaurant() {
  const { getToken } = useAuth();
  const router = useRouter();
  const api = createDashboardApi(getToken);

  const [form, setForm] = useState({
    name: '',
    slug: '',
    ownerEmail: '',
    email: '',
    phone: '',
    street: '',
    city: '',
    state: '',
    postalCode: '',
    country: 'US',
    timezone: 'America/New_York',
    currency: 'USD',
    feePercent: '0',
  });

  const create = useMutation({
    mutationFn: () =>
      api.adminCreateRestaurant({
        name: form.name,
        slug: form.slug,
        ownerEmail: form.ownerEmail,
        email: form.email,
        phone: form.phone,
        address: {
          street: form.street,
          city: form.city,
          state: form.state,
          postalCode: form.postalCode,
          country: form.country,
        },
        timezone: form.timezone,
        currency: form.currency,
        platformFeeBps: Math.round(parseFloat(form.feePercent || '0') * 100),
      }),
    onSuccess: () => {
      toast.success(
        `Created. We've emailed ${form.ownerEmail} an invitation to claim it — they set their own password.`,
        { duration: 10_000 },
      );
      router.push('/admin');
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not create'),
  });

  const set = (k: keyof typeof form, v: string) => setForm({ ...form, [k]: v });

  const canSubmit =
    form.name.length > 1 &&
    form.slug.length > 2 &&
    form.ownerEmail.includes('@') &&
    form.email.includes('@') &&
    form.phone.length > 6 &&
    form.street.length > 2 &&
    form.city.length > 1;

  return (
    <div className="min-h-screen bg-muted/30">
      <div className="mx-auto max-w-2xl space-y-6 p-6">
        <Button variant="ghost" size="sm" onClick={() => router.push('/admin')}>
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Button>

        <div>
          <h1 className="text-2xl font-bold tracking-tight">Onboard a restaurant</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            We create the restaurant. The owner gets an invitation and claims it with their own
            password — we never see it.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">The restaurant</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name">
                <Input value={form.name} onChange={(e) => set('name', e.target.value)} />
              </Field>
              <Field label="Web address" hint={`${form.slug || 'name'}.orderos.ai`}>
                <Input
                  value={form.slug}
                  onChange={(e) => set('slug', e.target.value.toLowerCase())}
                  placeholder="joesburgers"
                />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Public phone">
                <Input value={form.phone} onChange={(e) => set('phone', e.target.value)} />
              </Field>
              <Field label="Public email">
                <Input
                  type="email"
                  value={form.email}
                  onChange={(e) => set('email', e.target.value)}
                />
              </Field>
            </div>

            <Field label="Street">
              <Input value={form.street} onChange={(e) => set('street', e.target.value)} />
            </Field>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="City">
                <Input value={form.city} onChange={(e) => set('city', e.target.value)} />
              </Field>
              <Field label="State">
                <Input value={form.state} onChange={(e) => set('state', e.target.value)} />
              </Field>
              <Field label="Postal code">
                <Input
                  value={form.postalCode}
                  onChange={(e) => set('postalCode', e.target.value)}
                />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Timezone">
                <Select value={form.timezone} onChange={(e) => set('timezone', e.target.value)}>
                  {TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz.replace(/_/g, ' ')}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Currency">
                <Select value={form.currency} onChange={(e) => set('currency', e.target.value)}>
                  <option value="USD">USD</option>
                  <option value="GBP">GBP</option>
                  <option value="EUR">EUR</option>
                </Select>
              </Field>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">The deal</CardTitle>
            <CardDescription>
              Who owns it, and what we charge. Both are negotiated per restaurant.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field
              label="Owner's email"
              hint="They get the invitation and set their own password. We never create their account."
            >
              <Input
                type="email"
                value={form.ownerEmail}
                onChange={(e) => set('ownerEmail', e.target.value)}
                placeholder="owner@joesburgers.com"
              />
            </Field>

            <Field
              label="Our commission (%)"
              hint="Taken as a Stripe application fee on every order. 0 = free."
            >
              <Input
                type="number"
                step="0.25"
                min="0"
                max="30"
                value={form.feePercent}
                onChange={(e) => set('feePercent', e.target.value)}
                className="w-32"
              />
            </Field>
          </CardContent>
        </Card>

        <Button
          size="lg"
          className="w-full"
          disabled={!canSubmit || create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Creating…
            </>
          ) : (
            'Create and invite the owner'
          )}
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
