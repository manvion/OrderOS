'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownRight, ArrowUpRight, CheckCircle2, CircleAlert, Rocket } from 'lucide-react';
import { formatMoney } from '@dinedirect/shared';
import { useApi, useDashboard } from '@/components/dashboard/dashboard-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/primitives';

export default function DashboardOverview() {
  const api = useApi();
  const { restaurant } = useDashboard();

  const { data: overview, isLoading } = useQuery({
    queryKey: ['analytics', 'overview', restaurant?.id],
    queryFn: () => api.getAnalyticsOverview('30d'),
    enabled: Boolean(restaurant),
  });

  const { data: activeOrders } = useQuery({
    queryKey: ['orders', 'active'],
    queryFn: () => api.listActiveOrders(),
    enabled: Boolean(restaurant),
    refetchInterval: 15_000,
  });

  const { data: readiness } = useQuery({
    queryKey: ['publish-readiness', restaurant?.id],
    queryFn: () => api.getPublishReadiness(),
    enabled: Boolean(restaurant) && !restaurant?.isPublished,
  });

  if (!restaurant) return null;

  const currency = restaurant.currency;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          {greeting()}, {restaurant.name}
        </h1>
        <p className="text-sm text-muted-foreground">Here&apos;s the last 30 days.</p>
      </div>

      {/* Not live yet: the only thing that matters is what's blocking them. */}
      {!restaurant.isPublished && readiness && (
        <Card className="border-brand/40 bg-brand/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Rocket className="h-4 w-4" />
              {readiness.ready ? 'You&apos;re ready to go live' : 'Finish setting up'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-2 text-sm">
              {readiness.blockers.map((blocker) => (
                <li key={blocker} className="flex items-center gap-2">
                  <CircleAlert className="h-4 w-4 shrink-0 text-destructive" />
                  {blocker}
                </li>
              ))}
              {readiness.ready && (
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                  Everything checks out — publish whenever you&apos;re ready.
                </li>
              )}
            </ul>
            <Button asChild size="sm">
              <Link href="/dashboard/settings">
                {readiness.ready ? 'Publish your page' : 'Continue setup'}
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Revenue"
          value={isLoading ? null : formatMoney(overview?.revenueCents ?? 0, currency)}
          change={overview?.changes.revenue ?? null}
        />
        <Stat
          label="Orders"
          value={isLoading ? null : String(overview?.orderCount ?? 0)}
          change={overview?.changes.orders ?? null}
        />
        <Stat
          label="Average order"
          value={isLoading ? null : formatMoney(overview?.averageOrderCents ?? 0, currency)}
          change={overview?.changes.averageOrder ?? null}
        />
        <Stat
          label="New customers"
          value={isLoading ? null : String(overview?.newCustomers ?? 0)}
          change={null}
        />
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Live orders</CardTitle>
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/orders">Open the board</Link>
          </Button>
        </CardHeader>
        <CardContent>
          {!activeOrders || activeOrders.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nothing in flight right now.
            </p>
          ) : (
            <ul className="divide-y">
              {activeOrders.slice(0, 5).map((order) => (
                <li key={order.id} className="flex items-center justify-between py-3">
                  <div>
                    <p className="font-medium">#{order.orderNumber}</p>
                    <p className="text-xs text-muted-foreground">
                      {order.customerName} · {order.status.replace(/_/g, ' ').toLowerCase()}
                    </p>
                  </div>
                  <span className="font-semibold tabular-nums">
                    {formatMoney(order.totalCents, order.currency)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  change,
}: {
  label: string;
  value: string | null;
  change: number | null;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <p className="text-sm text-muted-foreground">{label}</p>
        {value === null ? (
          <Skeleton className="mt-2 h-8 w-24" />
        ) : (
          <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
        )}

        {/* No previous-period baseline means no percentage. Rendering "+100%" for
            a restaurant's first week would be a lie dressed as a green arrow. */}
        {change !== null && (
          <p
            className={`mt-1 flex items-center gap-1 text-xs font-medium ${
              change >= 0 ? 'text-emerald-600' : 'text-destructive'
            }`}
          >
            {change >= 0 ? (
              <ArrowUpRight className="h-3 w-3" />
            ) : (
              <ArrowDownRight className="h-3 w-3" />
            )}
            {Math.abs(change)}% vs previous 30 days
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
