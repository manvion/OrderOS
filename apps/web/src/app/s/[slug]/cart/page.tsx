'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useQuery } from '@tanstack/react-query';
import { Minus, Plus, ShoppingBag, Tag, Trash2, Utensils, X } from 'lucide-react';
import { toast } from 'sonner';
import { formatMoney } from '@dinedirect/shared';
import { ApiRequestError, storefrontApi } from '@/lib/api';
import { useCart, useCartTotals } from '@/lib/cart-store';
import { useTenant, useTenantHref } from '@/components/storefront/tenant-provider';
import { useT } from '@/components/storefront/i18n-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

export default function CartPage() {
  const restaurant = useTenant();
  const href = useTenantHref();
  const t = useT();
  const lines = useCart((s) => s.lines);
  const setQuantity = useCart((s) => s.setQuantity);
  const removeLine = useCart((s) => s.removeLine);
  const fulfillment = useCart((s) => s.fulfillment);
  const tableNumber = useCart((s) => s.tableNumber);
  const clear = useCart((s) => s.clear);
  const promoCode = useCart((s) => s.promoCode);
  const promoDiscountCents = useCart((s) => s.promoDiscountCents);
  const setPromo = useCart((s) => s.setPromo);
  const totals = useCartTotals(restaurant);

  const [promoInput, setPromoInput] = useState('');
  const [applyingPromo, setApplyingPromo] = useState(false);
  const [addingToTab, setAddingToTab] = useState(false);

  // If this table already has an order running, offer to add to that same tab (one bill)
  // rather than opening a second ticket. Only relevant for a dine-in scan with a table.
  const { data: openTab } = useQuery({
    queryKey: ['open-tab', restaurant.slug, tableNumber],
    queryFn: () => storefrontApi.getOpenTab(restaurant.slug, tableNumber!),
    enabled: fulfillment === 'DINE_IN' && !!tableNumber,
    staleTime: 15_000,
  });
  const tab = openTab?.tab ?? null;

  const addToTab = async () => {
    if (!tab) return;
    setAddingToTab(true);
    try {
      const items = lines.map((l) => ({
        productId: l.productId,
        quantity: l.quantity,
        notes: l.notes,
        modifierIds: l.modifiers.map((m) => m.modifierId),
      }));
      await storefrontApi.addTabItems(restaurant.slug, tab.id, { items });
      clear();
      window.location.href = `${window.location.pathname.replace(/\/cart\/?$/, '')}/track/${tab.trackingToken}?placed=1`;
    } catch (err) {
      setAddingToTab(false);
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not add to your tab');
    }
  };

  const applyPromo = async () => {
    const code = promoInput.trim();
    if (!code || !totals) return;
    setApplyingPromo(true);
    try {
      const items = lines.map((l) => ({
        productId: l.productId,
        lineTotalCents:
          (l.unitPriceCents + l.modifiers.reduce((s, m) => s + m.priceCents, 0)) * l.quantity,
      }));
      const { discountCents } = await storefrontApi.previewPromotion(restaurant.slug, items, code);
      setPromo(code, discountCents);
      setPromoInput('');
      toast.success(`Code applied — you saved ${formatMoney(discountCents, restaurant.currency)}`);
    } catch (err) {
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not apply that code');
    } finally {
      setApplyingPromo(false);
    }
  };

  if (lines.length === 0) {
    return (
      <div className="container flex flex-col items-center py-24 text-center">
        <ShoppingBag className="h-12 w-12 text-muted-foreground" />
        <h1 className="mt-6 text-xl font-semibold">{t.cart.empty}</h1>
        <p className="mt-2 text-muted-foreground">{t.cart.emptyHint}</p>
        <Button asChild variant="brand" className="mt-6">
          <Link href={href('/menu')}>{t.cart.browseMenu}</Link>
        </Button>
      </div>
    );
  }

  // The minimum only applies to DELIVERY — pickup and dine-in are never blocked.
  const belowMinimum =
    fulfillment === 'DELIVERY' && (totals?.subtotalCents ?? 0) < restaurant.minOrderCents;

  return (
    <div className="container max-w-2xl py-8 pb-32">
      <h1 className="text-2xl font-bold tracking-tight">{t.cart.title}</h1>

      <div className="mt-6 space-y-3">
        {lines.map((line) => {
          const unitWithModifiers =
            line.unitPriceCents + line.modifiers.reduce((s, m) => s + m.priceCents, 0);

          return (
            <Card key={line.lineId}>
              <CardContent className="flex gap-4 p-4">
                {line.imageUrl && (
                  <Image
                    src={line.imageUrl}
                    alt={line.name}
                    width={64}
                    height={64}
                    className="h-16 w-16 shrink-0 rounded-lg object-cover"
                  />
                )}

                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <h2 className="font-medium">{line.name}</h2>
                    <span className="shrink-0 font-semibold tabular-nums">
                      {formatMoney(unitWithModifiers * line.quantity, restaurant.currency)}
                    </span>
                  </div>

                  {line.modifiers.length > 0 && (
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {line.modifiers.map((m) => m.name).join(', ')}
                    </p>
                  )}
                  {line.notes && (
                    <p className="mt-0.5 text-sm italic text-muted-foreground">“{line.notes}”</p>
                  )}

                  <div className="mt-3 flex items-center gap-2">
                    <div className="flex items-center rounded-lg border">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setQuantity(line.lineId, line.quantity - 1)}
                        aria-label="Decrease quantity"
                      >
                        <Minus className="h-3.5 w-3.5" />
                      </Button>
                      <span className="w-8 text-center text-sm font-medium tabular-nums">
                        {line.quantity}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setQuantity(line.lineId, line.quantity + 1)}
                        aria-label="Increase quantity"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </Button>
                    </div>

                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => removeLine(line.lineId)}
                      aria-label={`Remove ${line.name}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {totals && (
        <Card className="mt-6">
          <CardContent className="space-y-4 p-6 text-sm">
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t.cart.subtotal}</span>
                <span className="tabular-nums">
                  {formatMoney(totals.subtotalCents, restaurant.currency)}
                </span>
              </div>
              {promoDiscountCents > 0 && (
                <div className="flex justify-between text-brand">
                  <span className="font-medium">
                    {t.cart.discount}{promoCode ? ` · ${promoCode.toUpperCase()}` : ''}
                  </span>
                  <span className="tabular-nums">
                    -{formatMoney(promoDiscountCents, restaurant.currency)}
                  </span>
                </div>
              )}
            </div>

            {promoCode && promoDiscountCents > 0 ? (
              <div className="flex items-center justify-between rounded-lg bg-brand-subtle px-3 py-2">
                <span className="flex items-center gap-2 text-sm font-medium text-brand">
                  <Tag className="h-3.5 w-3.5" />
                  {promoCode.toUpperCase()} {t.cart.applied}
                </span>
                <button
                  onClick={() => {
                    setPromo(null, 0);
                    toast('Code removed');
                  }}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label="Remove promo code"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <div className="flex gap-2">
                <Input
                  value={promoInput}
                  onChange={(e) => setPromoInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && applyPromo()}
                  placeholder={t.cart.promoCode}
                  className="uppercase placeholder:normal-case"
                />
                <Button
                  variant="outline"
                  onClick={applyPromo}
                  disabled={!promoInput.trim() || applyingPromo}
                >
                  {applyingPromo ? t.cart.checking : t.cart.apply}
                </Button>
              </div>
            )}

            <p className="text-xs text-muted-foreground">{t.cart.feesNote}</p>
          </CardContent>
        </Card>
      )}

      {/* Add more items — visible on every size (the footer's copy is desktop-only). */}
      <Button asChild variant="outline" className="mt-4 w-full">
        <Link href={href('/menu')}>
          <Plus className="h-4 w-4" />
          {t.cart.addMore}
        </Link>
      </Button>

      {/* A delivery minimum is a hint here, never a block — the customer picks pickup
          or delivery on the next screen, so we can't decide it for them yet. */}
      {belowMinimum && (
        <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          {t.cart.minPrefix} {formatMoney(restaurant.minOrderCents, restaurant.currency)}{' '}
          {t.cart.minSuffix}
        </p>
      )}

      {/* This table already has a tab running — offer to add to it rather than checkout. */}
      {tab && (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-brand/30 bg-brand-subtle/40 p-4">
          <Utensils className="mt-0.5 h-5 w-5 shrink-0 text-brand" />
          <div className="text-sm">
            <p className="font-semibold">
              Table {tab.tableNumber} has an open tab (order #{tab.orderNumber})
            </p>
            <p className="text-muted-foreground">
              Add these to your table&apos;s bill — {formatMoney(tab.totalCents, restaurant.currency)}{' '}
              so far. One bill, settle it all at the end.
            </p>
          </div>
        </div>
      )}

      {/* Sticky footer: on a phone the cart scrolls, and the checkout button must
          never be the thing you have to scroll to find. */}
      <div className="fixed inset-x-0 bottom-0 border-t bg-background/95 p-4 backdrop-blur">
        <div className="container flex max-w-2xl items-center gap-4 px-0">
          <Button asChild variant="outline" className="hidden sm:flex">
            <Link href={href('/menu')}>{t.cart.addMore}</Link>
          </Button>
          {tab ? (
            <Button
              variant="brand"
              size="lg"
              className="flex-1"
              disabled={addingToTab}
              onClick={addToTab}
            >
              {addingToTab
                ? 'Adding…'
                : `Add to Table ${tab.tableNumber} tab · ${formatMoney(
                    (totals?.subtotalCents ?? 0) - (totals?.discountCents ?? 0),
                    restaurant.currency,
                  )}`}
            </Button>
          ) : (
            <Button asChild variant="brand" size="lg" className="flex-1">
              <Link href={href('/checkout')}>
                {t.cart.checkout} ·{' '}
                {formatMoney(
                  (totals?.subtotalCents ?? 0) - (totals?.discountCents ?? 0),
                  restaurant.currency,
                )}
              </Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
