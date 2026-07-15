'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { priceOrder, type PricingResult } from '@dinedirect/shared';
import type { MenuProduct, StorefrontRestaurant } from './api';

export interface CartLine {
  /** Stable id for this configured line — the same product with different
   *  modifiers is a different line, so we can't key on productId alone. */
  lineId: string;
  productId: string;
  name: string;
  unitPriceCents: number;
  imageUrl: string | null;
  quantity: number;
  notes?: string;
  modifiers: Array<{ modifierId: string; name: string; priceCents: number; groupId: string }>;
}

interface CartState {
  /** Carts are per-restaurant: ordering from Joe's must not show Bella's items. */
  restaurantSlug: string | null;
  lines: CartLine[];
  fulfillment: 'PICKUP' | 'DELIVERY' | 'DINE_IN';
  tipCents: number;
  tableNumber: string | null;
  qrCodeId: string | null;
  /** Entered at the cart page. Re-validated server-side at checkout — never trusted client-side. */
  promoCode: string | null;
  /** The server's answer to "how much does that code save", cached so the cart
   *  can show it without re-asking on every render. Cleared whenever the cart
   *  contents change, so a stale discount can never linger past the order it
   *  was computed for. */
  promoDiscountCents: number;

  addLine: (product: MenuProduct, modifiers: CartLine['modifiers'], quantity: number, notes?: string) => void;
  removeLine: (lineId: string) => void;
  setQuantity: (lineId: string, quantity: number) => void;
  setFulfillment: (f: CartState['fulfillment']) => void;
  setTip: (cents: number) => void;
  setTableContext: (tableNumber: string | null, qrCodeId: string | null) => void;
  setPromo: (code: string | null, discountCents: number) => void;
  ensureRestaurant: (slug: string) => void;
  clear: () => void;

  itemCount: () => number;
  subtotalCents: () => number;
}

/**
 * Two configurations of the same product are the same line only if their
 * modifier sets match exactly. Sorting first makes the key order-independent, so
 * {cheese, bacon} and {bacon, cheese} correctly merge into one line with qty 2.
 */
function lineKey(productId: string, modifierIds: string[]): string {
  return `${productId}::${[...modifierIds].sort().join(',')}`;
}

export const useCart = create<CartState>()(
  persist(
    (set, get) => ({
      restaurantSlug: null,
      lines: [],
      fulfillment: 'PICKUP',
      tipCents: 0,
      tableNumber: null,
      qrCodeId: null,
      promoCode: null,
      promoDiscountCents: 0,

      /**
       * Drop the cart if the customer has moved to a different restaurant.
       * Called on every storefront page load. Without this, a persisted cart from
       * Joe's would show up on Bella's checkout and every product id would 400.
       */
      ensureRestaurant: (slug) => {
        if (get().restaurantSlug !== slug) {
          set({
            restaurantSlug: slug,
            lines: [],
            tipCents: 0,
            tableNumber: null,
            qrCodeId: null,
            promoCode: null,
            promoDiscountCents: 0,
            fulfillment: 'PICKUP',
          });
        }
      },

      addLine: (product, modifiers, quantity, notes) => {
        const key = lineKey(product.id, modifiers.map((m) => m.modifierId));
        const existing = get().lines.find(
          (l) => lineKey(l.productId, l.modifiers.map((m) => m.modifierId)) === key && l.notes === notes,
        );

        if (existing) {
          set({
            lines: get().lines.map((l) =>
              l.lineId === existing.lineId
                ? { ...l, quantity: Math.min(99, l.quantity + quantity) }
                : l,
            ),
            promoDiscountCents: 0,
          });
          return;
        }

        set({
          lines: [
            ...get().lines,
            {
              lineId: `${key}::${Date.now()}`,
              productId: product.id,
              name: product.name,
              unitPriceCents: product.priceCents,
              imageUrl: product.imageUrl,
              quantity,
              notes,
              modifiers,
            },
          ],
          promoDiscountCents: 0,
        });
      },

      removeLine: (lineId) =>
        set({ lines: get().lines.filter((l) => l.lineId !== lineId), promoDiscountCents: 0 }),

      setQuantity: (lineId, quantity) => {
        if (quantity <= 0) {
          set({ lines: get().lines.filter((l) => l.lineId !== lineId), promoDiscountCents: 0 });
          return;
        }
        set({
          lines: get().lines.map((l) =>
            l.lineId === lineId ? { ...l, quantity: Math.min(99, quantity) } : l,
          ),
          promoDiscountCents: 0,
        });
      },

      setFulfillment: (fulfillment) => set({ fulfillment }),
      setTip: (tipCents) => set({ tipCents: Math.max(0, tipCents) }),
      setTableContext: (tableNumber, qrCodeId) =>
        set({
          tableNumber,
          qrCodeId,
          // Arriving via a table QR means the customer is sitting in the dining
          // room. Defaulting them to pickup would be absurd.
          ...(tableNumber ? { fulfillment: 'DINE_IN' as const } : {}),
        }),
      setPromo: (promoCode, promoDiscountCents) => set({ promoCode, promoDiscountCents }),

      clear: () =>
        set({
          lines: [],
          tipCents: 0,
          tableNumber: null,
          qrCodeId: null,
          promoCode: null,
          promoDiscountCents: 0,
        }),

      itemCount: () => get().lines.reduce((sum, l) => sum + l.quantity, 0),
      subtotalCents: () =>
        get().lines.reduce(
          (sum, l) =>
            sum +
            (l.unitPriceCents + l.modifiers.reduce((s, m) => s + m.priceCents, 0)) * l.quantity,
          0,
        ),
    }),
    {
      name: 'dinedirect-cart',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

/**
 * The cart's live total, computed with the SAME function the API uses to bill.
 * If these two ever disagree, it's a bug in one place, not two — which is exactly
 * why the pricing engine lives in @dinedirect/shared.
 *
 * `deliveryFeeCents` is passed in because it can come from a live Uber quote
 * rather than the restaurant's default.
 */
export function useCartTotals(
  restaurant: StorefrontRestaurant | null,
  deliveryFeeOverrideCents?: number,
): PricingResult | null {
  const lines = useCart((s) => s.lines);
  const fulfillment = useCart((s) => s.fulfillment);
  const tipCents = useCart((s) => s.tipCents);
  const promoDiscountCents = useCart((s) => s.promoDiscountCents);

  if (!restaurant) return null;

  return priceOrder({
    items: lines.map((l) => ({
      productId: l.productId,
      name: l.name,
      unitPriceCents: l.unitPriceCents,
      quantity: l.quantity,
      modifiers: l.modifiers.map((m) => ({
        modifierId: m.modifierId,
        name: m.name,
        priceCents: m.priceCents,
        quantity: 1,
      })),
    })),
    taxRateBps: restaurant.taxRateBps,
    fulfillment,
    deliveryFeeCents: deliveryFeeOverrideCents ?? restaurant.deliveryFeeCents,
    serviceFeeCents: restaurant.serviceFeeCents,
    tipCents,
    discountCents: promoDiscountCents,
  });
}
