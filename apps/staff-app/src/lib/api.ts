/**
 * The thin API layer the staff app uses to talk to the DineDirect API — only the few
 * endpoints in-person payments need. Every call carries the signed-in staff member's
 * Clerk bearer token; the API resolves WHICH restaurant from that token's membership,
 * exactly like the web dashboard, so a staff member only ever sees their own orders.
 */

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'https://api.dinedirect.manvion.ca';

/** Supply the signed-in staff member's Clerk token. Wired from App.tsx via Clerk's getToken. */
let authTokenProvider: () => Promise<string | null> = async () => null;
export function setAuthTokenProvider(fn: () => Promise<string | null>) {
  authTokenProvider = fn;
}

/**
 * Only needed when a staff member works at more than one restaurant — then the app picks
 * one and passes it as X-Restaurant-Id (the same header the web dashboard's location
 * switcher sends). Left unset for single-restaurant staff, where the API defaults to
 * their one membership.
 */
let activeRestaurantId: string | null = null;
export function setActiveRestaurant(id: string | null) {
  activeRestaurantId = id;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await authTokenProvider();
  const res = await fetch(`${API_BASE}/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(activeRestaurantId ? { 'X-Restaurant-Id': activeRestaurantId } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: 'Request failed' }));
    throw new Error(body.message ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export interface AwaitingOrder {
  id: string;
  orderNumber: string;
  tableNumber: string | null;
  fulfillment: string;
  totalCents: number;
  currency: string;
  customerName: string;
  createdAt: string;
  items: Array<{ id: string; name: string; quantity: number }>;
}

/** Open orders still waiting to be paid — what the payment list shows. */
export function fetchAwaitingPayment() {
  return call<AwaitingOrder[]>('/orders/awaiting-payment');
}

/** The Terminal Location (+ display name) to connect the Tap-to-Pay reader against. */
export function fetchTerminalLocation() {
  return call<{ locationId: string; merchantDisplayName: string }>('/payments/terminal/location');
}

/** A Terminal connection token — the SDK's tokenProvider calls this. */
export async function fetchConnectionToken(): Promise<string> {
  const { secret } = await call<{ secret: string }>('/payments/terminal/connection-token', {
    method: 'POST',
  });
  return secret;
}

/** Start the card-present charge for an order; returns the PaymentIntent client secret. */
export function createTerminalIntent(orderId: string) {
  return call<{ clientSecret: string; paymentIntentId: string }>(
    `/payments/terminal/orders/${orderId}/intent`,
    { method: 'POST' },
  );
}

/** Confirm the tap succeeded server-side and mark the order paid. */
export function settleTerminalOrder(orderId: string) {
  return call<{ ok: true }>(`/payments/terminal/orders/${orderId}/settle`, { method: 'POST' });
}
