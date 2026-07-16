'use client';

import Link from 'next/link';
import { Lock } from 'lucide-react';
import { getPlan, lowestTierWith, planAllows, type PlanCapability } from '@dinedirect/shared';
import { useDashboard } from './dashboard-provider';
import { Button } from '@/components/ui/button';

/**
 * Wraps a whole dashboard page (or section) so it's only reachable on a plan that
 * includes the capability. A locked nav item is just a hint; THIS is the actual
 * restriction — a Starter restaurant that types /dashboard/website hits an upgrade
 * wall, not the website editor.
 *
 * FAILS OPEN: it only shows the wall when it DEFINITIVELY knows the plan lacks the
 * feature. While the plan is loading — or if the plan can't be fetched at all (e.g.
 * the API's /subscriptions endpoint isn't up yet) — it renders the page rather than
 * trapping the owner behind a spinner. The server enforces the same gates on every
 * write, so this is UX, not the security boundary; failing open here can never grant
 * a capability the API will actually honour.
 */
export function PlanGate({
  capability,
  children,
}: {
  capability: PlanCapability;
  children: React.ReactNode;
}) {
  const { planState } = useDashboard();

  // Only block when we KNOW the plan doesn't include it. Unknown => show the page.
  if (!planState || planAllows(planState.tier, capability)) return <>{children}</>;

  const requiredTier = lowestTierWith(capability);
  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-subtle text-brand">
        <Lock className="h-6 w-6" />
      </div>
      <h2 className="mt-5 text-xl font-bold">Available on {getPlan(requiredTier).name}</h2>
      <p className="mx-auto mt-2 max-w-sm text-muted-foreground">
        This isn’t part of your {getPlan(planState.tier).name} plan. Upgrade to{' '}
        <span className="font-semibold text-foreground">{getPlan(requiredTier).name}</span> to
        unlock it.
      </p>
      <Button asChild variant="brand" className="mt-6">
        <Link href="/dashboard/billing">See plans &amp; upgrade</Link>
      </Button>
    </div>
  );
}
