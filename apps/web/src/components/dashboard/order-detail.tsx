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
  Printer,
  X,
} from 'lucide-react';
import { formatMoney } from '@dinedirect/shared';
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
  const { can, restaurant } = useDashboard();

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

  /**
   * A slip to stick on the bag, not a legal receipt -- the customer already
   * gets that by email/SMS. Restaurant identity + what's inside + a thank you,
   * nothing about payment or contact info that shouldn't ride along on the
   * outside of a delivery bag.
   */
  const printSlip = () => {
    const w = window.open('', '_blank');
    if (!w || !restaurant) return;

    // Monochrome + tiny: this prints on an 80mm self-adhesive label roll, black on
    // white (thermal heads don't do colour), and the page height is `auto` so the
    // roll is cut to THIS order's length — a one-item order uses a fraction of the
    // paper a twelve-item one does, with no blank tail on either.
    const esc = (s: string) =>
      s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

    const mark = restaurant.logoUrl
      ? `<img src="${restaurant.logoUrl}" alt="" style="width:34px;height:34px;border-radius:6px;object-fit:cover" />`
      : `<div style="width:34px;height:34px;border-radius:6px;border:1.5px solid #000;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:800;font-family:Georgia,serif">${esc(restaurant.name.charAt(0).toUpperCase())}</div>`;

    const itemRows = order.items
      .map(
        (item) => `
        <tr>
          <td style="padding:3px 0;vertical-align:top">
            <div style="font-weight:700;line-height:1.25">${item.quantity} × ${esc(item.name)}</div>
            ${item.modifiers.length ? `<div style="font-size:11px;line-height:1.25">${esc(item.modifiers.map((m) => m.name).join(', '))}</div>` : ''}
            ${item.notes ? `<div style="font-size:11px;line-height:1.25;font-style:italic">"${esc(item.notes)}"</div>` : ''}
          </td>
          <td style="padding:3px 0 3px 8px;text-align:right;vertical-align:top;white-space:nowrap;font-weight:600">${formatMoney(item.totalCents, order.currency)}</td>
        </tr>`,
      )
      .join('');

    w.document.write(`<html><head><title>Order #${esc(order.orderNumber)}</title>
      <style>
        @page { size: 80mm auto; margin: 0; }
        html, body { margin: 0; padding: 0; }
        * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        body { width: 80mm; color: #000; background: #fff;
          font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
        .label { padding: 4mm 4mm 5mm; }
        hr { border: none; border-top: 1px dashed #000; margin: 6px 0; }
        table { width: 100%; border-collapse: collapse; }
      </style></head>
      <body>
        <div class="label">
          <div style="display:flex;align-items:center;gap:8px">
            ${mark}
            <div style="min-width:0">
              <div style="font-weight:800;font-size:15px;line-height:1.15">${esc(restaurant.name)}</div>
              <div style="font-size:10px">${esc(restaurant.street)}, ${esc(restaurant.city)}</div>
            </div>
          </div>
          <hr />
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <div style="font-size:19px;font-weight:800">#${esc(order.orderNumber)}</div>
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:.03em">${esc(order.fulfillment.replace('_', ' ').toLowerCase())}${order.tableNumber ? ` · T${esc(order.tableNumber)}` : ''}</div>
          </div>
          <div style="font-size:12px">${esc(order.customerName)}</div>
          <table style="margin-top:7px;font-size:13px">${itemRows}</table>
          <hr />
          <div style="display:flex;justify-content:space-between;font-weight:800;font-size:15px">
            <span>Total</span><span>${formatMoney(order.totalCents, order.currency)}</span>
          </div>
          ${order.notes ? `<div style="margin-top:7px;padding:5px 7px;border:1px solid #000;border-radius:4px;font-size:12px">${esc(order.notes)}</div>` : ''}
          <div style="margin-top:10px;text-align:center;font-size:13px;font-weight:800">Thank you — enjoy every bite!</div>
          <div style="margin-top:2px;text-align:center;font-size:10px;line-height:1.35">
            We’re so glad you ordered straight from ${esc(restaurant.name)}. It means the world to a local kitchen — see you again soon.
          </div>
        </div>
      </body></html>`);
    w.document.close();
    w.focus();
    // Give the logo image a moment to load so it isn't missing on the first print.
    if (restaurant.logoUrl) {
      w.setTimeout(() => w.print(), 250);
    } else {
      w.print();
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            Order #{order.orderNumber}
            <Badge variant="secondary">{order.status.replace(/_/g, ' ').toLowerCase()}</Badge>
          </DialogTitle>
          <DialogDescription>
            {new Date(order.createdAt).toLocaleString()} ·{' '}
            {order.fulfillment.replace('_', ' ').toLowerCase()}
          </DialogDescription>
        </DialogHeader>

        <Button variant="outline" size="sm" onClick={printSlip} className="self-start">
          <Printer className="h-3.5 w-3.5" />
          Print packing slip
        </Button>

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
