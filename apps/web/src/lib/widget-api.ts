import {
  ApiRequestError,
  type ApiError,
  type Address,
  type CreateOrderResponse,
  type DeliveryQuote,
  type MenuCategory,
  type StorefrontRestaurant,
  type TrackedOrder,
} from './api';
import type { WidgetSettings } from '@dinedirect/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export interface WidgetConfig {
  settings: WidgetSettings;
  restaurant: StorefrontRestaurant;
}

/**
 * The client the embedded iframe uses.
 *
 * Identical in shape to `storefrontApi`, but the tenant is carried by the widget
 * key rather than a subdomain. Kept separate rather than adding a mode flag to
 * the storefront client: these two have different auth and different failure
 * modes, and one client that does both is one client where a bug in the widget
 * path can leak into the storefront path.
 */
export function createWidgetApi(widgetKey: string) {
  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    let res: Response;
    try {
      res = await fetch(`${API_URL}/api/widget${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          'X-Widget-Key': widgetKey,
          ...init.headers,
        },
      });
    } catch {
      throw new ApiRequestError(0, {
        statusCode: 0,
        error: 'NetworkError',
        message: 'Could not reach the restaurant. Check your connection and try again.',
      });
    }

    if (res.status === 204) return undefined as T;

    const text = await res.text();
    const body = text ? JSON.parse(text) : {};

    if (!res.ok) throw new ApiRequestError(res.status, body as ApiError);
    return body as T;
  };

  return {
    getConfig: () => call<WidgetConfig>('/config'),
    getMenu: () => call<MenuCategory[]>('/menu'),

    getDeliveryQuote: (body: { address: Address; orderValueCents: number }) =>
      call<DeliveryQuote>('/delivery-quote', { method: 'POST', body: JSON.stringify(body) }),

    createOrder: (body: unknown) =>
      call<CreateOrderResponse>('/orders', { method: 'POST', body: JSON.stringify(body) }),

    track: (token: string) => call<TrackedOrder>(`/orders/${token}`),

    /** A customer finding an existing order from inside the widget. */
    lookupOrder: (body: { orderNumber: string; phone: string }) =>
      call<TrackedOrder>('/lookup', { method: 'POST', body: JSON.stringify(body) }),

    /** Fire-and-forget. Never awaited by anything on the rendering path. */
    trackEvent: (type: 'ADD_TO_CART' | 'CHECKOUT_START', sessionId: string) =>
      call<void>('/events', {
        method: 'POST',
        body: JSON.stringify({ type, sessionId }),
      }).catch(() => {}),
  };
}

export type WidgetApi = ReturnType<typeof createWidgetApi>;
