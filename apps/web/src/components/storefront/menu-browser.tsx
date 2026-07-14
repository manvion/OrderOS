'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { ArrowRight, Plus } from 'lucide-react';
import { formatMoney } from '@dinedirect/shared';
import type { MenuCategory, MenuProduct, StorefrontRestaurant } from '@/lib/api';
import { ProductDialog } from './product-dialog';
import { useCart } from '@/lib/cart-store';
import { useTenantHref } from './tenant-provider';

export function MenuBrowser({
  restaurant,
  menu,
}: {
  restaurant: StorefrontRestaurant;
  menu: MenuCategory[];
}) {
  const href = useTenantHref();
  const [selected, setSelected] = useState<MenuProduct | null>(null);
  const [activeCategory, setActiveCategory] = useState(menu[0]?.id ?? '');
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

  const lines = useCart((s) => s.lines);
  const itemCount = useCart((s) => s.itemCount());
  const subtotal = useCart((s) => s.subtotalCents());
  const tableNumber = useCart((s) => s.tableNumber);

  /**
   * Highlight the category the customer is actually looking at as they scroll.
   *
   * Without this the rail is a set of buttons that only ever respond to being
   * pressed, and on a long menu you lose track of where you are. The rootMargin
   * biases the observer to the top third of the viewport, which is roughly where a
   * person's eye is while scrolling.
   */
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible?.target.id) setActiveCategory(visible.target.id);
      },
      { rootMargin: '-120px 0px -60% 0px' },
    );

    Object.values(sectionRefs.current).forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, [menu]);

  const scrollToCategory = (id: string) => {
    const el = sectionRefs.current[id];
    if (!el) return;
    // Offset for the sticky header + rail, or the heading lands underneath them.
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 132, behavior: 'smooth' });
  };

  if (menu.length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-5 py-28 text-center">
        <h1 className="text-xl font-semibold">The menu isn&apos;t ready yet</h1>
        <p className="mt-2 text-muted-foreground">Please check back shortly.</p>
      </div>
    );
  }

  return (
    <div className="pb-32">
      {tableNumber && (
        <div className="bg-brand-subtle py-2.5 text-center text-sm font-medium">
          Ordering for table {tableNumber}
        </div>
      )}

      <div className="mx-auto max-w-3xl px-5 pt-10 sm:px-8">
        <h1 className="font-display text-4xl font-semibold tracking-tight sm:text-5xl">Menu</h1>
        {!restaurant.isOpen && (
          <p className="mt-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {restaurant.name} is closed right now.
            {restaurant.scheduledOrdersEnabled
              ? ' You can still schedule an order for later.'
              : ' Browse the menu — ordering opens when they do.'}
          </p>
        )}
      </div>

      {/* Sticky category rail. On a phone the menu is long, and having to scroll
          back to the top to change category is the single most annoying thing a
          mobile menu can do. */}
      <nav className="sticky top-16 z-30 mt-6 border-b bg-background/85 backdrop-blur-md">
        <div className="no-scrollbar mx-auto flex max-w-3xl gap-1.5 overflow-x-auto px-5 py-3 sm:px-8">
          {menu.map((category) => (
            <button
              key={category.id}
              onClick={() => scrollToCategory(category.id)}
              className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium transition-all ${
                activeCategory === category.id
                  ? 'bg-brand text-brand-foreground shadow-soft'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              }`}
            >
              {category.name}
            </button>
          ))}
        </div>
      </nav>

      <div className="mx-auto max-w-3xl space-y-14 px-5 py-10 sm:px-8">
        {menu.map((category) => (
          <section
            key={category.id}
            id={category.id}
            ref={(el) => {
              sectionRefs.current[category.id] = el;
            }}
            className="scroll-mt-36"
          >
            <h2 className="font-display text-2xl font-semibold tracking-tight">{category.name}</h2>
            {category.description && (
              <p className="mt-1 text-muted-foreground">{category.description}</p>
            )}

            <div className="mt-5 space-y-3">
              {category.products.map((product) => (
                <button
                  key={product.id}
                  onClick={() => setSelected(product)}
                  className="card-interactive group flex w-full gap-5 p-5 text-left"
                >
                  <div className="min-w-0 flex-1">
                    <h3 className="font-semibold leading-snug">{product.name}</h3>

                    {product.description && (
                      <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
                        {product.description}
                      </p>
                    )}

                    <div className="mt-3 flex items-center gap-2.5">
                      <span className="font-semibold tabular-nums">
                        {formatMoney(product.priceCents, restaurant.currency)}
                      </span>

                      {/* Say so BEFORE they tap. Discovering a required choice only
                          after opening the dialog feels like a bait and switch. */}
                      {product.modifierGroups.length > 0 && (
                        <span className="text-xs text-muted-foreground">
                          · {product.modifierGroups.length} option
                          {product.modifierGroups.length === 1 ? '' : 's'}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="relative shrink-0">
                    {product.imageUrl ? (
                      <div className="img-zoom h-28 w-28 rounded-xl">
                        <Image
                          src={product.imageUrl}
                          alt={product.name}
                          width={112}
                          height={112}
                          className="h-28 w-28 rounded-xl object-cover"
                          style={{ width: 112, height: 112 }}
                        />
                      </div>
                    ) : (
                      <div className="h-28 w-28 rounded-xl bg-muted" />
                    )}

                    {/* The affordance. A menu row that is silently clickable is a
                        menu row people read and scroll past. */}
                    <span className="absolute -bottom-1.5 -right-1.5 flex h-8 w-8 items-center justify-center rounded-full bg-brand text-brand-foreground shadow-lifted transition-transform group-hover:scale-110">
                      <Plus className="h-4 w-4" />
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>

      {/* The cart bar. Fixed, so it is never something you have to scroll to find —
          and it never appears empty, because an empty cart bar is just clutter. */}
      {lines.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/90 p-4 backdrop-blur-md">
          <div className="mx-auto max-w-3xl">
            <a
              href={href('/cart')}
              className="flex items-center justify-between rounded-xl bg-brand px-6 py-4 font-semibold text-brand-foreground shadow-floating transition-transform hover:scale-[1.01]"
            >
              <span className="flex items-center gap-2.5">
                <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-white/25 px-1.5 text-xs font-bold tabular-nums">
                  {itemCount}
                </span>
                View cart
              </span>
              <span className="flex items-center gap-2 tabular-nums">
                {formatMoney(subtotal, restaurant.currency)}
                <ArrowRight className="h-4 w-4" />
              </span>
            </a>
          </div>
        </div>
      )}

      {selected && (
        <ProductDialog
          product={selected}
          currency={restaurant.currency}
          open
          onOpenChange={(open) => !open && setSelected(null)}
        />
      )}
    </div>
  );
}
