'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Sparkles, Users } from 'lucide-react';
import { toast } from 'sonner';
import { formatMoney } from '@dinedirect/shared';
import { useApi, useDashboard, useRequireRole } from '@/components/dashboard/dashboard-provider';
import { ApiRequestError } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge, Label, Skeleton, Switch } from '@/components/ui/primitives';

export default function CustomersPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { restaurant } = useDashboard();
  useRequireRole('MANAGER', '/dashboard/kitchen');
  const [search, setSearch] = useState('');
  const [pointsPerDollar, setPointsPerDollar] = useState(
    String(restaurant?.loyaltyPointsPerDollar ?? 1),
  );

  const { data, isLoading } = useQuery({
    queryKey: ['customers', restaurant?.id, search],
    queryFn: () => api.listCustomers(search || undefined),
    enabled: Boolean(restaurant),
  });

  const saveLoyalty = useMutation({
    mutationFn: (body: { loyaltyEnabled?: boolean; loyaltyPointsPerDollar?: number }) =>
      api.updateCurrent(body),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.success('Loyalty settings saved');
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not save that'),
  });

  if (!restaurant) return null;
  const customers = data?.customers ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Customers</h1>
        <p className="text-sm text-muted-foreground">
          Everyone who has ordered from you. Sorted by lifetime spend.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4" />
            Loyalty points
          </CardTitle>
          <CardDescription>
            Customers earn points automatically on every paid order — no redemption yet, just a
            running balance they and you can see.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-6">
          <div className="flex items-center gap-2">
            <Switch
              checked={restaurant.loyaltyEnabled}
              onCheckedChange={(loyaltyEnabled) => saveLoyalty.mutate({ loyaltyEnabled })}
            />
            <span className="text-sm">{restaurant.loyaltyEnabled ? 'On' : 'Off'}</span>
          </div>
          {restaurant.loyaltyEnabled && (
            <div className="flex items-center gap-2">
              <Label htmlFor="pts-per-dollar" className="whitespace-nowrap text-sm">
                Points per $1 spent
              </Label>
              <Input
                id="pts-per-dollar"
                type="number"
                min="1"
                max="100"
                value={pointsPerDollar}
                onChange={(e) => setPointsPerDollar(e.target.value)}
                onBlur={() => {
                  const n = Math.max(1, Math.round(Number(pointsPerDollar) || 1));
                  setPointsPerDollar(String(n));
                  if (n !== restaurant.loyaltyPointsPerDollar) {
                    saveLoyalty.mutate({ loyaltyPointsPerDollar: n });
                  }
                }}
                className="h-9 w-20"
              />
            </div>
          )}
        </CardContent>
      </Card>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, phone or email"
          className="pl-9"
        />
      </div>

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : customers.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Users className="mx-auto h-10 w-10 text-muted-foreground" />
            <p className="mt-4 font-medium">
              {search ? 'No customers match that search' : 'No customers yet'}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {search
                ? 'Try a different name or number.'
                : 'They appear here the moment someone orders.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/50 text-left">
                  <tr>
                    <th className="p-4 font-medium">Customer</th>
                    <th className="p-4 font-medium">Orders</th>
                    <th className="p-4 font-medium">Lifetime spend</th>
                    {restaurant.loyaltyEnabled && <th className="p-4 font-medium">Points</th>}
                    <th className="p-4 font-medium">Last order</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {customers.map((customer) => (
                    <tr key={customer.id} className="hover:bg-muted/30">
                      <td className="p-4">
                        <p className="font-medium">{customer.name}</p>
                        <p className="text-xs text-muted-foreground">{customer.phone}</p>
                      </td>
                      <td className="p-4">
                        <div className="flex items-center gap-2">
                          <span className="tabular-nums">{customer.totalOrders}</span>
                          {/* Five orders is where a customer stops being a
                              stranger and starts being a regular. Worth flagging. */}
                          {customer.totalOrders >= 5 && (
                            <Badge variant="success" className="text-[10px]">
                              regular
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="p-4 font-medium tabular-nums">
                        {formatMoney(customer.totalSpentCents, restaurant.currency)}
                      </td>
                      {restaurant.loyaltyEnabled && (
                        <td className="p-4 tabular-nums">{customer.loyaltyPoints}</td>
                      )}
                      <td className="p-4 text-muted-foreground">
                        {customer.lastOrderAt
                          ? new Date(customer.lastOrderAt).toLocaleDateString()
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
