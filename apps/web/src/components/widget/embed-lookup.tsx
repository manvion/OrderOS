'use client';

import { useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { toast } from 'sonner';
import { ApiRequestError } from '@/lib/api';
import type { WidgetApi } from '@/lib/widget-api';

/**
 * "I already ordered — where is it?"
 *
 * The widget lives on someone else's website, so we cannot navigate the customer
 * to a tracking page without taking them off the restaurant's site, which is the
 * one thing this whole module exists to prevent. So the lookup happens IN the
 * widget and switches it straight to the tracking view.
 *
 * Order number AND phone. Order numbers are sequential (0712-014 implies -013
 * exists), so a number-only lookup would let anyone read a stranger's order,
 * including the address it's being delivered to.
 */
export function EmbedLookup({
  api,
  restaurantPhone,
  onFound,
  onBack,
}: {
  api: WidgetApi;
  restaurantPhone: string;
  onFound: (trackingToken: string) => void;
  onBack: () => void;
}) {
  const [orderNumber, setOrderNumber] = useState('');
  const [phone, setPhone] = useState('');
  const [looking, setLooking] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLooking(true);

    try {
      const order = await api.lookupOrder({
        orderNumber: orderNumber.trim(),
        phone: phone.trim(),
      });
      onFound(order.trackingToken);
    } catch (err) {
      setLooking(false);
      toast.error(
        err instanceof ApiRequestError
          ? err.body.message
          : "We couldn't find that order. Check the details and try again.",
      );
    }
  };

  return (
    <form onSubmit={submit} className="animate-rise space-y-4 p-4">
      <div>
        <h2 className="text-lg font-bold tracking-tight">Find your order</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          We texted you a tracking link when you ordered. Lost it? Look it up here.
        </p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="w-order" className="text-xs font-medium">
          Order number
        </label>
        <input
          id="w-order"
          value={orderNumber}
          onChange={(e) => setOrderNumber(e.target.value)}
          placeholder="0712-014"
          required
          className="w-full rounded-lg border px-3 py-2 font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground">It&apos;s in the text we sent you.</p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="w-phone" className="text-xs font-medium">
          The phone number you used
        </label>
        <input
          id="w-phone"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          required
          autoComplete="tel"
          className="w-full rounded-lg border px-3 py-2 text-sm"
        />
      </div>

      <button
        type="submit"
        disabled={!orderNumber.trim() || phone.trim().length < 7 || looking}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand py-3 font-semibold text-brand-foreground disabled:opacity-50"
      >
        {looking ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Finding it…
          </>
        ) : (
          <>
            <Search className="h-4 w-4" />
            Find my order
          </>
        )}
      </button>

      <button type="button" onClick={onBack} className="w-full py-1 text-sm font-medium">
        Back to the menu
      </button>

      <p className="text-center text-xs text-muted-foreground">
        Still stuck?{' '}
        <a href={`tel:${restaurantPhone}`} className="font-medium underline">
          Call the restaurant
        </a>
      </p>
    </form>
  );
}
