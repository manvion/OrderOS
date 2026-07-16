'use client';

import { useState } from 'react';
import { CalendarCheck, CheckCircle2, Loader2, Palette, Rocket } from 'lucide-react';
import { ApiRequestError, submitDemoRequest } from '@/lib/api';
import { Button } from '@/components/ui/button';

/**
 * The done-for-you / "book a demo" section.
 *
 * The self-serve flow is the product, but some owners want a human to walk them
 * through it and to BUILD the site for them — logo, photos, menu — for a one-time
 * setup fee. This captures that lead; the platform team follows up from the admin
 * panel. Nothing here charges a card: the setup fee is quoted and collected during
 * that conversation, so an owner never pays before they've seen their site.
 */
const STEPS = [
  {
    icon: CalendarCheck,
    title: 'Book a free demo call',
    body: 'Walk through the platform with our team and see exactly what your site could look like.',
  },
  {
    icon: Palette,
    title: 'We build your site & menu',
    body: 'Send us your logo, photos and menu. We build your branded ordering site in 48–72 hours (one-time setup fee).',
  },
  {
    icon: Rocket,
    title: 'Start taking orders',
    body: 'Share your link everywhere. Orders go straight to your kitchen — and the money to your bank.',
  },
];

export function DemoSection() {
  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    restaurantName: '',
    city: '',
    message: '',
  });
  const [status, setStatus] = useState<'idle' | 'sending' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const canSubmit = form.name.trim().length > 1 && form.email.includes('@') && status !== 'sending';

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setStatus('sending');
    setError(null);
    try {
      await submitDemoRequest({
        name: form.name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim() || undefined,
        restaurantName: form.restaurantName.trim() || undefined,
        city: form.city.trim() || undefined,
        message: form.message.trim() || undefined,
        interest: 'concierge',
      });
      setStatus('done');
    } catch (err) {
      setStatus('idle');
      setError(err instanceof ApiRequestError ? err.body.message : 'Something went wrong. Try again.');
    }
  }

  return (
    <section id="demo" className="border-y bg-foreground py-20 text-background lg:py-24">
      <div className="container grid gap-12 lg:grid-cols-2 lg:items-center lg:gap-16">
        {/* Left: the offer. */}
        <div>
          <p className="text-sm font-semibold uppercase tracking-widest text-brand">
            Prefer we set it up?
          </p>
          <h2 className="mt-2 max-w-lg text-3xl font-bold tracking-tight sm:text-4xl">
            We’ll build your ordering site for you.
          </h2>
          <p className="mt-4 max-w-md text-background/70">
            Book a free walkthrough. If you’d rather not lift a finger, send us your logo, photos
            and menu and we’ll have your branded site live in a couple of days.
          </p>

          <div className="mt-8 space-y-5">
            {STEPS.map((s, i) => (
              <div key={s.title} className="flex items-start gap-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand/15 text-brand">
                  <s.icon className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-bold">
                    <span className="text-brand">{i + 1}.</span> {s.title}
                  </h3>
                  <p className="mt-1 text-sm text-background/70">{s.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right: the form (or a thank-you once sent). */}
        <div className="rounded-3xl border border-white/10 bg-white/5 p-6 sm:p-8">
          {status === 'done' ? (
            <div className="flex flex-col items-center gap-4 py-10 text-center">
              <CheckCircle2 className="h-12 w-12 text-brand" />
              <h3 className="text-xl font-bold">You’re on the list.</h3>
              <p className="max-w-xs text-sm text-background/70">
                Thanks{form.name ? `, ${form.name.split(' ')[0]}` : ''}! Our team will reach out
                shortly to book your walkthrough.
              </p>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4">
              <h3 className="text-lg font-bold">Book your demo</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <Input label="Your name" value={form.name} onChange={(v) => set('name', v)} required />
                <Input label="Email" type="email" value={form.email} onChange={(v) => set('email', v)} required />
                <Input label="Phone" value={form.phone} onChange={(v) => set('phone', v)} />
                <Input label="Restaurant name" value={form.restaurantName} onChange={(v) => set('restaurantName', v)} />
              </div>
              <Input label="City" value={form.city} onChange={(v) => set('city', v)} />
              <div>
                <label className="mb-1.5 block text-sm font-medium text-background/80">
                  Anything we should know? <span className="text-background/40">(optional)</span>
                </label>
                <textarea
                  value={form.message}
                  onChange={(e) => set('message', e.target.value)}
                  rows={3}
                  className="w-full rounded-lg border border-white/15 bg-white/10 px-3 py-2 text-sm text-background placeholder:text-background/40 focus:border-brand focus:outline-none"
                  placeholder="Cuisine, delivery, current setup…"
                />
              </div>

              {error && <p className="text-sm text-red-300">{error}</p>}

              <Button type="submit" variant="brand" size="lg" className="w-full" disabled={!canSubmit}>
                {status === 'sending' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Book my demo
              </Button>
              <p className="text-center text-xs text-background/50">
                No card required. We’ll quote the one-time setup fee on the call.
              </p>
            </form>
          )}
        </div>
      </div>
    </section>
  );
}

function Input({
  label,
  value,
  onChange,
  type = 'text',
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-background/80">
        {label} {required && <span className="text-brand">*</span>}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        className="w-full rounded-lg border border-white/15 bg-white/10 px-3 py-2 text-sm text-background placeholder:text-background/40 focus:border-brand focus:outline-none"
      />
    </div>
  );
}
