'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { History, Search } from 'lucide-react';
import { formatMoney } from '@dinedirect/shared';
import { useDashboard, useApi } from '@/components/dashboard/dashboard-provider';
import type { Order } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { Badge, Skeleton } from '@/components/ui/primitives';
import { OrderDetail } from '@/components/dashboard/order-detail';

const STATUS_STYLE: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'info' | 'destructive'> = {
  PENDING: 'warning',
  ACCEPTED: 'info',
  PREPARING: 'info',
  READY: 'success',
  DRIVER_ASSIGNED: 'info',
  OUT_FOR_DELIVERY: 'info',
  DELIVERED: 'success',
  COMPLETED: 'secondary',
  CANCELLED: 'destructive',
};

/**
 * Every order this restaurant has ever taken, newest first -- as opposed to
 * /dashboard/orders, which only shows what's currently in flight. Once an
 * order leaves the live board (completed, delivered, cancelled) THIS is
 * where it lives, forever.
 */
export default function OrderHistoryPage() {
  const api = useApi();
  const { restaurant } = useDashboard();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [pages, setPages] = useState<Order[][]>([]);
  const [viewing, setViewing] = useState<Order | null>(null);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['order-history', restaurant?.id, status, cursor],
    queryFn: () => api.listOrders({ status: status || undefined, cursor, limit: 30 }),
    enabled: Boolean(restaurant),
  });

  // Cursor pagination appends a page rather than replacing the list -- a
  // "Load more" click should grow the table, not reset it back to page one.
  const allOrders = (() => {
    if (!data) return pages.flat();
    const withoutCurrent = cursor ? pages : [];
    const combined = cursor ? [...withoutCurrent, data.orders] : [data.orders];
    return combined.flat();
  })();

  const filtered = search.trim()
    ? allOrders.filter(
        (o) =>
          o.orderNumber.toLowerCase().includes(search.toLowerCase()) ||
          (o.handoffCode ?? '').toLowerCase().includes(search.toLowerCase()) ||
          o.customerName.toLowerCase().includes(search.toLowerCase()) ||
          o.customerPhone.includes(search),
      )
    : allOrders;

  const loadMore = () => {
    if (!data?.nextCursor) return;
    setPages((prev) => (cursor ? [...prev, data.orders] : [data.orders]));
    setCursor(data.nextCursor);
  };

  const resetAndFilter = (nextStatus: string) => {
    setStatus(nextStatus);
    setCursor(undefined);
    setPages([]);
  };

  if (!restaurant) return null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Order history</h1>
        <p className="text-sm text-muted-foreground">
          Every paid order you&apos;ve ever taken. Live, in-progress orders are on the Orders page.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search code, order #, name or phone"
            className="pl-9"
          />
        </div>
        <Select value={status} onChange={(e) => resetAndFilter(e.target.value)} className="w-48">
          <option value="">All statuses</option>
          <option value="COMPLETED">Completed</option>
          <option value="DELIVERED">Delivered</option>
          <option value="CANCELLED">Cancelled</option>
        </Select>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <History className="mx-auto h-10 w-10 text-muted-foreground" />
            <p className="mt-4 font-medium">
              {search || status ? 'No orders match that' : 'No orders yet'}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {search || status
                ? 'Try a different search or status.'
                : "They'll show up here once one's been paid and completed."}
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
                    {/* The code the customer read off the status board or a
                        courier read off the bag -- shown here too, so a
                        "what happened to 777N" question can be answered by
                        searching this table, not just the live board. */}
                    <th className="p-4 font-medium">Code</th>
                    <th className="p-4 font-medium">Order</th>
                    <th className="p-4 font-medium">Customer</th>
                    <th className="p-4 font-medium">Fulfillment</th>
                    <th className="p-4 font-medium">Status</th>
                    <th className="p-4 font-medium">Total</th>
                    <th className="p-4 font-medium">Placed</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filtered.map((order) => (
                    <tr
                      key={order.id}
                      className="cursor-pointer hover:bg-muted/30"
                      onClick={() => setViewing(order)}
                    >
                      <td className="p-4">
                        <span className="rounded-md border-2 border-dashed px-2 py-0.5 font-mono text-xs font-black tracking-widest">
                          {order.handoffCode ?? order.orderNumber.slice(-4)}
                        </span>
                      </td>
                      <td className="p-4 font-semibold">#{order.orderNumber}</td>
                      <td className="p-4">
                        <p>{order.customerName}</p>
                        <p className="text-xs text-muted-foreground">{order.customerPhone}</p>
                      </td>
                      <td className="p-4 capitalize text-muted-foreground">
                        {order.fulfillment.replace('_', ' ').toLowerCase()}
                      </td>
                      <td className="p-4">
                        <Badge variant={STATUS_STYLE[order.status] ?? 'secondary'}>
                          {order.status.replace(/_/g, ' ').toLowerCase()}
                        </Badge>
                      </td>
                      <td className="p-4 font-medium tabular-nums">
                        {formatMoney(order.totalCents, order.currency)}
                      </td>
                      <td className="p-4 text-muted-foreground">
                        {new Date(order.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {data?.nextCursor && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={loadMore} disabled={isFetching}>
            {isFetching ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}

      {viewing && <OrderDetail order={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
