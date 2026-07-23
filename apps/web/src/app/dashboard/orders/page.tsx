'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Clock, ExternalLink, MapPin, Phone, Truck, UtensilsCrossed } from 'lucide-react';
import { formatMoney } from '@dinedirect/shared';
import { toast } from 'sonner';
import { useApi } from '@/components/dashboard/dashboard-provider';
import { ApiRequestError, type Order } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge, Skeleton } from '@/components/ui/primitives';
import { OrderDetail } from '@/components/dashboard/order-detail';
import { DeliveryActions } from '@/components/dashboard/delivery-actions';
import { WalkInOrderDialog } from '@/components/dashboard/walk-in-order-dialog';
import { OrderSoundControl } from '@/components/dashboard/order-sound-control';
import { useNewOrderChime } from '@/lib/order-chime';

/**
 * The next action for each status. Exactly one primary button per order — a
 * kitchen board with six equally-weighted buttons is a board nobody uses
 * correctly at 8pm on a Saturday.
 */
const NEXT_ACTION: Record<string, { label: string; status: string } | null> = {
  PENDING: { label: 'Accept', status: 'ACCEPTED' },
  ACCEPTED: { label: 'Start preparing', status: 'PREPARING' },
  PREPARING: { label: 'Mark ready', status: 'READY' },
  READY: { label: 'Complete', status: 'COMPLETED' }, // pickup/dine-in only
  DRIVER_ASSIGNED: null, // Uber drives it from here
  OUT_FOR_DELIVERY: null,
};

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

export default function OrdersPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [cancelling, setCancelling] = useState<Order | null>(null);
  /** The detail drawer — refunds, the full receipt, and the message log. */
  const [viewing, setViewing] = useState<Order | null>(null);
  const [creatingWalkIn, setCreatingWalkIn] = useState(false);

  const { data: orders, isLoading } = useQuery({
    queryKey: ['orders', 'active'],
    queryFn: () => api.listActiveOrders(),
    // A new order must appear without anyone touching the screen. 10s is fast
    // enough that staff trust the board, cheap enough that it's one indexed read.
    refetchInterval: 10_000,
  });

  // Beep when a new order lands, so nobody has to watch the screen. Per-device.
  useNewOrderChime(orders);

  const transition = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.setOrderStatus(id, status),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['orders'] });

      // The order moved, but Uber didn't answer. Say so loudly and persistently —
      // this is the case where food sits under a heat lamp while everyone assumes
      // a driver is coming.
      if (result.warning) {
        toast.warning(result.warning, { duration: 15_000 });
        return;
      }
      // Both Uber AND an own driver are configured — the API refuses to guess, and
      // hands the decision to the person at the pass, who knows how far away the
      // customer is and whether their driver is on shift.
      if ((result as { needsDeliveryChoice?: boolean }).needsDeliveryChoice) {
        toast.info('Choose who delivers this one — Uber, or your own driver.');
        return;
      }
      if (result.delivery?.trackingUrl) {
        toast.success('Courier requested — Uber is on the way');
        return;
      }
      toast.success(`Order #${result.order.orderNumber} updated`);
    },
    onError: (err) => {
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not update the order');
    },
  });

  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.cancelOrder(id, reason),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      setCancelling(null);
      toast.success('Order cancelled — the customer has been notified');
    },
    onError: (err) => {
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not cancel');
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-64" />
          ))}
        </div>
      </div>
    );
  }

  const list = orders ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Live orders</h1>
          <p className="text-sm text-muted-foreground">
            {list.length === 0
              ? 'No orders in flight'
              : `${list.length} order${list.length === 1 ? '' : 's'} in flight`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <OrderSoundControl />
          <Button onClick={() => setCreatingWalkIn(true)}>New order</Button>
        </div>
      </div>

      <WalkInOrderDialog open={creatingWalkIn} onOpenChange={setCreatingWalkIn} />

      {list.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <UtensilsCrossed className="mx-auto h-10 w-10 text-muted-foreground" />
            <p className="mt-4 font-medium">Nothing cooking</p>
            <p className="mt-1 text-sm text-muted-foreground">
              New orders appear here the moment a customer pays.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {list.map((order) => {
            const action = NEXT_ACTION[order.status];
            // A delivery order at READY is Uber's problem now — the restaurant
            // shouldn't be able to "complete" it manually and hide it from the board.
            const showAction =
              action && !(order.status === 'READY' && order.fulfillment === 'DELIVERY');

            const waitMinutes = Math.floor(
              (Date.now() - new Date(order.createdAt).getTime()) / 60_000,
            );
            const isLate = waitMinutes > 30 && !['READY', 'DELIVERED'].includes(order.status);

            return (
              <Card key={order.id} className={isLate ? 'border-destructive' : undefined}>
                <CardContent className="space-y-4 p-5">
                  <div className="flex items-start justify-between gap-2">
                    <button
                      onClick={() => setViewing(order)}
                      className="text-left"
                      title="Order details, refunds and message history"
                    >
                      {/*
                        The last 3 digits of the order number -- the same thing
                        this customer is reading off the public status board,
                        shown as prominently here as it is there, paired with
                        their name. The full order number stays alongside it
                        for reconciliation.
                      */}
                      <div className="flex items-center gap-2">
                        <span className="rounded-md border-2 border-dashed px-2 py-0.5 font-mono text-base font-black tracking-widest">
                          {order.orderNumber.slice(-3)}
                        </span>
                        <span className="text-sm font-semibold text-muted-foreground hover:underline">
                          #{order.orderNumber}
                        </span>
                      </div>
                      <p className="mt-1 text-sm font-medium">{order.customerName}</p>
                      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {waitMinutes}m ago
                        {order.scheduledFor && (
                          <span className="font-medium text-foreground">
                            · scheduled{' '}
                            {new Date(order.scheduledFor).toLocaleTimeString([], {
                              hour: 'numeric',
                              minute: '2-digit',
                            })}
                          </span>
                        )}
                      </p>
                    </button>
                    <Badge variant={STATUS_STYLE[order.status] ?? 'secondary'}>
                      {order.status.replace(/_/g, ' ').toLowerCase()}
                    </Badge>
                  </div>

                  {isLate && (
                    <p className="flex items-center gap-1.5 rounded-md bg-destructive/10 p-2 text-xs font-medium text-destructive">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      Waiting {waitMinutes} minutes
                    </p>
                  )}

                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge variant="outline" className="gap-1">
                      {order.fulfillment === 'DELIVERY' ? (
                        <Truck className="h-3 w-3" />
                      ) : (
                        <UtensilsCrossed className="h-3 w-3" />
                      )}
                      {order.fulfillment.replace('_', ' ').toLowerCase()}
                    </Badge>
                    {order.tableNumber && (
                      <Badge variant="outline">Table {order.tableNumber}</Badge>
                    )}
                  </div>

                  <ul className="space-y-2 border-y py-3 text-sm">
                    {order.items.map((item) => (
                      <li key={item.id}>
                        <div className="flex justify-between gap-2">
                          <span className="font-medium">
                            {item.quantity} × {item.name}
                          </span>
                          <span className="tabular-nums text-muted-foreground">
                            {formatMoney(item.totalCents, order.currency)}
                          </span>
                        </div>
                        {item.modifiers.length > 0 && (
                          <p className="text-xs text-muted-foreground">
                            {item.modifiers.map((m) => m.name).join(', ')}
                          </p>
                        )}
                        {/* Special requests are the thing that gets missed. Make
                            them impossible to miss. */}
                        {item.notes && (
                          <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-xs font-medium text-amber-900">
                            {item.notes}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>

                  {order.notes && (
                    <p className="rounded bg-amber-50 p-2 text-xs font-medium text-amber-900">
                      Note: {order.notes}
                    </p>
                  )}

                  <div className="space-y-1 text-xs text-muted-foreground">
                    <p className="flex items-center gap-1.5">
                      <Phone className="h-3 w-3" />
                      <a href={`tel:${order.customerPhone}`} className="hover:underline">
                        {order.customerName} · {order.customerPhone}
                      </a>
                    </p>
                    {order.deliveryStreet && (
                      <p className="flex items-center gap-1.5">
                        <MapPin className="h-3 w-3" />
                        {order.deliveryStreet}, {order.deliveryCity}
                      </p>
                    )}
                  </div>

                  {/* Who carries it, the pickup code, and the handoff check. */}
                  <DeliveryActions order={order} />

                  {/* Only say "retrying" when it actually is. A permanent decline
                      (FAILED / escalated — a bad address or phone Uber will reject
                      every time) is NOT retried, and telling staff to wait for a
                      retry that never comes leaves a paid order sitting unmoved. */}
                  {order.delivery?.lastError &&
                    (order.delivery.status === 'FAILED' || order.delivery.escalatedAt ? (
                      <p className="rounded bg-destructive/10 p-2 text-xs text-destructive">
                        Uber wouldn&apos;t take this order: {order.delivery.lastError}. Assign your own
                        driver, or check the delivery address and phone number (a placeholder like
                        555-555-5555 is rejected), then try again.
                      </p>
                    ) : (
                      <p className="rounded bg-destructive/10 p-2 text-xs text-destructive">
                        Uber: {order.delivery.lastError} — retrying automatically.
                      </p>
                    ))}

                  {order.delivery?.trackingUrl && (
                    <a
                      href={order.delivery.trackingUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
                    >
                      {order.delivery.courierName ?? 'Driver'} — track
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}

                  <div className="flex items-center justify-between border-t pt-3">
                    <span className="font-bold tabular-nums">
                      {formatMoney(order.totalCents, order.currency)}
                    </span>
                    <div className="flex gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setCancelling(order)}
                        disabled={transition.isPending}
                      >
                        Cancel
                      </Button>
                      {showAction && action && (
                        <Button
                          size="sm"
                          onClick={() => transition.mutate({ id: order.id, status: action.status })}
                          disabled={transition.isPending}
                        >
                          {action.label}
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {viewing && <OrderDetail order={viewing} onClose={() => setViewing(null)} />}

      {cancelling && (
        <CancelDialog
          order={cancelling}
          onClose={() => setCancelling(null)}
          onConfirm={(reason) => cancel.mutate({ id: cancelling.id, reason })}
          isPending={cancel.isPending}
        />
      )}
    </div>
  );
}

function CancelDialog({
  order,
  onClose,
  onConfirm,
  isPending,
}: {
  order: Order;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  isPending: boolean;
}) {
  const [reason, setReason] = useState('');
  const isPaid = order.payment?.status === 'PAID';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <Card className="w-full max-w-md">
        <CardContent className="space-y-4 p-6">
          <div>
            <h2 className="text-lg font-semibold">Cancel order #{order.orderNumber}?</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {isPaid
                ? 'The customer will be texted and emailed. Refund the payment separately from the order detail page.'
                : 'The customer will be notified.'}
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="reason" className="text-sm font-medium">
              Reason (the customer sees this)
            </label>
            <input
              id="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Kitchen is backed up / item sold out"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              autoFocus
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={isPending}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              onClick={() => onConfirm(reason.trim() || 'Cancelled by the restaurant')}
              disabled={isPending}
            >
              {isPending ? 'Cancelling…' : 'Cancel order'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
