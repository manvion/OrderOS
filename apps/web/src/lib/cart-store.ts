'use client';

import { useEffect } from 'react';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { priceOrder, type PricingResult } from '@dinedirect/shared';
import { storefrontApi, type MenuProduct, type StorefrontRestaurant } from './api';

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
    // Named components (GST/QST) win when present, so the preview itemises tax the
    // same way the receipt does; taxRateBps stays as the single-rate fallback.
    taxComponents: restaurant.taxComponents ?? undefined,
    taxDeliveryFee: restaurant.taxDeliveryFee,
    fulfillment,
    deliveryFeeCents: deliveryFeeOverrideCents ?? restaurant.deliveryFeeCents,
    serviceFeeCents: restaurant.serviceFeeCents,
    serviceChargeType: restaurant.serviceChargeType,
    serviceChargeCents: restaurant.serviceChargeCents,
    serviceChargeBps: restaurant.serviceChargeBps,
    tipCents,
    discountCents: promoDiscountCents,
  });
}

/**
 * Keeps the cart's discount in sync with the server as items change — including
 * AUTO-APPLY promotions that carry no code.
 *
 * Without this, the only way a discount reached the summary was a customer manually
 * entering a promo code; an automatic "10% off" the restaurant set up would silently
 * apply at order creation (resolveDiscount always includes code-less promotions) but
 * never show in the checkout total — the customer saw the full price, then a discounted
 * receipt. This previews the exact same resolution the order uses, so the summary matches
 * what they'll actually be charged. Re-runs whenever the cart or the applied code changes
 * (cart edits reset the stored discount to 0; this restores the correct figure).
 */
export function useSyncedDiscount(restaurant: Pick<StorefrontRestaurant, 'slug'> | null): void {
  const lines = useCart((s) => s.lines);
  const promoCode = useCart((s) => s.promoCode);
  const setPromo = useCart((s) => s.setPromo);
  const slug = restaurant?.slug;

  useEffect(() => {
    if (!slug || lines.length === 0) return;
    let cancelled = false;
    const items = lines.map((l) => ({
      productId: l.productId,
      lineTotalCents:
        (l.unitPriceCents + l.modifiers.reduce((s, m) => s + m.priceCents, 0)) * l.quantity,
    }));
    storefrontApi
      .previewPromotion(slug, items, promoCode ?? undefined)
      .then(({ discountCents }) => {
        // Keep the applied code as-is; only the amount is server-owned. A code-less
        // auto promo lands here with promoCode null and a positive discount.
        if (!cancelled) setPromo(promoCode, discountCents);
      })
      .catch(() => {
        // A now-invalid code (e.g. expired mid-session) just leaves the discount untouched.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, promoCode, JSON.stringify(lines.map((l) => [l.productId, l.quantity, l.modifiers.length]))]);
}
