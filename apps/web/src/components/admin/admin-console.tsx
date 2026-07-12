'use client';

import { useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Building2,
  ExternalLink,
  LifeBuoy,
  Percent,
  Power,
  Search,
} from 'lucide-react';
import { formatMoney } from '@orderos/shared';
import { toast } from 'sonner';
import { ApiRequestError, createDashboardApi, type AdminRestaurant } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { Badge, Skeleton } from '@/components/ui/primitives';

/**
 * The platform console. Us, not the restaurants.
 *
 * Answers, in order of how often you actually need them:
 *
 *  1. Is the business growing? (GMV, our revenue, orders)
 *  2. WHO IS STUCK? — restaurants that signed up and never went live. Every one is
 *     a person who wanted the product and couldn't finish. That list is the single
 *     most valuable thing on this page, so it is not buried in a funnel chart.
 *  3. Find a restaurant, see why they're stuck, help them, set their commission,
 *     or switch them off.
 */
export function AdminConsole() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  const api = createDashboardApi(getToken);

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');

  const { data: me, isError } = useQuery({
    queryKey: ['admin', 'me'],
    queryFn: () => api.adminMe(),
    retry: false,
  });

  const { data: overview } = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => api.adminOverview(30),
    enabled: Boolean(me),
  });

  const { data: list, isLoading } = useQuery({
    queryKey: ['admin', 'restaurants', search, status],
    queryFn: () => api.adminListRestaurants({ search: search || undefined, status: status || undefined }),
    enabled: Boolean(me),
  });

  const support = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.adminStartSupport(id, reason),
    onSuccess: () => {
      toast.success('Support session open for 1 hour. It is on their audit log.', {
        duration: 8000,
      });
      // The dashboard reads X-Restaurant-Id; the session makes it resolve.
      window.open('/dashboard', '_blank');
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not open a session'),
  });

  const setFee = useMutation({
    mutationFn: ({ id, bps }: { id: string; bps: number }) => api.adminSetFee(id, bps),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
      toast.success('Commission updated. It applies to future orders only.');
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not set the fee'),
  });

  const setActive = useMutation({
    mutationFn: ({ id, isActive, reason }: { id: string; isActive: boolean; reason: string }) =>
      api.adminSetActive(id, isActive, reason),
    onSuccess: (_r, v) => {
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
      toast.success(
        v.isActive
          ? 'Reactivated — their storefront is live again.'
          : 'Suspended. Their storefront and widget are off. No data was deleted.',
      );
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not update'),
  });

  // Not an admin? Say nothing useful. Probing /admin should teach you nothing.
  if (isError) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Not found</p>
      </div>
    );
  }

  if (!me) {
    return (
      <div className="mx-auto max-w-6xl space-y-6 p-8">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const isSuper = me.role === 'SUPER_ADMIN';

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-lg font-bold tracking-tight">OrderOS · Platform</h1>
            <p className="text-xs text-muted-foreground">
              {me.email} · {me.role.replace('_', ' ').toLowerCase()}
            </p>
          </div>
          <Button asChild variant="outline" size="sm">
            <a href="/admin/new">
              <Building2 className="h-3.5 w-3.5" />
              Onboard a restaurant
            </a>
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-8 p-6">
        {/* The numbers */}
        {overview && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Our revenue (30d)"
              value={formatMoney(overview.platformRevenueCents, 'USD')}
              change={overview.changes.platformRevenue}
              hint="Platform fee. The real number."
              emphasis
            />
            <Stat
              label="GMV (30d)"
              value={formatMoney(overview.gmvCents, 'USD')}
              change={overview.changes.gmv}
              hint="What customers paid. Not ours."
            />
            <Stat
              label="Orders (30d)"
              value={overview.orders.toLocaleString()}
              change={overview.changes.orders}
            />
            <Stat
              label="Live restaurants"
              value={`${overview.restaurants.live} / ${overview.restaurants.total}`}
              hint={`${overview.restaurants.new} joined this month`}
            />
          </div>
        )}

        {/* The list that actually matters */}
        {overview && overview.restaurants.stuckInOnboarding > 0 && (
          <Card className="border-amber-300 bg-amber-50">
            <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
                <div>
                  <p className="font-semibold text-amber-900">
                    {overview.restaurants.stuckInOnboarding} restaurant
                    {overview.restaurants.stuckInOnboarding === 1 ? '' : 's'} signed up and never
                    went live
                  </p>
                  <p className="mt-0.5 text-sm text-amber-800">
                    They wanted this and couldn&apos;t finish. Each one is a phone call, not a
                    statistic.
                  </p>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={() => setStatus('draft')}>
                Show me
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Restaurants */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Restaurants</CardTitle>
            <CardDescription>Search, inspect, help, price, or suspend.</CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-3">
              <div className="relative min-w-64 flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Name, slug or email"
                  className="pl-9"
                />
              </div>
              <Select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className="w-40"
              >
                <option value="">All</option>
                <option value="live">Live</option>
                <option value="draft">Not live</option>
                <option value="suspended">Suspended</option>
              </Select>
            </div>

            {isLoading ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <div className="space-y-2">
                {list?.restaurants.map((r) => (
                  <RestaurantRow
                    key={r.id}
                    restaurant={r}
                    isSuper={isSuper}
                    onSupport={(reason) => support.mutate({ id: r.id, reason })}
                    onSetFee={(bps) => setFee.mutate({ id: r.id, bps })}
                    onSetActive={(isActive, reason) =>
                      setActive.mutate({ id: r.id, isActive, reason })
                    }
                  />
                ))}

                {list?.restaurants.length === 0 && (
                  <p className="py-12 text-center text-sm text-muted-foreground">
                    No restaurants match.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

function RestaurantRow({
  restaurant: r,
  isSuper,
  onSupport,
  onSetFee,
  onSetActive,
}: {
  restaurant: AdminRestaurant;
  isSuper: boolean;
  onSupport: (reason: string) => void;
  onSetFee: (bps: number) => void;
  onSetActive: (isActive: boolean, reason: string) => void;
}) {
  const [fee, setFee] = useState((r.platformFeeBps / 100).toFixed(2));

  return (
    <div className="flex flex-wrap items-center gap-4 rounded-xl border p-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{r.name}</span>

          {!r.isActive ? (
            <Badge variant="destructive">suspended</Badge>
          ) : r.isPublished ? (
            <Badge variant="success">live</Badge>
          ) : (
            <Badge variant="warning">not live</Badge>
          )}

          {!r.stripeChargesEnabled && (
            <Badge variant="outline" className="text-[10px]">
              no Stripe
            </Badge>
          )}
        </div>

        <p className="mt-0.5 text-xs text-muted-foreground">
          {r.slug} · {r.city} · {r._count.orders} orders · {r._count.products} items ·{' '}
          {r._count.users} staff
        </p>
      </div>

      {/* Commission. SUPER_ADMIN only — a support agent must never be able to
          discount the product to placate an angry caller. */}
      {isSuper && (
        <div className="flex items-center gap-1.5">
          <Percent className="h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={fee}
            onChange={(e) => setFee(e.target.value)}
            onBlur={() => {
              const bps = Math.round(parseFloat(fee || '0') * 100);
              if (bps !== r.platformFeeBps) onSetFee(bps);
            }}
            className="h-8 w-20 text-xs"
          />
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            // A written reason is mandatory — it lands on THEIR audit log.
            const reason = prompt(
              `Why do you need to access ${r.name}?\n\nThis is recorded on their audit log, where they can see it.`,
            );
            if (reason?.trim()) onSupport(reason.trim());
          }}
        >
          <LifeBuoy className="h-3.5 w-3.5" />
          Help
        </Button>

        {r.isPublished && (
          <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
            <a
              href={`http://${r.slug}.localhost:3000`}
              target="_blank"
              rel="noopener noreferrer"
              title="Open their storefront"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </Button>
        )}

        {isSuper && (
          <Button
            variant="ghost"
            size="icon"
            className={`h-8 w-8 ${r.isActive ? 'text-muted-foreground hover:text-destructive' : 'text-emerald-600'}`}
            title={r.isActive ? 'Suspend' : 'Reactivate'}
            onClick={() => {
              const verb = r.isActive ? 'Suspend' : 'Reactivate';
              const reason = prompt(
                `${verb} ${r.name}?\n\n${
                  r.isActive
                    ? 'Their storefront and widget stop working immediately. No data is deleted.'
                    : 'Their storefront goes live again.'
                }\n\nReason:`,
              );
              if (reason?.trim()) onSetActive(!r.isActive, reason.trim());
            }}
          >
            <Power className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  change,
  hint,
  emphasis,
}: {
  label: string;
  value: string;
  change?: number | null;
  hint?: string;
  emphasis?: boolean;
}) {
  return (
    <Card className={emphasis ? 'border-brand-subtle bg-brand-subtle' : undefined}>
      <CardContent className="p-5">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>

        {/* No baseline, no percentage. "+100%" on a platform's first month is a
            green arrow that means nothing. */}
        {change !== null && change !== undefined && (
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
            {Math.abs(change)}%
          </p>
        )}

        {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}
