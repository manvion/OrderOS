'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import {
  Banknote,
  Bike,
  Check,
  ClipboardList,
  Copy,
  CreditCard,
  Link2,
  Minus,
  Plus,
  Receipt,
  ShoppingBag,
  Smartphone,
  Trash2,
  Truck,
  UtensilsCrossed,
} from 'lucide-react';
import { toast } from 'sonner';
import { formatMoney, priceOrder } from '@dinedirect/shared';
import { useApi, useDashboard } from '@/components/dashboard/dashboard-provider';
import { ApiRequestError, type Order, type Product } from '@/lib/api';
import {
  ModifierConfigurator,
  WalkInOrderDialog,
  type ConfiguredLine,
} from '@/components/dashboard/walk-in-order-dialog';
import { DeliveryActions } from '@/components/dashboard/delivery-actions';
import { OrderSoundControl } from '@/components/dashboard/order-sound-control';
import { useNewOrderChime } from '@/lib/order-chime';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Badge, Dialog, DialogContent, DialogHeader, DialogTitle, Skeleton } from '@/components/ui/primitives';

/**
 * The front-desk POS — a full-screen, touch-first ordering terminal.
 *
 * This is the screen a front-of-house tablet lives on all shift. Two jobs, one
 * place, because the person at the counter does both without thinking of them as
 * separate:
 *
 *  1. RING UP an order — walk-in or phone — from a big tappable menu, take payment
 *     in person (cash or the card terminal), and fire it to the kitchen. Built on
 *     the same walk-in endpoint and modifier picker the New-order dialog uses, so
 *     there is one source of truth for how a counter order is priced and created.
 *  2. GET DELIVERIES OUT THE DOOR — mark them ready and choose who carries each one
 *     (Uber or the restaurant's own driver), then verify the courier handoff. That
 *     decision used to live only on the manager's Orders screen; front desk needs it
 *     because front desk is who is standing there when the driver walks in.
 *
 * It reuses DeliveryActions verbatim, so the dispatch behaviour here can never drift
 * from the rest of the dashboard.
 */

type PosTab = 'order' | 'orders' | 'delivery';

export default function PosPage() {
  const { restaurant } = useDashboard();
  const [tab, setTab] = useState<PosTab>('order');

  const { counterBadge, deliveriesBadge } = useActiveBadges();

  if (!restaurant) {
    return <Skeleton className="h-[70vh] w-full rounded-2xl" />;
  }

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="no-scrollbar flex items-center gap-2 overflow-x-auto">
        <TabButton active={tab === 'order'} onClick={() => setTab('order')} icon={Receipt}>
          New order
        </TabButton>
        <TabButton active={tab === 'orders'} onClick={() => setTab('orders')} icon={ClipboardList}>
          Orders
          {counterBadge > 0 && (
            <Badge variant="warning" className="ml-1.5 text-[10px]">
              {counterBadge}
            </Badge>
          )}
        </TabButton>
        <TabButton active={tab === 'delivery'} onClick={() => setTab('delivery')} icon={Truck}>
          Delivery
          {deliveriesBadge > 0 && (
            <Badge variant="warning" className="ml-1.5 text-[10px]">
              {deliveriesBadge}
            </Badge>
          )}
        </TabButton>
        </div>
        <OrderSoundControl />
      </div>

      {tab === 'order' ? (
        <OrderTerminal />
      ) : tab === 'orders' ? (
        <ActiveOrders />
      ) : (
        <DeliveryDispatch />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Receipt;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex shrink-0 items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
        active
          ? 'bg-brand text-brand-foreground shadow-soft'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground'
      }`}
    >
      <Icon className="h-4 w-4" />
      {children}
    </button>
  );
}

/** Live counts for the tab badges: counter orders needing action, deliveries to move. */
function useActiveBadges(): { counterBadge: number; deliveriesBadge: number } {
  const api = useApi();
  const { data } = useQuery({
    queryKey: ['orders', 'active'],
    queryFn: () => api.listActiveOrders(),
    refetchInterval: 10_000,
  });
  const orders = data ?? [];
  // The POS terminal beeps for new orders too — this hook is mounted the whole time
  // the POS is open, whichever tab is showing.
  useNewOrderChime(data);
  return {
    counterBadge: orders.filter(
      (o) => o.fulfillment !== 'DELIVERY' && ACTIVE_STATUSES.includes(o.status),
    ).length,
    deliveriesBadge: orders.filter(
      (o) =>
        o.fulfillment === 'DELIVERY' &&
        ['READY', 'DRIVER_ASSIGNED', 'OUT_FOR_DELIVERY'].includes(o.status),
    ).length,
  };
}

// The next status each counter order advances to when staff tap its one button.
const COUNTER_NEXT_ACTION: Record<string, { label: string; status: string } | undefined> = {
  PENDING: { label: 'Accept', status: 'ACCEPTED' },
  ACCEPTED: { label: 'Start preparing', status: 'PREPARING' },
  PREPARING: { label: 'Mark ready', status: 'READY' },
  READY: { label: 'Complete', status: 'COMPLETED' },
};

const ACTIVE_STATUSES = ['PENDING', 'ACCEPTED', 'PREPARING', 'READY'];

// ---------------------------------------------------------------------------
// The order terminal: menu grid + running ticket
// ---------------------------------------------------------------------------

function OrderTerminal() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { restaurant } = useDashboard();

  const { data: categories } = useQuery({
    queryKey: ['menu', 'categories'],
    queryFn: () => api.listCategories(),
  });
  const { data: products } = useQuery({
    queryKey: ['menu', 'products'],
    queryFn: () => api.listProducts(),
  });

  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const [lines, setLines] = useState<ConfiguredLine[]>([]);
  const [configuring, setConfiguring] = useState<Product | null>(null);
  const [fulfillment, setFulfillment] = useState<'PICKUP' | 'DINE_IN' | 'DELIVERY'>('PICKUP');
  const [tableNumber, setTableNumber] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [address, setAddress] = useState({ street: '', city: '', state: '', postalCode: '' });
  const [paymentMethod, setPaymentMethod] = useState<'CASH' | 'CARD_TERMINAL' | 'LINK'>('CASH');
  // The just-created payment link, shown for staff to read out / let the customer scan.
  const [linkResult, setLinkResult] = useState<{ orderNumber: string; url: string } | null>(null);
  const [linkQr, setLinkQr] = useState<string | null>(null);
  // A card order created unpaid and handed to the Staff app's Tap to Pay. The dialog
  // polls it until the tap settles it, then clears.
  const [tapPay, setTapPay] = useState<{
    orderId: string;
    orderNumber: string;
    totalCents: number;
  } | null>(null);

  // A card taken in person is only a real "tap to pay" for a pickup / dine-in order;
  // a delivery card still folds the courier cost into a charge run elsewhere, so it
  // keeps the plain confirm-and-send path.
  const isTapToPay = paymentMethod === 'CARD_TERMINAL' && fulfillment !== 'DELIVERY';

  // The payment link is an online charge (pickup / dine-in only) and can't ride on a
  // delivery ticket — snap back to Cash if the fulfillment moves to delivery.
  useEffect(() => {
    if (fulfillment === 'DELIVERY' && paymentMethod === 'LINK') setPaymentMethod('CASH');
  }, [fulfillment, paymentMethod]);

  // Render the link as a QR so a customer standing at the counter can just scan to pay.
  useEffect(() => {
    if (!linkResult) {
      setLinkQr(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(linkResult.url, { width: 320, margin: 1 })
      .then((d) => !cancelled && setLinkQr(d))
      .catch(() => !cancelled && setLinkQr(null));
    return () => {
      cancelled = true;
    };
  }, [linkResult]);

  // A delivery ticket can't be sent without somewhere to send it and someone to call.
  const deliveryReady =
    fulfillment !== 'DELIVERY' ||
    (address.street.trim().length > 2 &&
      address.city.trim().length > 1 &&
      customerPhone.trim().length > 4);

  // A payment link is texted/emailed — it needs a phone (its primary channel).
  const linkReady = paymentMethod !== 'LINK' || customerPhone.trim().length > 4;

  const grouped = useMemo(() => {
    if (!categories || !products) return [];
    return categories
      .filter((c) => c.isActive)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((category) => ({
        category,
        products: products
          .filter((p) => p.categoryId === category.id && p.isAvailable)
          .sort((a, b) => a.sortOrder - b.sortOrder),
      }))
      .filter((g) => g.products.length > 0);
  }, [categories, products]);

  // Default to the first category once the menu loads.
  const shownGroups =
    activeCategoryId === null ? grouped : grouped.filter((g) => g.category.id === activeCategoryId);

  // The ticket total is computed by the SAME priceOrder the API bills with, so what
  // staff read out — subtotal, tax, service fee, and (for delivery) the delivery fee —
  // matches the amount actually charged. The old code summed only the food line items,
  // so a delivery ticket quoted the customer LESS than they were charged, and tax /
  // service fee never showed at all.
  const pricing = useMemo(
    () =>
      priceOrder({
        items: lines.map((l) => ({
          productId: l.productId,
          name: l.name,
          unitPriceCents: l.unitPriceCents + l.modifiersCents,
          quantity: l.quantity,
          modifiers: [],
        })),
        taxRateBps: restaurant?.taxRateBps ?? 0,
        taxComponents: restaurant?.taxComponents ?? undefined,
        taxDeliveryFee: restaurant?.taxDeliveryFee ?? false,
        fulfillment,
        deliveryFeeCents: restaurant?.deliveryFeeCents ?? 0,
        serviceFeeCents: restaurant?.serviceFeeCents ?? 0,
        serviceChargeType: restaurant?.serviceChargeType,
        serviceChargeCents: restaurant?.serviceChargeCents ?? 0,
        serviceChargeBps: restaurant?.serviceChargeBps ?? 0,
      }),
    [lines, fulfillment, restaurant],
  );

  const addLine = (product: Product) => {
    if (product.modifierGroups.length > 0) {
      setConfiguring(product);
      return;
    }
    setLines((prev) => {
      const existing = prev.find((l) => l.key === product.id);
      if (existing) {
        return prev.map((l) => (l.key === product.id ? { ...l, quantity: l.quantity + 1 } : l));
      }
      return [
        ...prev,
        {
          key: product.id,
          productId: product.id,
          name: product.name,
          unitPriceCents: product.priceCents,
          quantity: 1,
          modifierIds: [],
          modifierLabel: '',
          modifiersCents: 0,
        },
      ];
    });
  };

  const setQuantity = (key: string, quantity: number) => {
    if (quantity <= 0) {
      setLines((prev) => prev.filter((l) => l.key !== key));
      return;
    }
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, quantity } : l)));
  };

  const create = useMutation({
    mutationFn: () =>
      api.createWalkInOrder({
        items: lines.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          modifierIds: l.modifierIds,
        })),
        fulfillment,
        customerName: customerName.trim() || undefined,
        customerPhone: customerPhone.trim() || undefined,
        customerEmail: customerEmail.trim() || undefined,
        tableNumber: fulfillment === 'DINE_IN' ? tableNumber.trim() || undefined : undefined,
        deliveryAddress:
          fulfillment === 'DELIVERY'
            ? {
                street: address.street.trim(),
                city: address.city.trim(),
                state: address.state.trim() || undefined,
                postalCode: address.postalCode.trim() || undefined,
              }
            : undefined,
        // create() only runs for the in-person methods; LINK goes through sendLink.
        paymentMethod: paymentMethod === 'CARD_TERMINAL' ? 'CARD_TERMINAL' : 'CASH',
      }),
    onSuccess: (order) => {
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      toast.success(
        `Order #${order.orderNumber} sent to the kitchen — code ${order.orderNumber.slice(-3)}`,
      );
      resetTicket();
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiRequestError ? err.body.message : 'Could not create the order',
      ),
  });

  // Create the order UNPAID and hand it to the Staff app's Tap to Pay. The order lands
  // in the app's "awaiting payment" queue; the deep link jumps straight to its charge
  // sheet. It reaches the kitchen only once the tap settles it (server-side), which the
  // TapToPayDialog waits for.
  const startTap = useMutation({
    mutationFn: () =>
      api.createWalkInOrder({
        items: lines.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          modifierIds: l.modifierIds,
        })),
        fulfillment: fulfillment === 'DINE_IN' ? 'DINE_IN' : 'PICKUP',
        customerName: customerName.trim() || undefined,
        customerPhone: customerPhone.trim() || undefined,
        customerEmail: customerEmail.trim() || undefined,
        tableNumber: fulfillment === 'DINE_IN' ? tableNumber.trim() || undefined : undefined,
        paymentMethod: 'CARD_TERMINAL',
        deferPayment: true,
      }),
    onSuccess: (order) => {
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      setTapPay({ orderId: order.id, orderNumber: order.orderNumber, totalCents: order.totalCents });
      openStaffAppCharge(order.id);
      resetTicket();
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiRequestError ? err.body.message : 'Could not start the card payment',
      ),
  });

  // Create an UNPAID order and text/email the customer a Stripe link to pay. It only
  // reaches the kitchen once they pay; the link is also shown here to read out or scan.
  const sendLink = useMutation({
    mutationFn: () =>
      api.createPaymentLinkOrder({
        items: lines.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          modifierIds: l.modifierIds,
        })),
        fulfillment: fulfillment === 'DINE_IN' ? 'DINE_IN' : 'PICKUP',
        customerName: customerName.trim() || undefined,
        customerPhone: customerPhone.trim(),
        customerEmail: customerEmail.trim() || undefined,
        tableNumber: fulfillment === 'DINE_IN' ? tableNumber.trim() || undefined : undefined,
      }),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      toast.success(`Payment link created for #${res.orderNumber} and sent to the customer`);
      setLinkResult({ orderNumber: res.orderNumber, url: res.checkoutUrl });
      resetTicket();
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiRequestError ? err.body.message : 'Could not create the payment link',
      ),
  });

  function resetTicket() {
    setLines([]);
    setCustomerName('');
    setCustomerPhone('');
    setCustomerEmail('');
    setTableNumber('');
    setAddress({ street: '', city: '', state: '', postalCode: '' });
  }

  if (!restaurant) return null;

  return (
    <>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[1.4fr_1fr]">
        {/* Menu */}
        <Card className="overflow-hidden">
          <div className="no-scrollbar flex gap-2 overflow-x-auto border-b p-3">
            <CategoryChip active={activeCategoryId === null} onClick={() => setActiveCategoryId(null)}>
              All
            </CategoryChip>
            {grouped.map(({ category }) => (
              <CategoryChip
                key={category.id}
                active={activeCategoryId === category.id}
                onClick={() => setActiveCategoryId(category.id)}
              >
                {category.name}
              </CategoryChip>
            ))}
          </div>

          <div className="space-y-6 p-4 md:max-h-[calc(100dvh_-_13rem)] md:overflow-y-auto">
            {grouped.length === 0 && (
              <p className="py-16 text-center text-sm text-muted-foreground">Loading the menu…</p>
            )}
            {shownGroups.map(({ category, products: items }) => (
              <div key={category.id}>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  {category.name}
                </h3>
                <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
                  {items.map((product) => (
                    <button
                      key={product.id}
                      type="button"
                      onClick={() => addLine(product)}
                      className="flex min-h-20 flex-col justify-between rounded-2xl border p-3 text-left transition-colors hover:border-brand hover:bg-brand-subtle active:scale-[0.98]"
                    >
                      <span className="line-clamp-2 text-sm font-semibold leading-tight">
                        {product.name}
                      </span>
                      <span className="mt-2 text-xs text-muted-foreground">
                        {formatMoney(product.priceCents, restaurant.currency)}
                        {product.modifierGroups.length > 0 ? ' · options' : ''}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* Ticket */}
        <Card className="flex flex-col md:max-h-[calc(100dvh_-_11rem)]">
          <div className="border-b p-4">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
              Ticket
            </h2>
          </div>

          <div className="flex-1 p-4 md:overflow-y-auto">
            {lines.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                Tap items to build the order.
              </p>
            ) : (
              <ul className="space-y-2">
                {lines.map((line) => (
                  <li key={line.key} className="flex items-start justify-between gap-2 text-sm">
                    <div className="min-w-0">
                      <p className="font-medium">{line.name}</p>
                      {line.modifierLabel && (
                        <p className="text-xs text-muted-foreground">{line.modifierLabel}</p>
                      )}
                      <p className="text-xs tabular-nums text-muted-foreground">
                        {formatMoney(
                          (line.unitPriceCents + line.modifiersCents) * line.quantity,
                          restaurant.currency,
                        )}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setQuantity(line.key, line.quantity - 1)}
                        className="flex h-7 w-7 items-center justify-center rounded-md border text-muted-foreground hover:bg-accent"
                      >
                        <Minus className="h-3.5 w-3.5" />
                      </button>
                      <span className="w-5 text-center tabular-nums">{line.quantity}</span>
                      <button
                        type="button"
                        onClick={() => setQuantity(line.key, line.quantity + 1)}
                        className="flex h-7 w-7 items-center justify-center rounded-md border text-muted-foreground hover:bg-accent"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setQuantity(line.key, 0)}
                        className="ml-1 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-3 border-t p-4">
            <div className={`grid gap-2 ${restaurant.deliveryEnabled ? 'grid-cols-3' : 'grid-cols-2'}`}>
              <Button
                type="button"
                variant={fulfillment === 'PICKUP' ? 'brand' : 'outline'}
                size="sm"
                onClick={() => setFulfillment('PICKUP')}
              >
                <ShoppingBag className="h-3.5 w-3.5" />
                Pickup
              </Button>
              <Button
                type="button"
                variant={fulfillment === 'DINE_IN' ? 'brand' : 'outline'}
                size="sm"
                onClick={() => setFulfillment('DINE_IN')}
              >
                <UtensilsCrossed className="h-3.5 w-3.5" />
                Dine in
              </Button>
              {restaurant.deliveryEnabled && (
                <Button
                  type="button"
                  variant={fulfillment === 'DELIVERY' ? 'brand' : 'outline'}
                  size="sm"
                  onClick={() => setFulfillment('DELIVERY')}
                >
                  <Bike className="h-3.5 w-3.5" />
                  Delivery
                </Button>
              )}
            </div>

            {fulfillment === 'DINE_IN' && (
              <Input
                placeholder="Table number"
                value={tableNumber}
                onChange={(e) => setTableNumber(e.target.value)}
              />
            )}

            {fulfillment === 'DELIVERY' && (
              <div className="space-y-2 rounded-xl border border-brand-subtle bg-brand-subtle p-2.5">
                <Input
                  placeholder="Street address"
                  value={address.street}
                  onChange={(e) => setAddress((a) => ({ ...a, street: e.target.value }))}
                />
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    placeholder="City"
                    value={address.city}
                    onChange={(e) => setAddress((a) => ({ ...a, city: e.target.value }))}
                  />
                  <Input
                    placeholder="Postal code"
                    value={address.postalCode}
                    onChange={(e) => setAddress((a) => ({ ...a, postalCode: e.target.value }))}
                  />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  The delivery fee is added to the total below. Assign a courier from the Delivery
                  tab once it&apos;s ready.
                </p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <Input
                placeholder="Name (optional)"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
              />
              <Input
                type="tel"
                placeholder={fulfillment === 'DELIVERY' ? 'Phone (required)' : 'Phone (optional)'}
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
              />
            </div>

            <Input
              type="email"
              placeholder="Email (optional — emails a receipt)"
              value={customerEmail}
              onChange={(e) => setCustomerEmail(e.target.value)}
            />
            {(customerPhone.trim() || customerEmail.trim()) && (
              <p className="text-[11px] text-muted-foreground">
                A receipt & order updates go to the customer
                {customerPhone.trim() ? ' by text' : ''}
                {customerPhone.trim() && customerEmail.trim() ? ' and' : ''}
                {customerEmail.trim() ? ' by email' : ''}.
              </p>
            )}

            {/* Payment link isn't an in-person method and doesn't apply to a delivery
                ticket, so it's offered only for pickup / dine-in. */}
            <div className={`grid gap-2 ${fulfillment === 'DELIVERY' ? 'grid-cols-2' : 'grid-cols-3'}`}>
              <Button
                type="button"
                variant={paymentMethod === 'CASH' ? 'brand' : 'outline'}
                size="sm"
                onClick={() => setPaymentMethod('CASH')}
              >
                Cash
              </Button>
              <Button
                type="button"
                variant={paymentMethod === 'CARD_TERMINAL' ? 'brand' : 'outline'}
                size="sm"
                onClick={() => setPaymentMethod('CARD_TERMINAL')}
              >
                Card
              </Button>
              {fulfillment !== 'DELIVERY' && (
                <Button
                  type="button"
                  variant={paymentMethod === 'LINK' ? 'brand' : 'outline'}
                  size="sm"
                  onClick={() => setPaymentMethod('LINK')}
                >
                  <Link2 className="h-3.5 w-3.5" />
                  Link
                </Button>
              )}
            </div>

            <div className="space-y-1 text-sm">
              {/* Only break the total down when there's more to it than the food — an
                  all-in pickup order with no tax stays a single clean "Total" line. */}
              {pricing.totalCents !== pricing.subtotalCents && (
                <>
                  <TicketRow label="Subtotal" value={pricing.subtotalCents} currency={restaurant.currency} />
                  {pricing.serviceFeeCents > 0 && (
                    <TicketRow label="Service fee" value={pricing.serviceFeeCents} currency={restaurant.currency} />
                  )}
                  {pricing.serviceChargeCents > 0 && (
                    <TicketRow
                      label={restaurant.serviceChargeLabel || 'Service charge'}
                      value={pricing.serviceChargeCents}
                      currency={restaurant.currency}
                    />
                  )}
                  {pricing.deliveryFeeCents > 0 && (
                    <TicketRow label="Delivery fee" value={pricing.deliveryFeeCents} currency={restaurant.currency} />
                  )}
                  {pricing.taxLines.map((t) => (
                    <TicketRow key={t.name} label={t.name} value={t.amountCents} currency={restaurant.currency} />
                  ))}
                </>
              )}
              <div className="flex items-center justify-between pt-1 text-base font-semibold">
                <span>Total</span>
                <span className="tabular-nums">
                  {formatMoney(pricing.totalCents, restaurant.currency)}
                </span>
              </div>
            </div>

            {paymentMethod === 'LINK' ? (
              <Button
                className="w-full"
                size="lg"
                disabled={lines.length === 0 || !linkReady || sendLink.isPending}
                onClick={() => sendLink.mutate()}
              >
                {sendLink.isPending ? 'Creating link…' : 'Create & send payment link'}
              </Button>
            ) : isTapToPay ? (
              <Button
                className="w-full"
                size="lg"
                disabled={lines.length === 0 || startTap.isPending}
                onClick={() => startTap.mutate()}
              >
                <CreditCard className="h-4 w-4" />
                {startTap.isPending ? 'Starting the charge…' : 'Charge card — Tap to Pay'}
              </Button>
            ) : (
              <Button
                className="w-full"
                size="lg"
                disabled={lines.length === 0 || !deliveryReady || create.isPending}
                onClick={() => create.mutate()}
              >
                {create.isPending ? 'Sending to kitchen…' : 'Confirm — paid, send to kitchen'}
              </Button>
            )}
            {paymentMethod === 'LINK' && (
              <p className="text-[11px] text-muted-foreground">
                The order is placed <span className="font-medium">unpaid</span> and only reaches the
                kitchen once the customer pays. We text{customerEmail.trim() ? ' & email' : ''} them
                the link.
              </p>
            )}
            {isTapToPay && (
              <p className="text-[11px] text-muted-foreground">
                Opens the <span className="font-medium">Staff app</span> to take the tap. The order
                is placed <span className="font-medium">unpaid</span> and only reaches the kitchen
                once the card goes through.
              </p>
            )}
          </div>
        </Card>
      </div>

      {linkResult && (
        <PaymentLinkResult
          orderNumber={linkResult.orderNumber}
          url={linkResult.url}
          qr={linkQr}
          onClose={() => setLinkResult(null)}
        />
      )}

      {tapPay && (
        <TapToPayDialog
          orderId={tapPay.orderId}
          orderNumber={tapPay.orderNumber}
          totalCents={tapPay.totalCents}
          currency={restaurant.currency}
          onClose={() => setTapPay(null)}
        />
      )}

      {configuring && (
        <ModifierConfigurator
          product={configuring}
          currency={restaurant.currency}
          onCancel={() => setConfiguring(null)}
          onConfirm={(line) => {
            setLines((prev) => [...prev, line]);
            setConfiguring(null);
          }}
        />
      )}
    </>
  );
}

/** The just-created payment link — QR to scan, URL to copy, for staff to hand over. */
function PaymentLinkResult({
  orderNumber,
  url,
  qr,
  onClose,
}: {
  orderNumber: string;
  url: string;
  qr: string | null;
  onClose: () => void;
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied');
    } catch {
      toast.error('Could not copy — long-press the link instead');
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Payment link · #{orderNumber}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-center">
          <p className="text-sm text-muted-foreground">
            Sent to the customer. They can also scan this to pay right now.
          </p>
          {qr ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qr} alt="Scan to pay" className="mx-auto h-48 w-48 rounded-lg border bg-white" />
          ) : (
            <div className="mx-auto h-48 w-48 animate-pulse rounded-lg bg-muted" />
          )}
          <div className="flex items-center gap-2">
            <Input readOnly value={url} className="text-xs" onFocus={(e) => e.target.select()} />
            <Button size="sm" variant="outline" className="shrink-0" onClick={copy}>
              <Copy className="h-3.5 w-3.5" />
              Copy
            </Button>
          </div>
          <Button className="w-full" onClick={onClose}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Jump to the native Staff app's charge sheet for one order. The app registers the
 * `dinedirect-staff` URL scheme (see apps/staff-app/app.json); on the same device this
 * hands straight off to Tap to Pay. On a device without the app installed nothing opens
 * — the order still sits in the app's "awaiting payment" queue to be charged from there.
 */
function openStaffAppCharge(orderId: string) {
  window.location.href = `dinedirect-staff://charge/${orderId}`;
}

/**
 * Waits for a Tap-to-Pay order to be paid. The charge happens in the Staff app; this
 * polls the order until its payment settles (server-side, via the Terminal), then shows
 * Paid and closes. Staff can re-open the app if the hand-off didn't take, or void the
 * order if the card never goes through.
 */
function TapToPayDialog({
  orderId,
  orderNumber,
  totalCents,
  currency,
  onClose,
}: {
  orderId: string;
  orderNumber: string;
  totalCents: number;
  currency: string;
  onClose: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();

  const { data: order } = useQuery({
    queryKey: ['orders', orderId, 'tap-pay'],
    queryFn: () => api.getOrder(orderId),
    // Poll while unpaid; stop once it's settled so we're not hammering a done order.
    refetchInterval: (query) =>
      query.state.data?.payment?.status === 'PAID' ? false : 2500,
  });

  const paid =
    order?.payment?.status === 'PAID' || order?.payment?.status === 'PARTIALLY_REFUNDED';

  // A moment on the ✓ so staff see it landed, then clear.
  useEffect(() => {
    if (!paid) return;
    void queryClient.invalidateQueries({ queryKey: ['orders'] });
    toast.success(`Order #${orderNumber} paid — sent to the kitchen`);
    const t = setTimeout(onClose, 1400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paid]);

  const voidOrder = useMutation({
    mutationFn: () => api.cancelOrder(orderId, 'Card payment not completed'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      toast.success(`Order #${orderNumber} voided`);
      onClose();
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not void the order'),
  });

  return (
    <Dialog open onOpenChange={(v) => !v && !paid && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{paid ? 'Paid' : 'Take the tap'} · #{orderNumber}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-center">
          <p className="text-3xl font-bold tabular-nums">{formatMoney(totalCents, currency)}</p>

          {paid ? (
            <div className="flex flex-col items-center gap-2 py-2">
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-success/15 text-success">
                <Check className="h-7 w-7" />
              </span>
              <p className="text-sm text-muted-foreground">Sent to the kitchen.</p>
            </div>
          ) : (
            <>
              <div className="flex flex-col items-center gap-2 py-2">
                <span className="flex h-14 w-14 animate-pulse items-center justify-center rounded-full bg-brand-subtle text-brand">
                  <Smartphone className="h-7 w-7" />
                </span>
                <p className="text-sm text-muted-foreground">
                  Complete the tap in the Staff app. This closes on its own once the card
                  goes through.
                </p>
              </div>
              <Button variant="outline" className="w-full" onClick={() => openStaffAppCharge(orderId)}>
                <CreditCard className="h-4 w-4" />
                Open the Staff app again
              </Button>
              <button
                type="button"
                disabled={voidOrder.isPending}
                onClick={() => voidOrder.mutate()}
                className="text-xs text-muted-foreground underline-offset-2 hover:text-destructive hover:underline disabled:opacity-50"
              >
                {voidOrder.isPending ? 'Voiding…' : 'Cancel — card not taken'}
              </button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** One right-aligned money line in the ticket total breakdown (subtotal, fee, tax). */
function TicketRow({
  label,
  value,
  currency,
}: {
  label: string;
  value: number;
  currency: string;
}) {
  return (
    <div className="flex items-center justify-between text-muted-foreground">
      <span>{label}</span>
      <span className="tabular-nums">{formatMoney(value, currency)}</span>
    </div>
  );
}

function CategoryChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
        active ? 'bg-brand text-brand-foreground' : 'bg-muted text-muted-foreground hover:bg-accent'
      }`}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Active counter orders — pickup & dine-in, moved through the kitchen flow
// ---------------------------------------------------------------------------

function ActiveOrders() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { restaurant } = useDashboard();

  const { data: orders, isLoading } = useQuery({
    queryKey: ['orders', 'active'],
    queryFn: () => api.listActiveOrders(),
    refetchInterval: 8_000,
  });

  const advance = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.setOrderStatus(id, status),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['orders'] }),
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not update the order'),
  });

  // The open table tab we're adding a round to, and the unpaid order we're collecting on.
  const [tabFor, setTabFor] = useState<{
    id: string;
    orderNumber: string;
    tableNumber: string | null;
  } | null>(null);
  const [settleFor, setSettleFor] = useState<{
    id: string;
    orderNumber: string;
    totalCents: number;
    amountPaidCents: number;
  } | null>(null);

  // Delivery has its own tab (dispatch is a different job); this is the counter flow.
  const counter = (orders ?? []).filter(
    (o) => o.fulfillment !== 'DELIVERY' && ACTIVE_STATUSES.includes(o.status),
  );

  if (isLoading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-32 w-full rounded-2xl" />
        <Skeleton className="h-32 w-full rounded-2xl" />
      </div>
    );
  }

  if (counter.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
          <ClipboardList className="h-8 w-8 text-muted-foreground" />
          <p className="font-medium">No open pickup or dine-in orders</p>
          <p className="text-sm text-muted-foreground">
            New orders — from the counter, the customer&apos;s phone, or the website — appear here to
            accept, prepare and hand over.
          </p>
        </CardContent>
      </Card>
    );
  }

  const currency = restaurant?.currency ?? 'CAD';

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {counter.map((order) => {
        const next = COUNTER_NEXT_ACTION[order.status];
        const paid =
          order.payment?.status === 'PAID' || order.payment?.status === 'PARTIALLY_REFUNDED';
        const partiallyPaid = order.payment?.status === 'PARTIALLY_PAID';
        const paidCents = order.payment?.amountPaidCents ?? 0;
        const remainingCents = order.totalCents - paidCents;
        // An open dine-in table whose bill isn't settled yet: staff can add another round
        // and take the payment. A pay-at-desk table is the common case, but any unpaid
        // dine-in tab qualifies.
        const isOpenTab = order.fulfillment === 'DINE_IN' && !paid;
        const awaitingPayment = !paid && (order.payAtDesk || order.fulfillment === 'DINE_IN');
        return (
          <Card key={order.id}>
            <CardContent className="space-y-3 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold">#{order.orderNumber}</p>
                  <p className="text-xs capitalize text-muted-foreground">
                    {order.fulfillment.replace('_', ' ').toLowerCase()}
                    {order.tableNumber ? ` · Table ${order.tableNumber}` : ''}
                    {order.customerName ? ` · ${order.customerName}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <Badge variant={order.status === 'READY' ? 'success' : 'info'}>
                    {order.status.toLowerCase()}
                  </Badge>
                  <Badge variant={paid ? 'success' : 'warning'} className="text-[10px]">
                    {paid ? 'paid' : partiallyPaid ? 'part paid' : 'unpaid'}
                  </Badge>
                </div>
              </div>

              <p className="line-clamp-2 text-xs text-muted-foreground">
                {order.items.map((i) => `${i.quantity}× ${i.name}`).join(', ')}
              </p>

              {partiallyPaid && (
                <p className="text-xs font-medium text-amber-600">
                  {formatMoney(paidCents, currency)} paid · {formatMoney(remainingCents, currency)}{' '}
                  remaining
                </p>
              )}

              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold tabular-nums">
                  {formatMoney(order.totalCents, currency)}
                </span>
                {next && (
                  <Button
                    size="sm"
                    disabled={advance.isPending}
                    onClick={() => advance.mutate({ id: order.id, status: next.status })}
                  >
                    {order.status === 'READY' && <Check className="h-3.5 w-3.5" />}
                    {next.label}
                  </Button>
                )}
              </div>

              {(isOpenTab || awaitingPayment) && (
                <div className="flex flex-wrap gap-2 border-t pt-3">
                  {isOpenTab && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setTabFor({
                          id: order.id,
                          orderNumber: order.orderNumber,
                          tableNumber: order.tableNumber,
                        })
                      }
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add items
                    </Button>
                  )}
                  {awaitingPayment && (
                    <Button
                      size="sm"
                      onClick={() =>
                        setSettleFor({
                          id: order.id,
                          orderNumber: order.orderNumber,
                          totalCents: order.totalCents,
                          amountPaidCents: paidCents,
                        })
                      }
                    >
                      <Banknote className="h-3.5 w-3.5" />
                      {partiallyPaid ? 'Take rest of payment' : 'Take payment'}
                    </Button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
      </div>

      {tabFor && (
        <WalkInOrderDialog open onOpenChange={(v) => !v && setTabFor(null)} tabOrder={tabFor} />
      )}

      {settleFor && (
        <SettleDialog
          orderId={settleFor.id}
          orderNumber={settleFor.orderNumber}
          totalCents={settleFor.totalCents}
          amountPaidCents={settleFor.amountPaidCents}
          currency={currency}
          onClose={() => setSettleFor(null)}
        />
      )}
    </>
  );
}

/**
 * Collect payment on an open counter/table order. Staff pick how the customer is paying:
 * cash or card mark it settled at the desk right now; a payment link texts/emails them a
 * Stripe checkout (and shows a QR to scan at the counter) that settles it when they pay.
 */
function SettleDialog({
  orderId,
  orderNumber,
  totalCents,
  amountPaidCents,
  currency,
  onClose,
}: {
  orderId: string;
  orderNumber: string;
  totalCents: number;
  amountPaidCents: number;
  currency: string;
  onClose: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [link, setLink] = useState<{ url: string; qr: string | null } | null>(null);
  // What's still owed after any cash already taken. Cash can settle a part of it; card
  // and link always clear the whole remaining.
  const remaining = Math.max(0, totalCents - amountPaidCents);
  // Cash received now — blank means "the whole remaining balance".
  const [cashAmount, setCashAmount] = useState('');
  // Card is a REAL tap, not an honour-system "mark paid": we hand off to the Staff app
  // and wait for the charge to actually land (like the new-order Tap to Pay flow).
  const [cardWaiting, setCardWaiting] = useState(false);

  const { data: polled } = useQuery({
    queryKey: ['orders', orderId, 'settle-poll'],
    queryFn: () => api.getOrder(orderId),
    enabled: cardWaiting,
    refetchInterval: (query) =>
      query.state.data?.payment?.status === 'PAID' ? false : 2500,
  });
  const cardPaid =
    polled?.payment?.status === 'PAID' || polled?.payment?.status === 'PARTIALLY_REFUNDED';
  useEffect(() => {
    if (!cardWaiting || !cardPaid) return;
    void queryClient.invalidateQueries({ queryKey: ['orders'] });
    toast.success(`Order #${orderNumber} paid`);
    const t = setTimeout(onClose, 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardWaiting, cardPaid]);

  const startCard = () => {
    setCardWaiting(true);
    openStaffAppCharge(orderId);
  };

  // Cash is collected in person and settles at the desk immediately. An entered amount
  // below the remaining is a PART payment (leaves the bill open); blank clears it all.
  // (Card no longer routes through here — it takes a real tap via the Staff app.)
  const settle = useMutation({
    mutationFn: () => {
      const cents = cashAmount.trim() ? Math.round(parseFloat(cashAmount) * 100) : undefined;
      return api.settleAtDesk(orderId, 'CASH', cents);
    },
    onSuccess: (order) => {
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      const fully = order.payment?.status === 'PAID';
      toast.success(
        fully
          ? `Order #${orderNumber} paid`
          : `Part payment taken — ${formatMoney(order.totalCents - (order.payment?.amountPaidCents ?? 0), currency)} still due`,
      );
      onClose();
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not take payment'),
  });

  const sendLink = useMutation({
    mutationFn: () => api.createOrderPaymentLink(orderId),
    onSuccess: async (res) => {
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      const qr = await QRCode.toDataURL(res.checkoutUrl, { width: 320, margin: 1 }).catch(() => null);
      setLink({ url: res.checkoutUrl, qr });
      toast.success('Payment link created and sent to the customer');
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiRequestError ? err.body.message : 'Could not create the payment link',
      ),
  });

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      toast.success('Link copied');
    } catch {
      toast.error('Could not copy — long-press the link instead');
    }
  };

  const busy = settle.isPending || sendLink.isPending;

  return (
    <Dialog open onOpenChange={(v) => !v && !cardWaiting && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {link ? 'Payment link' : cardWaiting ? 'Card — Tap to Pay' : 'Take payment'} · #
            {orderNumber}
          </DialogTitle>
        </DialogHeader>

        {cardWaiting ? (
          <div className="space-y-4 text-center">
            <p className="text-3xl font-bold tabular-nums">{formatMoney(totalCents, currency)}</p>
            {cardPaid ? (
              <div className="flex flex-col items-center gap-2 py-2">
                <span className="flex h-14 w-14 items-center justify-center rounded-full bg-success/15 text-success">
                  <Check className="h-7 w-7" />
                </span>
                <p className="text-sm text-muted-foreground">Paid.</p>
              </div>
            ) : (
              <>
                <div className="flex flex-col items-center gap-2 py-2">
                  <span className="flex h-14 w-14 animate-pulse items-center justify-center rounded-full bg-brand-subtle text-brand">
                    <Smartphone className="h-7 w-7" />
                  </span>
                  <p className="text-sm text-muted-foreground">
                    Take the tap in the Staff app. This closes on its own once the card goes
                    through.
                  </p>
                </div>
                <Button variant="outline" className="w-full" onClick={() => openStaffAppCharge(orderId)}>
                  <CreditCard className="h-4 w-4" />
                  Open the Staff app again
                </Button>
                <button
                  type="button"
                  onClick={() => setCardWaiting(false)}
                  className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  Back
                </button>
              </>
            )}
          </div>
        ) : link ? (
          <div className="space-y-4 text-center">
            <p className="text-sm text-muted-foreground">
              Sent to the customer. They can also scan this to pay {formatMoney(totalCents, currency)}{' '}
              now — the order settles automatically once they do.
            </p>
            {link.qr ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={link.qr} alt="Scan to pay" className="mx-auto h-48 w-48 rounded-lg border bg-white" />
            ) : (
              <div className="mx-auto h-48 w-48 animate-pulse rounded-lg bg-muted" />
            )}
            <div className="flex items-center gap-2">
              <Input readOnly value={link.url} className="text-xs" onFocus={(e) => e.target.select()} />
              <Button size="sm" variant="outline" className="shrink-0" onClick={copy}>
                <Copy className="h-3.5 w-3.5" />
                Copy
              </Button>
            </div>
            <Button className="w-full" onClick={onClose}>
              Done
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="text-center">
              <p className="text-3xl font-bold tabular-nums">{formatMoney(remaining, currency)}</p>
              {amountPaidCents > 0 && (
                <p className="text-xs text-muted-foreground">
                  {formatMoney(amountPaidCents, currency)} of {formatMoney(totalCents, currency)}{' '}
                  already paid
                </p>
              )}
            </div>
            {/* Cash can be a PART payment: type a smaller amount to take some now and leave
                the rest owing. Blank = the whole balance. Card and link clear it all. */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Cash received</label>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  {currency}
                </span>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  className="pl-12 tabular-nums"
                  placeholder={(remaining / 100).toFixed(2)}
                  value={cashAmount}
                  onChange={(e) => setCashAmount(e.target.value)}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" disabled={busy} onClick={() => settle.mutate()}>
                <Banknote className="h-4 w-4" />
                {settle.isPending ? 'Saving…' : 'Take cash'}
              </Button>
              <Button variant="outline" disabled={busy} onClick={startCard}>
                <CreditCard className="h-4 w-4" />
                Card
              </Button>
            </div>
            <Button className="w-full" variant="outline" disabled={busy} onClick={() => sendLink.mutate()}>
              <Link2 className="h-4 w-4" />
              {sendLink.isPending ? 'Creating link…' : 'Send a payment link'}
            </Button>
            <p className="text-center text-[11px] text-muted-foreground">
              Cash settles now. Card takes a real tap in the Staff app. A link lets the customer
              pay online — the order settles when the money actually lands.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// The delivery dispatch board
// ---------------------------------------------------------------------------

function DeliveryDispatch() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { restaurant } = useDashboard();

  const { data: orders, isLoading } = useQuery({
    queryKey: ['orders', 'active'],
    queryFn: () => api.listActiveOrders(),
    refetchInterval: 8_000,
  });

  const markReady = useMutation({
    mutationFn: (id: string) => api.setOrderStatus(id, 'READY'),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      if (res.warning) toast.warning(res.warning);
      else toast.success('Ready — now choose who carries it');
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not update the order'),
  });

  const deliveries = (orders ?? []).filter(
    (o) => o.fulfillment === 'DELIVERY' && o.status !== 'DELIVERED' && o.status !== 'CANCELLED',
  );

  if (isLoading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-40 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    );
  }

  if (deliveries.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
          <Bike className="h-8 w-8 text-muted-foreground" />
          <p className="font-medium">No deliveries to dispatch</p>
          <p className="text-sm text-muted-foreground">
            Delivery orders show up here the moment they come in — mark them ready and pick who
            carries each one.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {deliveries.map((order) => (
        <Card key={order.id}>
          <CardContent className="space-y-3 p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold">#{order.orderNumber}</p>
                <p className="text-xs text-muted-foreground">
                  {order.customerName ?? 'Delivery'} ·{' '}
                  {formatMoney(order.totalCents, restaurant?.currency ?? 'CAD')}
                </p>
              </div>
              <Badge variant="info">{order.status.replace(/_/g, ' ').toLowerCase()}</Badge>
            </div>

            {/* Before it's ready there's nothing to dispatch — offer the one action
                that gets it there. Once READY, DeliveryActions takes over with the
                Uber / own-driver choice and the courier handoff check. */}
            {['PENDING', 'ACCEPTED', 'PREPARING'].includes(order.status) ? (
              <Button
                size="sm"
                className="w-full"
                disabled={markReady.isPending}
                onClick={() => markReady.mutate(order.id)}
              >
                Mark ready to dispatch
              </Button>
            ) : (
              <DeliveryActions order={order} />
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
