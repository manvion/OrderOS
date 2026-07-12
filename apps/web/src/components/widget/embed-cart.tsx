'use client';

import { Minus, Plus, ShoppingBag, Trash2 } from 'lucide-react';
import { formatMoney } from '@orderos/shared';
import type { StorefrontRestaurant } from '@/lib/api';
import { useCart, useCartTotals } from '@/lib/cart-store';

export function EmbedCart({
  restaurant,
  onBrowse,
  onCheckout,
}: {
  restaurant: StorefrontRestaurant;
  onBrowse: () => void;
  onCheckout: () => void;
}) {
  const lines = useCart((s) => s.lines);
  const setQuantity = useCart((s) => s.setQuantity);
  const removeLine = useCart((s) => s.removeLine);
  const totals = useCartTotals(restaurant);

  if (lines.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 p-12 text-center">
        <ShoppingBag className="h-10 w-10 text-muted-foreground" />
        <p className="font-medium">Your cart is empty</p>
        <button onClick={onBrowse} className="text-sm font-medium underline">
          Browse the menu
        </button>
      </div>
    );
  }

  const subtotal = totals?.subtotalCents ?? 0;
  const belowMinimum = subtotal < restaurant.minOrderCents;

  return (
    <div className="flex flex-col p-4">
      <div className="space-y-3">
        {lines.map((line) => {
          const unit =
            line.unitPriceCents + line.modifiers.reduce((s, m) => s + m.priceCents, 0);

          return (
            <div key={line.lineId} className="flex gap-3 rounded-xl border p-3">
              <div className="min-w-0 flex-1">
                <div className="flex justify-between gap-2">
                  <p className="font-medium leading-tight">{line.name}</p>
                  <p className="shrink-0 font-semibold tabular-nums">
                    {formatMoney(unit * line.quantity, restaurant.currency)}
                  </p>
                </div>

                {line.modifiers.length > 0 && (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {line.modifiers.map((m) => m.name).join(', ')}
                  </p>
                )}
                {line.notes && (
                  <p className="mt-0.5 text-xs italic text-muted-foreground">“{line.notes}”</p>
                )}

                <div className="mt-2 flex items-center gap-2">
                  <div className="flex items-center rounded-lg border">
                    <button
                      onClick={() => setQuantity(line.lineId, line.quantity - 1)}
                      aria-label="Decrease quantity"
                      className="p-1.5 hover:bg-accent"
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </button>
                    <span className="w-7 text-center text-sm font-medium tabular-nums">
                      {line.quantity}
                    </span>
                    <button
                      onClick={() => setQuantity(line.lineId, line.quantity + 1)}
                      aria-label="Increase quantity"
                      className="p-1.5 hover:bg-accent"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <button
                    onClick={() => removeLine(line.lineId)}
                    aria-label={`Remove ${line.name}`}
                    className="p-1.5 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex justify-between border-t pt-4 text-sm">
        <span className="text-muted-foreground">Subtotal</span>
        <span className="font-semibold tabular-nums">
          {formatMoney(subtotal, restaurant.currency)}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Tax, fees and any tip are calculated at checkout.
      </p>

      {belowMinimum && (
        <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          Minimum order is {formatMoney(restaurant.minOrderCents, restaurant.currency)} — add{' '}
          {formatMoney(restaurant.minOrderCents - subtotal, restaurant.currency)} more to check out.
        </p>
      )}

      <button
        onClick={onCheckout}
        disabled={belowMinimum || !restaurant.acceptingOrders}
        className="mt-4 w-full rounded-lg bg-brand py-3 font-semibold text-brand-foreground disabled:opacity-50"
      >
        {!restaurant.acceptingOrders
          ? 'Currently closed'
          : belowMinimum
            ? 'Minimum not met'
            : `Checkout · ${formatMoney(subtotal, restaurant.currency)}`}
      </button>

      <button onClick={onBrowse} className="mt-2 w-full py-2 text-sm font-medium">
        Add more items
      </button>
    </div>
  );
}
