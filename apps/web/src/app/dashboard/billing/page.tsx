'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CreditCard, Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { formatMoney, type BillingInterval, type PlanTier } from '@dinedirect/shared';
import { useApi, useDashboard, useRequireRole } from '@/components/dashboard/dashboard-provider';
import { ApiRequestError, type PlanTierOption } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, Skeleton } from '@/components/ui/primitives';

const TIER_RANK: Record<PlanTier, number> = { STARTER: 0, GROWTH: 1, PRO: 2 };
const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Active',
  TRIALING: 'Trial',
  PAST_DUE: 'Payment failed',
  CANCELED: 'Canceled',
};

/**
 * The restaurant's own billing page: what plan they're on, what it costs, and the
 * one button that changes it. Everything here is priced in the restaurant's
 * currency by the server (SubscriptionsService.getPlanState), so an owner in Mumbai
 * sees rupees without this page knowing a thing about FX.
 */
export default function BillingPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { restaurant } = useDashboard();
  useRequireRole('OWNER', '/dashboard');

  const params = useSearchParams();
  const [interval, setInterval] = useState<BillingInterval>('MONTHLY');

  const { data: plan, isLoading } = useQuery({
    queryKey: ['subscriptions', 'plan', restaurant?.id],
    queryFn: () => api.getPlanState(),
    enabled: Boolean(restaurant),
  });

  // Stripe drops the owner back here after checkout. Rather than wait on the webhook
  // (which can lag a few seconds, or be misconfigured), reconcile the session
  // directly so the plan flips immediately. Runs once, in an effect, then scrubs the
  // query params so a refresh is quiet.
  const checkout = params.get('checkout');
  const sessionId = params.get('session_id');
  useEffect(() => {
    if (checkout === 'success') {
      const finish = async () => {
        try {
          if (sessionId) await api.reconcilePlanCheckout(sessionId);
        } catch {
          // Non-fatal: the webhook is the backstop. We still refetch below.
        }
        await queryClient.invalidateQueries({ queryKey: ['subscriptions', 'plan'] });
        toast.success('You’re all set — your new plan is active.');
      };
      void finish();
      window.history.replaceState(null, '', '/dashboard/billing');
    } else if (checkout === 'cancelled') {
      toast('Checkout cancelled — no change to your plan.');
      window.history.replaceState(null, '', '/dashboard/billing');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkout, sessionId]);

  const startCheckout = useMutation({
    mutationFn: (tier: PlanTier) => api.createPlanCheckout(tier, interval),
    onSuccess: ({ checkoutUrl }) => {
      window.location.href = checkoutUrl;
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not start checkout'),
  });

  const openPortal = useMutation({
    mutationFn: () => api.createBillingPortal(),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiRequestError ? err.body.message : 'Could not open the billing portal',
      ),
  });

  if (isLoading || !plan) {
    return (
      <div className="mx-auto max-w-5xl">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="mt-6 h-32 w-full" />
        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          <Skeleton className="h-96 w-full" />
          <Skeleton className="h-96 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      </div>
    );
  }

  const currentRank = TIER_RANK[plan.tier];

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Billing & plan</h1>
          <p className="mt-1 text-muted-foreground">
            You’re on the <span className="font-semibold text-foreground">{plan.plan.name}</span> plan.
          </p>
        </div>
        {plan.manageable && (
          <Button variant="outline" onClick={() => openPortal.mutate()} disabled={openPortal.isPending}>
            {openPortal.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CreditCard className="h-4 w-4" />
            )}
            Manage billing
          </Button>
        )}
      </div>

      {/* Current-plan summary. */}
      <Card className="mt-6">
        <CardContent className="flex flex-wrap items-center gap-x-10 gap-y-4 p-6">
          <SummaryStat label="Plan" value={plan.plan.name} />
          <SummaryStat
            label="Status"
            value={
              <Badge
                variant={
                  plan.status === 'ACTIVE' || plan.status === 'TRIALING'
                    ? 'success'
                    : plan.status === 'PAST_DUE'
                      ? 'warning'
                      : 'outline'
                }
              >
                {STATUS_LABEL[plan.status] ?? plan.status}
              </Badge>
            }
          />
          <SummaryStat label="Per-order fee" value={`${(plan.commissionBps / 100).toFixed(2)}%`} />
          {plan.interval && (
            <SummaryStat label="Billing" value={plan.interval === 'ANNUAL' ? 'Yearly' : 'Monthly'} />
          )}
          {plan.currentPeriodEnd && (
            <SummaryStat
              label={plan.status === 'TRIALING' ? 'Trial ends' : 'Renews'}
              value={new Date(plan.currentPeriodEnd).toLocaleDateString(undefined, {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              })}
            />
          )}
        </CardContent>
      </Card>

      {plan.status === 'TRIALING' && (
        <div className="mt-4 rounded-xl border border-brand/40 bg-brand-subtle p-4 text-sm">
          <span className="font-semibold">
            {trialDaysLeft(plan.currentPeriodEnd) > 0
              ? `${trialDaysLeft(plan.currentPeriodEnd)} day${trialDaysLeft(plan.currentPeriodEnd) === 1 ? '' : 's'} left in your free trial.`
              : 'Your free trial has ended.'}
          </span>{' '}
          Subscribe below to keep taking orders — you won’t be charged until you do.
        </div>
      )}

      {plan.status === 'PAST_DUE' && (
        <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          Your last payment didn’t go through. Update your card to keep your paid features.{' '}
          <button className="font-semibold underline" onClick={() => openPortal.mutate()}>
            Update payment
          </button>
        </div>
      )}

      {/* Interval toggle. */}
      <div className="mt-8 flex items-center justify-center">
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
      </div>

      {/* Plan cards. */}
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        {plan.pricing.map((option) => (
          <PlanCard
            key={option.tier}
            option={option}
            interval={interval}
            currency={plan.currency}
            currentRank={currentRank}
            hasActiveSubscription={plan.status === 'ACTIVE'}
            busy={startCheckout.isPending || openPortal.isPending}
            onChoose={() => startCheckout.mutate(option.tier)}
          />
        ))}
      </div>

      <p className="mt-6 flex items-center justify-center gap-2 text-center text-sm text-muted-foreground">
        <ShieldCheck className="h-4 w-4" />
        Secure checkout by Stripe. Change or cancel anytime.
      </p>
    </div>
  );
}

/** Whole days between now and the trial end date, floored at 0. */
function trialDaysLeft(end: string | null): number {
  if (!end) return 0;
  const ms = new Date(end).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

function SummaryStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{label}</p>
      <div className="mt-1 text-lg font-bold">{value}</div>
    </div>
  );
}

function PlanCard({
  option,
  interval,
  currency,
  currentRank,
  hasActiveSubscription,
  busy,
  onChoose,
}: {
  option: PlanTierOption;
  interval: BillingInterval;
  currency: string;
  currentRank: number;
  hasActiveSubscription: boolean;
  busy: boolean;
  onChoose: () => void;
}) {
  const { plan, tier, current } = option;
  const perMonthMinor = interval === 'ANNUAL' ? option.annualPerMonthMinor : option.monthlyMinor;
  const rank = TIER_RANK[tier];
  const highlighted = tier === 'GROWTH';
  const commissionPct = (plan.commissionBps / 100).toFixed(2);

  return (
    <Card className={highlighted ? 'border-brand shadow-floating' : ''}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>{plan.name}</CardTitle>
          {current && <Badge variant="success">Current</Badge>}
        </div>
        <CardDescription>{plan.tagline}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-baseline gap-1">
          <span className="text-3xl font-black tracking-tight tabular-nums">
            {formatMoney(perMonthMinor, currency)}
          </span>
          <span className="text-sm font-medium text-muted-foreground">/mo</span>
        </div>
        <p className="mt-1 h-5 text-xs text-muted-foreground">
          {interval === 'ANNUAL'
            ? `${formatMoney(option.annualMinor, currency)}/yr · ${commissionPct}% per order`
            : `+ ${commissionPct}% per order`}
        </p>

        <div className="mt-5">
          {current && hasActiveSubscription ? (
            <Button variant="outline" className="w-full" disabled>
              Current plan
            </Button>
          ) : current ? (
            // On this tier but not paying yet (trial / cancelled) — let them subscribe.
            <Button
              variant={highlighted ? 'brand' : 'default'}
              className="w-full"
              disabled={busy}
              onClick={onChoose}
            >
              Subscribe to {plan.name}
            </Button>
          ) : rank > currentRank ? (
            <Button
              variant={highlighted ? 'brand' : 'default'}
              className="w-full"
              disabled={busy}
              onClick={onChoose}
            >
              Upgrade to {plan.name}
            </Button>
          ) : (
            <Button variant="outline" className="w-full" disabled={busy} onClick={onChoose}>
              Switch to {plan.name}
            </Button>
          )}
        </div>

        <ul className="mt-6 space-y-2.5 text-sm">
          {plan.highlights.map((h) => (
            <li key={h} className="flex items-start gap-2.5">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
              <span className={h.endsWith(':') ? 'font-semibold' : 'text-muted-foreground'}>{h}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
