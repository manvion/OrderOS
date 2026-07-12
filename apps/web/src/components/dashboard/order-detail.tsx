'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  CreditCard,
  Mail,
  MessageSquare,
  Phone,
  X,
} from 'lucide-react';
import { formatMoney } from '@orderos/shared';
import { toast } from 'sonner';
import { useApi, useDashboard } from './dashboard-provider';
import { ApiRequestError, type Order } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Badge,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Label,
  Skeleton,
} from '@/components/ui/primitives';

/**
 * The order detail drawer: the full record, the refund control, and — critically —
 * the notification log.
 *
 * The refund endpoint has existed since day one with no UI, which meant staff had
 * to go to the Stripe dashboard to give a customer their money back. That's a
 * product with a hole in it.
 */
export function OrderDetail({ order, onClose }: { order: Order; onClose: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { can } = useDashboard();

  const [refunding, setRefunding] = useState(false);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');

  const { data: notifications, isLoading: loadingNotifications } = useQuery({
    queryKey: ['notifications', order.id],
    queryFn: () => api.getOrderNotifications(order.id),
  });

  const payment = order.payment;
  const alreadyRefunded = payment?.refundedAmountCents ?? 0;
  const refundable = (payment?.amountCents ?? 0) - alreadyRefunded;
  const canRefund =
    can('MANAGER') &&
    refundable > 0 &&
    (payment?.status === 'PAID' || payment?.status === 'PARTIALLY_REFUNDED');

  const refund = useMutation({
    mutationFn: () => {
      const cents = amount.trim() ? Math.round(parseFloat(amount) * 100) : undefined;
      return api.refund(order.id, { amountCents: cents, reason: reason.trim() || undefined });
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      toast.success(
        result.isFullRefund
          ? 'Fully refunded — the order has been cancelled and the customer notified.'
          : `Refunded ${formatMoney(result.amountCents, order.currency)}.`,
      );
      setRefunding(false);
      onClose();
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Refund failed'),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            Order #{order.orderNumber}
            {/*
              The code the customer just read out at the counter. Staff work
              backwards from it — someone says "K7M2", and this is where they
              confirm it is the order in front of them. Monospace, because it is
              read character by character and not as a word.
            */}
            {order.handoffCode && (
              <span className="rounded-md border-2 border-dashed px-2 py-0.5 font-mono text-base font-black tracking-widest">
                {order.handoffCode}
              </span>
            )}
            <Badge variant="secondary">{order.status.replace(/_/g, ' ').toLowerCase()}</Badge>
          </DialogTitle>
          <DialogDescription>
            {new Date(order.createdAt).toLocaleString()} ·{' '}
            {order.fulfillment.replace('_', ' ').toLowerCase()}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Items */}
          <section>
            <h3 className="mb-2 text-sm font-semibold">Items</h3>
            <ul className="space-y-2 rounded-lg border p-3 text-sm">
              {order.items.map((item) => (
                <li key={item.id}>
                  <div className="flex justify-between gap-3">
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
                  {item.notes && (
                    <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">
                      {item.notes}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {/* Customer */}
          <section className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1 text-sm">
              <h3 className="text-sm font-semibold">Customer</h3>
              <p>{order.customerName}</p>
              <a
                href={`tel:${order.customerPhone}`}
                className="flex items-center gap-1.5 text-muted-foreground hover:underline"
              >
                <Phone className="h-3 w-3" />
                {order.customerPhone}
              </a>
              <a
                href={`mailto:${order.customerEmail}`}
                className="flex items-center gap-1.5 text-muted-foreground hover:underline"
              >
                <Mail className="h-3 w-3" />
                {order.customerEmail}
              </a>
            </div>

            <div className="space-y-1 text-sm">
              <h3 className="text-sm font-semibold">Payment</h3>
              {payment ? (
                <>
                  <p className="flex items-center gap-1.5">
                    <CreditCard className="h-3 w-3 text-muted-foreground" />
                    {payment.cardBrand
                      ? `${payment.cardBrand} ···${payment.cardLast4}`
                      : payment.status.toLowerCase()}
                  </p>
                  <p className="text-muted-foreground">
                    Paid {formatMoney(payment.amountCents, order.currency)}
                  </p>
                  {alreadyRefunded > 0 && (
                    <p className="font-medium text-destructive">
                      Refunded {formatMoney(alreadyRefunded, order.currency)}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-muted-foreground">No payment record</p>
              )}
            </div>
          </section>

          {/* Notification log — the answer to "they say they never got the text" */}
          <section>
            <h3 className="mb-2 text-sm font-semibold">Messages sent</h3>
            {loadingNotifications ? (
              <Skeleton className="h-20 w-full" />
            ) : !notifications?.length ? (
              <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                No messages sent for this order yet.
              </p>
            ) : (
              <ul className="space-y-1 rounded-lg border p-3">
                {notifications.map((n) => (
                  <li key={n.id} className="flex items-center gap-2 text-xs">
                    {n.status === 'SENT' ? (
                      <Check className="h-3 w-3 shrink-0 text-emerald-600" />
                    ) : n.status === 'SKIPPED' ? (
                      <X className="h-3 w-3 shrink-0 text-muted-foreground" />
                    ) : (
                      <AlertTriangle className="h-3 w-3 shrink-0 text-destructive" />
                    )}

                    {n.channel === 'SMS' ? (
                      <MessageSquare className="h-3 w-3 shrink-0 text-muted-foreground" />
                    ) : (
                      <Mail className="h-3 w-3 shrink-0 text-muted-foreground" />
                    )}

                    <span className="font-medium">{n.audience.toLowerCase()}</span>
                    <span className="text-muted-foreground">{n.template}</span>
                    <span className="text-muted-foreground">→ {n.recipient}</span>

                    {/* The reason a message wasn't sent is more useful than the fact. */}
                    {n.error && (
                      <span className="truncate text-muted-foreground" title={n.error}>
                        · {n.error}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Refund */}
          {canRefund && (
            <section className="rounded-lg border border-destructive/30 p-4">
              <h3 className="text-sm font-semibold">Refund</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {formatMoney(refundable, order.currency)} is still refundable. A full refund also
                cancels the order and notifies the customer.
              </p>

              {refunding ? (
                <div className="mt-3 space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="refund-amount">
                      Amount ({order.currency}) — leave blank to refund it all
                    </Label>
                    <Input
                      id="refund-amount"
                      type="number"
                      step="0.01"
                      min="0.01"
                      max={(refundable / 100).toFixed(2)}
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder={(refundable / 100).toFixed(2)}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="refund-reason">Reason (internal)</Label>
                    <Input
                      id="refund-reason"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="Item was cold / missing a side"
                    />
                  </div>

                  <div className="flex gap-2">
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => refund.mutate()}
                      disabled={refund.isPending}
                    >
                      {refund.isPending
                        ? 'Refunding…'
                        : `Refund ${formatMoney(
                            amount.trim() ? Math.round(parseFloat(amount || '0') * 100) : refundable,
                            order.currency,
                          )}`}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setRefunding(false)}
                      disabled={refund.isPending}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => setRefunding(true)}
                >
                  Issue a refund
                </Button>
              )}
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
