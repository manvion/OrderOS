'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bike, Minus, Plus, Receipt, ShoppingBag, Trash2, Truck, UtensilsCrossed } from 'lucide-react';
import { toast } from 'sonner';
import { formatMoney } from '@dinedirect/shared';
import { useApi, useDashboard } from '@/components/dashboard/dashboard-provider';
import { ApiRequestError, type Order, type Product } from '@/lib/api';
import {
  ModifierConfigurator,
  type ConfiguredLine,
} from '@/components/dashboard/walk-in-order-dialog';
import { DeliveryActions } from '@/components/dashboard/delivery-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Badge, Skeleton } from '@/components/ui/primitives';

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

type PosTab = 'order' | 'delivery';

export default function PosPage() {
  const { restaurant } = useDashboard();
  const [tab, setTab] = useState<PosTab>('order');

  const deliveriesBadge = usePendingDeliveryCount();

  if (!restaurant) {
    return <Skeleton className="h-[70vh] w-full rounded-2xl" />;
  }

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-4 flex items-center gap-2">
        <TabButton active={tab === 'order'} onClick={() => setTab('order')} icon={Receipt}>
          New order
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

      {tab === 'order' ? <OrderTerminal /> : <DeliveryDispatch />}
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
      className={`flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
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

/** How many delivery orders are waiting on a human — used for the tab badge. */
function usePendingDeliveryCount(): number {
  const api = useApi();
  const { data } = useQuery({
    queryKey: ['orders', 'active'],
    queryFn: () => api.listActiveOrders(),
    refetchInterval: 10_000,
  });
  return (data ?? []).filter(
    (o) =>
      o.fulfillment === 'DELIVERY' &&
      ['READY', 'DRIVER_ASSIGNED', 'OUT_FOR_DELIVERY'].includes(o.status),
  ).length;
}

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
  const [fulfillment, setFulfillment] = useState<'PICKUP' | 'DINE_IN'>('PICKUP');
  const [tableNumber, setTableNumber] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'CASH' | 'CARD_TERMINAL'>('CASH');

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

  const totalCents = lines.reduce(
    (sum, l) => sum + (l.unitPriceCents + l.modifiersCents) * l.quantity,
    0,
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
        tableNumber: fulfillment === 'DINE_IN' ? tableNumber.trim() || undefined : undefined,
        paymentMethod,
      }),
    onSuccess: (order) => {
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      toast.success(
        `Order #${order.orderNumber} sent to the kitchen — code ${order.orderNumber.slice(-3)}`,
      );
      setLines([]);
      setCustomerName('');
      setCustomerPhone('');
      setTableNumber('');
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiRequestError ? err.body.message : 'Could not create the order',
      ),
  });

  if (!restaurant) return null;

  return (
    <>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.5fr_1fr]">
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

          <div className="max-h-[calc(100vh-16rem)] space-y-6 overflow-y-auto p-4">
            {grouped.length === 0 && (
              <p className="py-16 text-center text-sm text-muted-foreground">Loading the menu…</p>
            )}
            {shownGroups.map(({ category, products: items }) => (
              <div key={category.id}>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  {category.name}
                </h3>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
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
        <Card className="flex max-h-[calc(100vh-11rem)] flex-col">
          <div className="border-b p-4">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
              Ticket
            </h2>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
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
            <div className="grid grid-cols-2 gap-2">
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
            </div>

            {fulfillment === 'DINE_IN' && (
              <Input
                placeholder="Table number"
                value={tableNumber}
                onChange={(e) => setTableNumber(e.target.value)}
              />
            )}

            <div className="grid grid-cols-2 gap-2">
              <Input
                placeholder="Name (optional)"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
              />
              <Input
                type="tel"
                placeholder="Phone (optional)"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
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
                Card terminal
              </Button>
            </div>

            <div className="flex items-center justify-between text-base font-semibold">
              <span>Total</span>
              <span className="tabular-nums">{formatMoney(totalCents, restaurant.currency)}</span>
            </div>

            <Button
              className="w-full"
              size="lg"
              disabled={lines.length === 0 || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? 'Sending to kitchen…' : 'Confirm — paid, send to kitchen'}
            </Button>
          </div>
        </Card>
      </div>

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
