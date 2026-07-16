'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Check } from 'lucide-react';
import {
  currencyForCountry,
  formatMoney,
  getPlan,
  planPricingTable,
  supportedPlanCurrencies,
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
 * currency is guessed from the visitor's locale and then theirs to change, because
 * "your website, your margin" lands very differently at $39 than at ₹1,499.
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
  // Prefer the currency the SERVER resolved from the visitor's geo-IP; fall back to
  // a browser-locale guess only when it didn't (e.g. self-hosted without geo headers).
  const [currency, setCurrency] = useState<string>(() => initialCurrency || guessCurrency());
  const [interval, setInterval] = useState<BillingInterval>('MONTHLY');

  const tiers = useMemo(() => planPricingTable(currency), [currency]);
  const currencies = supportedPlanCurrencies();

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

          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Currency
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="rounded-lg border bg-background px-3 py-1.5 text-sm font-medium text-foreground"
            >
              {currencies.map((c) => (
                <option key={c} value={c}>
                  {CURRENCY_LABEL[c] ?? c}
                </option>
              ))}
            </select>
          </label>
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
