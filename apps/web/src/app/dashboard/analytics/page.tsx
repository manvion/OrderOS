'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatMoney } from '@dinedirect/shared';
import { useApi, useDashboard } from '@/components/dashboard/dashboard-provider';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/primitives';

const PERIODS = ['7d', '30d', '90d'] as const;
type Period = (typeof PERIODS)[number];

export default function AnalyticsPage() {
  const api = useApi();
  const { restaurant } = useDashboard();
  const [period, setPeriod] = useState<Period>('30d');

  const { data: revenue, isLoading: loadingRevenue } = useQuery({
    queryKey: ['analytics', 'revenue', restaurant?.id, period],
    queryFn: () => api.getRevenueSeries(period),
    enabled: Boolean(restaurant),
  });

  const { data: topProducts } = useQuery({
    queryKey: ['analytics', 'top-products', restaurant?.id, period],
    queryFn: () => api.getTopProducts(period),
    enabled: Boolean(restaurant),
  });

  const { data: economics } = useQuery({
    queryKey: ['analytics', 'delivery-economics', restaurant?.id, period],
    queryFn: () => api.getDeliveryEconomics(period),
    enabled: Boolean(restaurant) && Boolean(restaurant?.uberDirectEnabled),
  });

  if (!restaurant) return null;
  const currency = restaurant.currency;

  const chartData = (revenue ?? []).map((d) => ({
    date: new Date(d.date).toLocaleDateString([], { month: 'short', day: 'numeric' }),
    revenue: d.revenueCents / 100,
    orders: d.orderCount,
  }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold tracking-tight">Analytics</h1>
        <div className="flex gap-1 rounded-lg border p-1">
          {PERIODS.map((p) => (
            <Button
              key={p}
              variant={period === p ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setPeriod(p)}
            >
              {p === '7d' ? '7 days' : p === '30d' ? '30 days' : '90 days'}
            </Button>
          ))}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Revenue</CardTitle>
          <CardDescription>Net of refunds. Paid orders only.</CardDescription>
        </CardHeader>
        <CardContent>
          {loadingRevenue ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <ResponsiveContainer width="100%" height={256}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 12 }} tickLine={false} axisLine={false} width={48} />
                <Tooltip
                  formatter={(value: number) => formatMoney(value * 100, currency)}
                  contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12 }}
                />
                <Line
                  type="monotone"
                  dataKey="revenue"
                  stroke={restaurant.brandPrimaryColor}
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Best sellers</CardTitle>
          </CardHeader>
          <CardContent>
            {!topProducts?.length ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No sales in this period.
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(200, topProducts.length * 36)}>
                <BarChart
                  data={topProducts.map((p) => ({ ...p, revenue: p.revenueCents / 100 }))}
                  layout="vertical"
                  margin={{ left: 8 }}
                >
                  <XAxis type="number" hide />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={120}
                    tick={{ fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    formatter={(value: number) => formatMoney(value * 100, currency)}
                    contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12 }}
                  />
                  <Bar dataKey="revenue" fill={restaurant.brandPrimaryColor} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/*
          The number Uber's own dashboard will never show a restaurant: whether
          their delivery fee actually covers what they're being charged.
        */}
        {economics && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Delivery economics</CardTitle>
              <CardDescription>What you charged, against what Uber charged you.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-muted-foreground">Collected from customers</p>
                  <p className="mt-1 text-xl font-bold tabular-nums">
                    {formatMoney(economics.collectedCents, currency)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Paid to Uber</p>
                  <p className="mt-1 text-xl font-bold tabular-nums">
                    {formatMoney(economics.uberCostCents, currency)}
                  </p>
                </div>
              </div>

              <div className="rounded-lg border p-4">
                <p className="text-xs text-muted-foreground">
                  {economics.marginCents >= 0 ? 'You keep' : 'You are subsidising'}
                </p>
                <p
                  className={`mt-1 text-2xl font-bold tabular-nums ${
                    economics.marginCents >= 0 ? 'text-emerald-600' : 'text-destructive'
                  }`}
                >
                  {formatMoney(Math.abs(economics.marginCents), currency)}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  Across {economics.deliveryCount} deliveries · average Uber fee{' '}
                  {formatMoney(economics.averageUberFeeCents, currency)}
                </p>
              </div>

              {economics.marginCents < 0 && (
                <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
                  Every delivery order is costing you money. Consider raising your delivery fee in
                  Settings.
                </p>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
