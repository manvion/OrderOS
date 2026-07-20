'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, ChevronRight, ShoppingBag, Truck, UtensilsCrossed, X } from 'lucide-react';
import { useTenant, useTenantHref } from './tenant-provider';
import { useCart } from '@/lib/cart-store';

type Fulfillment = 'PICKUP' | 'DELIVERY' | 'DINE_IN';

/**
 * The primary "Order now" call-to-action.
 *
 * Instead of dropping the customer straight onto the menu, it first asks HOW they
 * want their order — pickup, delivery or dine-in — but only among the ways this
 * restaurant actually offers. That choice is remembered (cart store) so the menu,
 * cart and checkout are already set up for it. When only one way is offered, there's
 * nothing to ask, so it goes straight to the menu.
 *
 * The chooser is a bottom sheet — the native-app pattern people already know from
 * every food app — rather than a desktop-style centred dialog.
 */
export function OrderCta({ label, className }: { label: string; className?: string }) {
  const restaurant = useTenant();
  const href = useTenantHref();
  const router = useRouter();
  const setFulfillment = useCart((s) => s.setFulfillment);
  const [open, setOpen] = useState(false);

  // Lock the page behind the sheet and close on Escape — small things that make it
  // feel like a real app rather than a div that appeared.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open]);

  const options = [
    restaurant.pickupEnabled && {
      value: 'PICKUP' as const,
      icon: ShoppingBag,
      label: 'Pickup',
      body: 'Order ahead and collect it in store.',
    },
    restaurant.deliveryEnabled && {
      value: 'DELIVERY' as const,
      icon: Truck,
      label: 'Delivery',
      body: 'We bring it right to your door.',
    },
    restaurant.dineInEnabled && {
      value: 'DINE_IN' as const,
      icon: UtensilsCrossed,
      label: 'Dine in',
      body: 'Order for your table.',
    },
  ].filter(Boolean) as Array<{
    value: Fulfillment;
    icon: typeof ShoppingBag;
    label: string;
    body: string;
  }>;

  const go = (f?: Fulfillment) => {
    if (f) setFulfillment(f);
    router.push(href('/menu'));
  };

  const handleClick = () => {
    if (options.length <= 1) {
      go(options[0]?.value);
      return;
    }
    setOpen(true);
  };

  return (
    <>
      <button type="button" onClick={handleClick} className={className}>
        {label}
        <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
      </button>

      {open && (
        <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true">
          <button
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="absolute inset-0 cursor-default bg-black/50 backdrop-blur-sm animate-in fade-in"
          />
          <div className="animate-in slide-in-from-bottom-4 fade-in absolute inset-x-0 bottom-0 mx-auto max-w-md rounded-t-3xl bg-background p-5 pb-8 shadow-floating">
            {/* Grabber + close, the app-sheet signals. */}
            <div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-muted-foreground/25" />
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="absolute right-4 top-4 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-accent"
            >
              <X className="h-4 w-4" />
            </button>

            <h2 className="text-xl font-bold tracking-tight">How would you like it?</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">Pick one to start your order.</p>

            <div className="mt-5 grid gap-2.5">
              {options.map(({ value, icon: Icon, label: optLabel, body }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => go(value)}
                  className="flex items-center gap-3.5 rounded-2xl border p-4 text-left transition-all hover:border-brand hover:bg-brand-subtle active:scale-[0.98]"
                >
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-brand-subtle text-brand">
                    <Icon className="h-6 w-6" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{optLabel}</span>
                    <span className="block text-sm text-muted-foreground">{body}</span>
                  </span>
                  <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
