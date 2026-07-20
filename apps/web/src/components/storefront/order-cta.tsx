'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, ShoppingBag, Truck, UtensilsCrossed } from 'lucide-react';
import { useTenant, useTenantHref } from './tenant-provider';
import { useCart } from '@/lib/cart-store';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/primitives';

type Fulfillment = 'PICKUP' | 'DELIVERY' | 'DINE_IN';

/**
 * The primary "Order now" call-to-action.
 *
 * Instead of dropping the customer straight onto the menu, it first asks HOW they
 * want their order — pickup, delivery or dine-in — but only among the ways this
 * restaurant actually offers. That choice is remembered (cart store) so the menu,
 * cart and checkout are already set up for it, and delivery-only rules (like the
 * minimum order) apply to the right people. When only one way is offered, there's
 * nothing to ask, so it goes straight to the menu.
 */
export function OrderCta({ label, className }: { label: string; className?: string }) {
  const restaurant = useTenant();
  const href = useTenantHref();
  const router = useRouter();
  const setFulfillment = useCart((s) => s.setFulfillment);
  const [open, setOpen] = useState(false);

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
    // One way (or somehow none) to order → no question to ask.
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

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>How would you like your order?</DialogTitle>
            <DialogDescription>Pick one to start your order.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            {options.map(({ value, icon: Icon, label: optLabel, body }) => (
              <button
                key={value}
                type="button"
                onClick={() => go(value)}
                className="flex items-center gap-3 rounded-xl border p-4 text-left transition-colors hover:border-brand hover:bg-accent/50"
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-subtle text-brand">
                  <Icon className="h-5 w-5" />
                </span>
                <span className="min-w-0">
                  <span className="block font-semibold">{optLabel}</span>
                  <span className="block text-sm text-muted-foreground">{body}</span>
                </span>
                <ArrowRight className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
