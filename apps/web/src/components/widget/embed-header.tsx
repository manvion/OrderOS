'use client';

import Image from 'next/image';
import { ArrowLeft, ShoppingBag, X } from 'lucide-react';
import type { WidgetSettings } from '@orderos/shared';
import type { StorefrontRestaurant } from '@/lib/api';
import type { EmbedView } from './embed-app';

export function EmbedHeader({
  settings,
  restaurant,
  view,
  itemCount,
  onBack,
  onCart,
  onClose,
}: {
  settings: WidgetSettings;
  restaurant: StorefrontRestaurant;
  view: EmbedView;
  itemCount: number;
  onBack: () => void;
  onCart: () => void;
  onClose: () => void;
}) {
  const showBack = view === 'cart' || view === 'checkout';
  // Once the order is placed, going "back" to a cart we've already cleared would
  // be nonsense — and closing is the only sensible action left.
  const showCart = view === 'menu';

  return (
    <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
      {showBack ? (
        <button
          onClick={onBack}
          aria-label="Back"
          className="-ml-1 rounded-md p-1.5 hover:bg-accent"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
      ) : (
        settings.showLogo &&
        restaurant.logoUrl && (
          <Image
            src={restaurant.logoUrl}
            alt=""
            width={32}
            height={32}
            className="h-8 w-8 rounded-md object-cover"
          />
        )
      )}

      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold leading-tight">{restaurant.name}</p>
        <p className="text-xs text-muted-foreground">
          {restaurant.isOpen ? (
            <span className="text-emerald-600">Open now</span>
          ) : (
            'Closed'
          )}
          {restaurant.isOpen && ` · ready in ~${restaurant.prepTimeMinutes} min`}
        </p>
      </div>

      {showCart && itemCount > 0 && (
        <button
          onClick={onCart}
          aria-label={`Cart, ${itemCount} items`}
          className="relative rounded-md p-1.5 hover:bg-accent"
        >
          <ShoppingBag className="h-5 w-5" />
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-bold text-brand-foreground">
            {itemCount}
          </span>
        </button>
      )}

      <button onClick={onClose} aria-label="Close" className="rounded-md p-1.5 hover:bg-accent">
        <X className="h-5 w-5" />
      </button>
    </header>
  );
}
