'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Minus, Plus, ShoppingBag, Trash2, UtensilsCrossed } from 'lucide-react';
import { toast } from 'sonner';
import { formatMoney } from '@dinedirect/shared';
import { useApi, useDashboard } from './dashboard-provider';
import { ApiRequestError, type MenuModifierGroup, type Product } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, Label } from '@/components/ui/primitives';

/**
 * A walk-in or phone order, built at the counter and paid in person.
 *
 * Deliberately NOT built on the customer cart (@/lib/cart-store): that store is
 * the customer's own session, and a staff member ringing up a walk-in on the
 * same browser a customer might be using (a shared iPad at the counter) must
 * never see or touch it. This dialog owns its cart as plain local state.
 *
 * No delivery: a walk-in has no address to speak of, and a phone order paid at
 * the counter has no courier to hand cash to. Pickup and dine-in only.
 */

export type ConfiguredLine = {
  /** productId + a stable key of chosen modifier ids -- lets the same item with
   *  a DIFFERENT configuration sit as its own line instead of merging quantities
   *  that don't actually match. */
  key: string;
  productId: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
  modifierIds: string[];
  modifierLabel: string;
  modifiersCents: number;
};

export function WalkInOrderDialog({
  open,
  onOpenChange,
  tabOrder,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * When set, this dialog runs in "add to tab" mode: the item picker is identical,
   * but instead of ringing up a new paid walk-in it appends the chosen items to an
   * existing open dine-in order (a running table tab). The customer/fulfillment/payment
   * fields are hidden — those belong to the original ticket, not this extra round.
   */
  tabOrder?: { id: string; orderNumber: string; tableNumber: string | null } | null;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { restaurant } = useDashboard();
  const isTab = !!tabOrder;

  const { data: categories } = useQuery({
    queryKey: ['menu', 'categories'],
    queryFn: () => api.listCategories(),
    enabled: open,
  });
  const { data: products } = useQuery({
    queryKey: ['menu', 'products'],
    queryFn: () => api.listProducts(),
    enabled: open,
  });

  const [lines, setLines] = useState<ConfiguredLine[]>([]);
  const [configuring, setConfiguring] = useState<Product | null>(null);
  const [fulfillment, setFulfillment] = useState<'PICKUP' | 'DINE_IN'>('PICKUP');
  const [tableNumber, setTableNumber] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
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

  const addConfiguredLine = (line: ConfiguredLine) => setLines((prev) => [...prev, line]);

  const setQuantity = (key: string, quantity: number) => {
    if (quantity <= 0) {
      setLines((prev) => prev.filter((l) => l.key !== key));
      return;
    }
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, quantity } : l)));
  };

  const itemsPayload = () =>
    lines.map((l) => ({
      productId: l.productId,
      quantity: l.quantity,
      modifierIds: l.modifierIds,
    }));

  const create = useMutation({
    mutationFn: () =>
      isTab
        ? api.addTabItems(tabOrder!.id, itemsPayload())
        : api.createWalkInOrder({
            items: itemsPayload(),
            fulfillment,
            customerName: customerName.trim() || undefined,
            customerPhone: customerPhone.trim() || undefined,
            customerEmail: customerEmail.trim() || undefined,
            tableNumber: fulfillment === 'DINE_IN' ? tableNumber.trim() || undefined : undefined,
            paymentMethod,
          }),
    onSuccess: (order) => {
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      toast.success(
        isTab
          ? `Added to tab #${order.orderNumber} — sent to the kitchen`
          : `Order #${order.orderNumber} sent to the kitchen — code ${order.orderNumber.slice(-3)}`,
      );
      setLines([]);
      setCustomerName('');
      setCustomerPhone('');
      setTableNumber('');
      onOpenChange(false);
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiRequestError
          ? err.body.message
          : isTab
            ? 'Could not add to the tab'
            : 'Could not create the order',
      ),
  });

  if (!restaurant) return null;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-3xl gap-0 p-0">
          <DialogHeader className="border-b p-5">
            <DialogTitle>
              {isTab
                ? `Add to ${tabOrder!.tableNumber ? `Table ${tabOrder!.tableNumber}` : `#${tabOrder!.orderNumber}`} tab`
                : 'New walk-in / phone order'}
            </DialogTitle>
          </DialogHeader>

          <div className="grid max-h-[70vh] grid-cols-1 sm:grid-cols-[1.3fr_1fr]">
            {/* Menu picker */}
            <div className="max-h-[70vh] space-y-6 overflow-y-auto border-r p-5">
              {grouped.length === 0 && (
                <p className="py-10 text-center text-sm text-muted-foreground">Loading the menu…</p>
              )}
              {grouped.map(({ category, products: items }) => (
                <div key={category.id}>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                    {category.name}
                  </h3>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {items.map((product) => (
                      <button
                        key={product.id}
                        type="button"
                        onClick={() => addLine(product)}
                        className="flex items-center justify-between gap-2 rounded-xl border p-3 text-left text-sm transition-colors hover:border-brand-subtle hover:bg-brand-subtle"
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{product.name}</span>
                          <span className="text-xs text-muted-foreground">
                            {formatMoney(product.priceCents, restaurant.currency)}
                            {product.modifierGroups.length > 0 ? ' · options' : ''}
                          </span>
                        </span>
                        <Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Running order + details */}
            <div className="flex max-h-[70vh] flex-col">
              <div className="flex-1 space-y-3 overflow-y-auto p-5">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  Order
                </h3>

                {lines.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    Tap an item to add it.
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
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setQuantity(line.key, line.quantity - 1)}
                            className="flex h-6 w-6 items-center justify-center rounded-md border text-muted-foreground hover:bg-accent"
                          >
                            <Minus className="h-3 w-3" />
                          </button>
                          <span className="w-4 text-center tabular-nums">{line.quantity}</span>
                          <button
                            type="button"
                            onClick={() => setQuantity(line.key, line.quantity + 1)}
                            className="flex h-6 w-6 items-center justify-center rounded-md border text-muted-foreground hover:bg-accent"
                          >
                            <Plus className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setQuantity(line.key, 0)}
                            className="ml-1 text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                <div className={isTab ? 'hidden' : 'border-t pt-3'}>
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
                      className="mt-2"
                      placeholder="Table number"
                      value={tableNumber}
                      onChange={(e) => setTableNumber(e.target.value)}
                    />
                  )}

                  <Input
                    className="mt-2"
                    placeholder="Customer name (optional)"
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                  />
                  <Input
                    className="mt-2"
                    type="tel"
                    placeholder="Phone (optional — needed for phone orders)"
                    value={customerPhone}
                    onChange={(e) => setCustomerPhone(e.target.value)}
                  />
                  <Input
                    className="mt-2"
                    type="email"
                    placeholder="Email (optional — sends a receipt)"
                    value={customerEmail}
                    onChange={(e) => setCustomerEmail(e.target.value)}
                  />

                  <div className="mt-3 space-y-1.5">
                    <Label className="text-xs">Paid with</Label>
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
                  </div>
                </div>
              </div>

              <div className="border-t p-5">
                <div className="mb-3 flex items-center justify-between font-semibold">
                  <span>Total</span>
                  <span className="tabular-nums">{formatMoney(totalCents, restaurant.currency)}</span>
                </div>
                <Button
                  className="w-full"
                  size="lg"
                  disabled={lines.length === 0 || create.isPending}
                  onClick={() => create.mutate()}
                >
                  {create.isPending
                    ? isTab
                      ? 'Adding…'
                      : 'Sending to kitchen…'
                    : isTab
                      ? 'Add to tab — send to kitchen'
                      : 'Confirm — paid, send to kitchen'}
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {configuring && (
        <ModifierConfigurator
          product={configuring}
          currency={restaurant.currency}
          onCancel={() => setConfiguring(null)}
          onConfirm={(line) => {
            addConfiguredLine(line);
            setConfiguring(null);
          }}
        />
      )}
    </>
  );
}

/** A minimal, local-state-only modifier picker -- see the file header for why
 *  this doesn't reuse the customer-facing ProductDialog. Exported so the full-screen
 *  POS (dashboard/pos) rings up options the exact same way the walk-in dialog does. */
export function ModifierConfigurator({
  product,
  currency,
  onCancel,
  onConfirm,
}: {
  product: Product;
  currency: string;
  onCancel: () => void;
  onConfirm: (line: ConfiguredLine) => void;
}) {
  const [selections, setSelections] = useState<Record<string, string[]>>({});

  const toggle = (group: MenuModifierGroup, modifierId: string) => {
    setSelections((prev) => {
      const current = prev[group.id] ?? [];
      if (group.selectionType === 'SINGLE') {
        return { ...prev, [group.id]: current.includes(modifierId) ? [] : [modifierId] };
      }
      const next = current.includes(modifierId)
        ? current.filter((id) => id !== modifierId)
        : current.length < group.maxSelections
          ? [...current, modifierId]
          : current;
      return { ...prev, [group.id]: next };
    });
  };

  const missingRequired = product.modifierGroups.find(
    (g) => g.required && (selections[g.id]?.length ?? 0) < Math.max(1, g.minSelections),
  );

  const chosen = product.modifierGroups.flatMap((g) =>
    (selections[g.id] ?? []).map((id) => g.modifiers.find((m) => m.id === id)!).filter(Boolean),
  );
  const modifiersCents = chosen.reduce((s, m) => s + m.priceCents, 0);

  return (
    <Dialog open onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{product.name}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {product.modifierGroups.map((group) => (
            <div key={group.id}>
              <p className="text-sm font-semibold">
                {group.name}
                {group.required && <span className="ml-1 text-xs text-destructive">Required</span>}
              </p>
              <div className="mt-2 space-y-1.5">
                {group.modifiers.map((modifier) => {
                  const active = (selections[group.id] ?? []).includes(modifier.id);
                  return (
                    <button
                      key={modifier.id}
                      type="button"
                      onClick={() => toggle(group, modifier.id)}
                      className={`flex w-full items-center justify-between rounded-lg border p-2.5 text-left text-sm transition-colors ${
                        active ? 'border-brand-subtle bg-brand-subtle' : 'hover:bg-accent/50'
                      }`}
                    >
                      {modifier.name}
                      {modifier.priceCents > 0 && (
                        <span className="text-xs text-muted-foreground">
                          +{formatMoney(modifier.priceCents, currency)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <Button
          disabled={Boolean(missingRequired)}
          onClick={() =>
            onConfirm({
              key: `${product.id}:${chosen.map((m) => m.id).sort().join(',')}`,
              productId: product.id,
              name: product.name,
              unitPriceCents: product.priceCents,
              quantity: 1,
              modifierIds: chosen.map((m) => m.id),
              modifierLabel: chosen.map((m) => m.name).join(', '),
              modifiersCents,
            })
          }
        >
          Add — {formatMoney(product.priceCents + modifiersCents, currency)}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
