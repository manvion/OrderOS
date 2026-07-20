/**
 * The thin API layer the staff app uses to talk to the DineDirect API — only the few
 * endpoints in-person payments need. Everything is authenticated with the staff member's
 * bearer token (the same Clerk session the dashboard uses); wire `getAuthToken` to your
 * auth of choice.
 */

const API_BASE =
  process.env.EXPO_PUBLIC_API_URL ?? 'https://api.dinedirect.manvion.ca';

/** Supply the signed-in staff member's bearer token. Replace with your auth integration. */
let authTokenProvider: () => Promise<string | null> = async () => null;
export function setAuthTokenProvider(fn: () => Promise<string | null>) {
  authTokenProvider = fn;
}

/** The tenant (restaurant) whose till this device is ringing up. */
let restaurantSlug: string | null = null;
export function setRestaurant(slug: string) {
  restaurantSlug = slug;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await authTokenProvider();
  const res = await fetch(`${API_BASE}/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(restaurantSlug ? { 'x-restaurant-slug': restaurantSlug } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: 'Request failed' }));
    throw new Error(body.message ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
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
