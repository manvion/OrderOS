'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Check } from 'lucide-react';
import {
  currencyForCountry,
  formatMoney,
  getPlan,
  planPricingTable,
  type BillingInterval,
  type PlanTier,
} from '@dinedirect/shared';
import { Button } from '@/components/ui/button';

/**
 * The pricing table on the marketing page.
 *
 * Prices are computed HERE, from the same shared table the API bills from
 * (packages/shared/src/plans.ts), so the number on this page is the number a
 * restaurant is charged — no separate marketing copy of the prices to drift. The
 * currency is chosen automatically: the server resolves it from the visitor's
 * geo-IP country, and this falls back to the browser locale only when it couldn't.
 * There is no manual switcher — a prospect sees their own market's price, and a
 * signed-in restaurant is always billed in its own country's currency anyway.
 */

/**
 * Best-effort currency from the visitor's own browser locale — the fallback when
 * the server didn't hand us a geo-IP country. `currencyForCountry` (shared) does the
 * country -> currency mapping so this and the server agree.
 */
function guessCurrency(): string {
  if (typeof navigator === 'undefined') return 'USD';
  try {
    const region = new Intl.Locale(navigator.language).maximize().region ?? '';
    return currencyForCountry(region);
  } catch {
    return 'USD';
  }
}

const CURRENCY_LABEL: Record<string, string> = {
  USD: 'USD $',
  CAD: 'CAD $',
  GBP: 'GBP £',
  EUR: 'EUR €',
  AUD: 'AUD $',
  NZD: 'NZD $',
  SGD: 'SGD $',
  AED: 'AED',
  INR: 'INR ₹',
};

const HIGHLIGHT_TIER: PlanTier = 'GROWTH';

export function PricingSection({ initialCurrency }: { initialCurrency?: string }) {
  // Currency is automatic: the SERVER's geo-IP resolution first, else a browser-locale
  // guess. No manual switcher — it's read, never set.
  const [currency] = useState<string>(() => initialCurrency || guessCurrency());
  const [interval, setInterval] = useState<BillingInterval>('MONTHLY');

  const tiers = useMemo(() => planPricingTable(currency), [currency]);

  return (
    <section id="pricing" className="border-y bg-background py-20 lg:py-28">
      <div className="container">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold uppercase tracking-widest text-brand">Pricing</p>
          <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
            Start free. Grow into it.
          </h2>
          <p className="mt-4 text-muted-foreground">
            One flat plan for the software, and the lowest per-order fee in the business — all the
            way down to 0% on Pro. Prices in {CURRENCY_LABEL[currency] ?? currency}, billed{' '}
            {interval === 'ANNUAL' ? 'yearly' : 'monthly'}.
          </p>
        </div>

        {/* Controls: billing interval + currency. */}
        <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <div className="inline-flex rounded-full border bg-muted/40 p-1 text-sm font-semibold">
            <button
              type="button"
              onClick={() => setInterval('MONTHLY')}
              className={`rounded-full px-4 py-1.5 transition-colors ${
                interval === 'MONTHLY' ? 'bg-background shadow-soft' : 'text-muted-foreground'
              }`}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => setInterval('ANNUAL')}
              className={`rounded-full px-4 py-1.5 transition-colors ${
                interval === 'ANNUAL' ? 'bg-background shadow-soft' : 'text-muted-foreground'
              }`}
            >
              Annual
              <span className="ml-1.5 rounded-full bg-brand px-1.5 py-0.5 text-xs text-brand-foreground">
                2 months free
              </span>
            </button>
          </div>

          {/* Currency is auto-detected from the visitor's location — shown, not chosen. */}
          <span className="text-sm text-muted-foreground">
            Prices in{' '}
            <span className="font-medium text-foreground">{CURRENCY_LABEL[currency] ?? currency}</span>
          </span>
        </div>

        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {tiers.map((price) => {
            const plan = getPlan(price.tier);
            const highlighted = price.tier === HIGHLIGHT_TIER;
            const isFree = price.monthlyMinor === 0;
            const perMonthMinor =
              interval === 'ANNUAL' ? price.annualPerMonthMinor : price.monthlyMinor;

            return (
              <div
                key={price.tier}
                className={`relative flex flex-col rounded-3xl border p-7 ${
                  highlighted
                    ? 'border-brand bg-brand-subtle shadow-floating lg:-my-2'
                    : 'bg-card shadow-soft'
                }`}
              >
                {highlighted && (
                  <span className="absolute -top-3 left-7 rounded-full bg-brand px-3 py-1 text-xs font-bold uppercase tracking-wide text-brand-foreground">
                    Most popular
                  </span>
                )}

                <h3 className="text-lg font-bold">{plan.name}</h3>
                <p className="mt-1 min-h-[2.5rem] text-sm text-muted-foreground">{plan.tagline}</p>

                <div className="mt-5 flex items-baseline gap-1">
                  <span className="text-4xl font-black tracking-tight tabular-nums">
                    {isFree ? formatMoney(0, currency) : formatMoney(perMonthMinor, currency)}
                  </span>
                  <span className="text-sm font-medium text-muted-foreground">
                    {isFree ? 'forever' : '/mo'}
                  </span>
                </div>
                <p className="mt-1 h-5 text-xs text-muted-foreground">
                  {isFree
                    ? `+ ${(plan.commissionBps / 100).toFixed(plan.commissionBps % 100 ? 2 : 0)}% per order`
                    : interval === 'ANNUAL'
                      ? `${formatMoney(price.annualMinor, currency)} billed yearly · ${(plan.commissionBps / 100).toFixed(plan.commissionBps % 100 ? 2 : 0)}% per order`
                      : `+ ${(plan.commissionBps / 100).toFixed(plan.commissionBps % 100 ? 2 : 0)}% per order`}
                </p>

                <Button
                  asChild
                  variant={highlighted ? 'brand' : 'outline'}
                  className="mt-6 w-full"
                >
                  <Link href={`/sign-up?plan=${price.tier}`}>
                    {isFree ? 'Start free' : `Choose ${plan.name}`}
                  </Link>
                </Button>

                <ul className="mt-7 space-y-3 text-sm">
                  {plan.highlights.map((h) => (
                    <li key={h} className="flex items-start gap-2.5">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                      <span className={h.endsWith(':') ? 'font-semibold' : 'text-muted-foreground'}>
                        {h}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>

        <p className="mt-8 text-center text-sm text-muted-foreground">
          Every plan includes QR ordering, the kitchen board, and secure card payments. Cancel or
          switch anytime.
        </p>
      </div>
    </section>
  );
}
