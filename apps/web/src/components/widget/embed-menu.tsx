'use client';

import { useState } from 'react';
import Image from 'next/image';
import { formatMoney } from '@orderos/shared';
import type { MenuCategory, MenuProduct, StorefrontRestaurant } from '@/lib/api';
import { ProductDialog } from '@/components/storefront/product-dialog';

/**
 * The menu, inside the widget.
 *
 * Reuses ProductDialog from the storefront verbatim — the modifier picker is the
 * fiddliest, most rule-laden UI in the product (required Size, capped Extras),
 * and maintaining a second copy of it for the widget is how the two silently
 * drift apart until only one of them enforces maxSelections.
 */
export function EmbedMenu({
  menu,
  restaurant,
  onAdded,
  onTrackExisting,
}: {
  menu: MenuCategory[];
  restaurant: StorefrontRestaurant;
  onAdded: () => void;
  /** Opens the "find my existing order" view. */
  onTrackExisting?: () => void;
}) {
  const [selected, setSelected] = useState<MenuProduct | null>(null);

  if (menu.length === 0) {
    return (
      <div className="p-8 text-center">
        <p className="font-medium">The menu isn&apos;t available right now</p>
        <p className="mt-1 text-sm text-muted-foreground">Please check back shortly.</p>
      </div>
    );
  }

  return (
    <div className="p-4">
      {!restaurant.isOpen && (
        <div className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          {restaurant.name} is closed right now.
          {restaurant.scheduledOrdersEnabled
            ? ' You can still schedule an order for later.'
            : ' You can browse, but orders open again when they do.'}
        </div>
      )}

      {menu.map((category) => (
        <section key={category.id} className="mb-6">
          <h2 className="mb-3 font-semibold">{category.name}</h2>

          <div className="space-y-2">
            {category.products.map((product) => (
              <button
                key={product.id}
                onClick={() => setSelected(product)}
                className="flex w-full gap-3 rounded-xl border p-3 text-left transition-colors hover:bg-accent/50"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium leading-tight">{product.name}</p>
                  {product.description && (
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                      {product.description}
                    </p>
                  )}
                  <p className="mt-1.5 text-sm font-semibold">
                    {formatMoney(product.priceCents, restaurant.currency)}
                  </p>
                </div>

                {product.imageUrl && (
                  <Image
                    src={product.imageUrl}
                    alt={product.name}
                    width={72}
                    height={72}
                    className="h-18 w-18 shrink-0 rounded-lg object-cover"
                    style={{ width: 72, height: 72 }}
                  />
                )}
              </button>
            ))}
          </div>
        </section>
      ))}

      {/*
        The way back to an existing order from inside the widget.
        A customer who closed the widget mid-delivery and reopened it would
        otherwise land on the menu with no route to the food they already paid for.
      */}
      {onTrackExisting && (
        <button
          onClick={onTrackExisting}
          className="mt-2 w-full rounded-xl border border-dashed p-3 text-center text-xs font-medium text-muted-foreground transition-colors hover:bg-accent"
        >
          Already ordered? Track it here
        </button>
      )}

      {selected && (
        <ProductDialog
          product={selected}
          currency={restaurant.currency}
          open
          onOpenChange={(open) => {
            if (!open) setSelected(null);
          }}
          onAdded={onAdded}
        />
      )}
    </div>
  );
}
