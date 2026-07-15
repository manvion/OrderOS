'use client';

import { useMemo, useState } from 'react';
import Image from 'next/image';
import { Minus, Plus } from 'lucide-react';
import { formatMoney } from '@dinedirect/shared';
import type { MenuProduct } from '@/lib/api';
import { useCart, type CartLine } from '@/lib/cart-store';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import {
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/primitives';
import { toast } from 'sonner';

/**
 * Configure a product and add it to the cart.
 *
 * The validation here mirrors the server's exactly (OrdersService.resolveLineItems):
 * required groups need a choice, SINGLE groups take one, MULTIPLE groups respect
 * maxSelections. The server re-checks all of it — this exists so the customer
 * finds out before they reach Stripe, not after.
 */
export function ProductDialog({
  product,
  currency,
  open,
  onOpenChange,
  onAdded,
}: {
  product: MenuProduct;
  currency: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired on a successful add. The widget uses it to record an ADD_TO_CART event. */
  onAdded?: () => void;
}) {
  const addLine = useCart((s) => s.addLine);

  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState('');
  /** groupId -> selected modifier ids */
  const [selections, setSelections] = useState<Record<string, string[]>>({});

  const toggleModifier = (groupId: string, modifierId: string, isSingle: boolean, max: number) => {
    setSelections((prev) => {
      const current = prev[groupId] ?? [];

      if (isSingle) {
        // Radio behaviour: replace, never accumulate.
        return { ...prev, [groupId]: [modifierId] };
      }

      if (current.includes(modifierId)) {
        return { ...prev, [groupId]: current.filter((id) => id !== modifierId) };
      }

      if (current.length >= max) {
        toast.error(`You can pick at most ${max}`);
        return prev;
      }

      return { ...prev, [groupId]: [...current, modifierId] };
    });
  };

  /** Which required groups the customer still hasn't answered. */
  const missingGroups = useMemo(
    () =>
      product.modifierGroups.filter((group) => {
        const count = (selections[group.id] ?? []).length;
        const min = group.required ? Math.max(1, group.minSelections) : group.minSelections;
        return count < min;
      }),
    [product.modifierGroups, selections],
  );

  const selectedModifiers: CartLine['modifiers'] = useMemo(
    () =>
      product.modifierGroups.flatMap((group) =>
        (selections[group.id] ?? []).flatMap((modifierId) => {
          const modifier = group.modifiers.find((m) => m.id === modifierId);
          return modifier
            ? [
                {
                  modifierId: modifier.id,
                  name: modifier.name,
                  priceCents: modifier.priceCents,
                  groupId: group.id,
                },
              ]
            : [];
        }),
      ),
    [product.modifierGroups, selections],
  );

  const unitTotal =
    product.priceCents + selectedModifiers.reduce((sum, m) => sum + m.priceCents, 0);
  const lineTotal = unitTotal * quantity;

  const handleAdd = () => {
    if (missingGroups.length > 0) {
      toast.error(`Please choose a ${missingGroups[0].name.toLowerCase()}`);
      return;
    }
    addLine(product, selectedModifiers, quantity, notes.trim() || undefined);
    toast.success(`${quantity} × ${product.name} added`);
    onAdded?.();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0">
        {product.imageUrl && (
          <div className="relative h-52 w-full overflow-hidden rounded-t-xl">
            <Image src={product.imageUrl} alt={product.name} fill className="object-cover" />
            {product.promoLabel && (
              <span className="absolute left-3 top-3 rounded-md bg-red-600 px-2 py-1 text-xs font-bold tracking-wide text-white shadow-soft">
                {product.promoLabel}
              </span>
            )}
          </div>
        )}

        <div className="space-y-6 p-6">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <DialogTitle>{product.name}</DialogTitle>
              {!product.imageUrl && product.promoLabel && (
                <span className="rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold tracking-wide text-white">
                  {product.promoLabel}
                </span>
              )}
            </div>
            {product.description && (
              <DialogDescription>{product.description}</DialogDescription>
            )}
          </DialogHeader>

          {product.modifierGroups.map((group) => {
            const chosen = selections[group.id] ?? [];
            const isSingle = group.selectionType === 'SINGLE';

            return (
              <fieldset key={group.id} className="space-y-2">
                <legend className="flex w-full items-center justify-between pb-2">
                  <span className="font-medium">{group.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {group.required ? 'Required' : `Optional · up to ${group.maxSelections}`}
                  </span>
                </legend>

                <div className="space-y-1">
                  {group.modifiers.map((modifier) => {
                    const checked = chosen.includes(modifier.id);
                    return (
                      <label
                        key={modifier.id}
                        className="flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-accent/50 has-[:checked]:border-brand"
                      >
                        <Checkbox
                          // Radio semantics for SINGLE groups, checkbox for MULTIPLE.
                          // Same visual control either way, which keeps the row layout
                          // identical and the tap target the whole row.
                          checked={checked}
                          onChange={() =>
                            toggleModifier(group.id, modifier.id, isSingle, group.maxSelections)
                          }
                          className={isSingle ? 'rounded-full' : ''}
                        />
                        <span className="flex-1 text-sm">{modifier.name}</span>
                        {modifier.priceCents > 0 && (
                          <span className="text-sm text-muted-foreground">
                            +{formatMoney(modifier.priceCents, currency)}
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            );
          })}

          <div className="space-y-2">
            <label htmlFor="notes" className="text-sm font-medium">
              Special requests
            </label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="No onions, extra napkins…"
              maxLength={280}
              className="min-h-[60px]"
            />
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center rounded-lg border">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                disabled={quantity <= 1}
                aria-label="Decrease quantity"
              >
                <Minus className="h-4 w-4" />
              </Button>
              <span className="w-10 text-center font-medium tabular-nums">{quantity}</span>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setQuantity((q) => Math.min(99, q + 1))}
                disabled={quantity >= 99}
                aria-label="Increase quantity"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>

            <Button variant="brand" size="lg" className="flex-1" onClick={handleAdd}>
              Add · {formatMoney(lineTotal, currency)}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
