'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatMoney, WIDGET_MESSAGE_NAMESPACE, type WidgetSettings } from '@orderos/shared';
import { ApiRequestError } from '@/lib/api';
import { createWidgetApi, type WidgetConfig } from '@/lib/widget-api';
import type { MenuCategory, MenuProduct, TrackedOrder, DeliveryQuote } from '@/lib/api';
import { useCart, useCartTotals } from '@/lib/cart-store';
import { EmbedMenu } from './embed-menu';
import { EmbedCart } from './embed-cart';
import { EmbedCheckout } from './embed-checkout';
import { EmbedTracking } from './embed-tracking';
import { EmbedHeader } from './embed-header';
import { EmbedLookup } from './embed-lookup';

export type EmbedView =
  | 'menu'
  | 'cart'
  | 'checkout'
  | 'awaiting-payment'
  | 'tracking'
  /** Finding an order they already placed, after closing the widget. */
  | 'lookup';

/**
 * The whole ordering flow, in one iframe, with no navigation between steps.
 *
 * The interesting part is payment. Stripe Checkout cannot be framed, so we ask
 * the HOST page (via postMessage) to open it in a new tab, then sit in the
 * `awaiting-payment` view polling the order. When the payment lands we flip to
 * tracking — all without the customer's tab on the restaurant's website ever
 * navigating away. That is the whole promise of this module, and this component
 * is where it's kept.
 */
export function EmbedApp({
  widgetKey,
  sessionId,
  inline,
}: {
  widgetKey: string;
  sessionId: string;
  initialView?: EmbedView;
  inline: boolean;
}) {
  const api = useMemo(() => createWidgetApi(widgetKey), [widgetKey]);

  const [config, setConfig] = useState<WidgetConfig | null>(null);
  const [menu, setMenu] = useState<MenuCategory[]>([]);
  const [view, setView] = useState<EmbedView>('menu');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [trackingToken, setTrackingToken] = useState<string | null>(null);
  const [order, setOrder] = useState<TrackedOrder | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);

  const lines = useCart((s) => s.lines);
  const itemCount = useCart((s) => s.itemCount());
  const ensureRestaurant = useCart((s) => s.ensureRestaurant);
  const clearCart = useCart((s) => s.clear);

  const parentOrigin = useRef<string>('*');

  const post = useCallback((message: Record<string, unknown>) => {
    if (window.parent === window) return; // not embedded (e.g. dashboard preview)
    window.parent.postMessage({ ns: WIDGET_MESSAGE_NAMESPACE, ...message }, parentOrigin.current);
  }, []);

  // --- Boot -----------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [cfg, m] = await Promise.all([api.getConfig(), api.getMenu()]);
        if (cancelled) return;

        setConfig(cfg);
        setMenu(m);
        // The cart is keyed by restaurant. A customer who has a cart from a
        // different restaurant's widget (same localStorage — both live on our
        // origin) must not carry it across.
        ensureRestaurant(cfg.restaurant.slug);
        post({ type: 'READY' });
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof ApiRequestError
            ? err.body.message
            : 'This ordering widget could not load.',
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api, ensureRestaurant, post]);

  // Keep the host page's button badge in step with the cart.
  useEffect(() => {
    post({ type: 'CART_COUNT', count: itemCount });
  }, [itemCount, post]);

  // The host tells us if it failed to open the Stripe tab (popup blocker).
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.ns !== WIDGET_MESSAGE_NAMESPACE) return;
      if (event.data.type === 'CHECKOUT_BLOCKED') setPopupBlocked(true);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  /**
   * Poll the order while the customer is paying in the other tab.
   *
   * This is the only way we can know: the payment happens on Stripe's domain, in
   * a tab we don't control, and the confirmation arrives at our *server* via
   * webhook. Polling our own API is how the iframe finds out.
   */
  useEffect(() => {
    if (!trackingToken) return;
    if (view !== 'awaiting-payment' && view !== 'tracking') return;

    let cancelled = false;

    const poll = async () => {
      try {
        const fresh = await api.track(trackingToken);
        if (cancelled) return;

        setOrder(fresh);

        // Payment landed. The order is real — show them where their food is.
        if (fresh.payment?.status === 'PAID' && view === 'awaiting-payment') {
          setView('tracking');
        }
      } catch {
        // Transient. The next tick retries.
      }
    };

    void poll();
    const interval = setInterval(poll, 4000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [trackingToken, view, api]);

  // --- Checkout -------------------------------------------------------------

  const handleOrderCreated = (result: {
    trackingToken: string;
    checkoutUrl: string;
  }) => {
    setTrackingToken(result.trackingToken);
    setCheckoutUrl(result.checkoutUrl);

    // Clear before we hand off to Stripe: if the customer comes back and orders
    // again, a stale cart would let them place the same order twice.
    clearCart();

    // The host page opens the tab — an iframe can't reliably call window.open,
    // and Stripe won't render framed anyway.
    post({ type: 'OPEN_CHECKOUT', url: result.checkoutUrl });
    setView('awaiting-payment');
  };

  // --- Render ---------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-foreground" />
      </div>
    );
  }

  if (error || !config) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="font-medium">Ordering is unavailable</p>
        <p className="text-sm text-muted-foreground">{error}</p>
      </div>
    );
  }

  const settings = config.settings;
  const restaurant = config.restaurant;

  return (
    <div
      style={
        {
          '--brand': settings.primaryColor,
          '--brand-foreground': settings.textColor,
          fontFamily: settings.fontFamily,
        } as React.CSSProperties
      }
      className={inline ? 'min-h-0' : 'flex h-screen flex-col'}
    >
      {!inline && (
        <EmbedHeader
          settings={settings}
          restaurant={restaurant}
          view={view}
          itemCount={itemCount}
          onBack={() => setView(view === 'checkout' ? 'cart' : 'menu')}
          onCart={() => setView('cart')}
          onClose={() => post({ type: 'CLOSE' })}
        />
      )}

      <div className={inline ? '' : 'flex-1 overflow-y-auto'}>
        {view === 'menu' && (
          <EmbedMenu
            menu={menu}
            restaurant={restaurant}
            onAdded={() => void api.trackEvent('ADD_TO_CART', sessionId)}
            onTrackExisting={() => setView('lookup')}
          />
        )}

        {view === 'cart' && (
          <EmbedCart
            restaurant={restaurant}
            onBrowse={() => setView('menu')}
            onCheckout={() => {
              void api.trackEvent('CHECKOUT_START', sessionId);
              setView('checkout');
            }}
          />
        )}

        {view === 'checkout' && (
          <EmbedCheckout
            api={api}
            restaurant={restaurant}
            sessionId={sessionId}
            onCreated={handleOrderCreated}
          />
        )}

        {view === 'awaiting-payment' && (
          <AwaitingPayment
            checkoutUrl={checkoutUrl}
            popupBlocked={popupBlocked}
            currency={restaurant.currency}
          />
        )}

        {view === 'lookup' && (
          <EmbedLookup
            api={api}
            restaurantPhone={restaurant.phone}
            onBack={() => setView('menu')}
            onFound={(token) => {
              // Feed it into the existing poll loop, which then keeps the tracking
              // view live exactly as it would after a fresh checkout.
              setTrackingToken(token);
              setView('tracking');
            }}
          />
        )}

        {view === 'tracking' && order && <EmbedTracking order={order} />}
      </div>

      {/* The cart bar. Only where it makes sense: never over the checkout form. */}
      {!inline && view === 'menu' && lines.length > 0 && (
        <div className="border-t bg-background p-3">
          <button
            onClick={() => setView('cart')}
            className="flex w-full items-center justify-between rounded-lg bg-brand px-4 py-3 font-semibold text-brand-foreground"
          >
            <span>
              View cart · {itemCount} item{itemCount === 1 ? '' : 's'}
            </span>
            <span>{formatMoney(useCart.getState().subtotalCents(), restaurant.currency)}</span>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The customer is paying in another tab. This view is what they see in the tab
 * that is still sitting on the restaurant's website.
 */
function AwaitingPayment({
  checkoutUrl,
  popupBlocked,
  currency,
}: {
  checkoutUrl: string | null;
  popupBlocked: boolean;
  currency: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      {popupBlocked ? (
        <>
          {/*
            The browser blocked the tab we tried to open. Rendering a real link
            the customer clicks turns it into a user gesture, which every popup
            blocker allows through. Without this fallback, a blocked popup is a
            dead end and a lost order.
          */}
          <p className="font-semibold">Your browser blocked the payment window</p>
          <p className="text-sm text-muted-foreground">
            Tap below to finish paying. You&apos;ll come straight back here.
          </p>
          {checkoutUrl && (
            <a
              href={checkoutUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg bg-brand px-6 py-3 font-semibold text-brand-foreground"
            >
              Continue to payment
            </a>
          )}
        </>
      ) : (
        <>
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-foreground" />
          <p className="font-semibold">Finish paying in the new tab</p>
          <p className="max-w-xs text-sm text-muted-foreground">
            We&apos;ll show your order here the moment your payment goes through. Keep this window
            open.
          </p>
          {checkoutUrl && (
            <a
              href={checkoutUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium underline"
            >
              Payment window didn&apos;t open?
            </a>
          )}
        </>
      )}
    </div>
  );
}
