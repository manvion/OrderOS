/**
 * Typed API client.
 *
 * Two flavours, because the two halves of the product authenticate differently:
 *
 *  - `storefrontApi` — no session. The tenant is carried by the X-Restaurant-Slug
 *    header, which the server reads from the rewritten path.
 *  - `dashboardApi`  — a Clerk bearer token plus X-Restaurant-Id, so a user who
 *    works at two restaurants can say which one they're acting as.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export interface ApiError {
  statusCode: number;
  error: string;
  message: string;
  fieldErrors?: Record<string, string>;
  [key: string]: unknown;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body.message ?? 'Request failed');
    this.name = 'ApiRequestError';
  }

  /** True when the API rejected the input, as opposed to failing. */
  get isValidationError(): boolean {
    return this.status === 400 && Boolean(this.body.fieldErrors);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api${path}`, {
      ...init,
      headers: {
        ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...init.headers,
      },
    });
  } catch (err) {
    // Network failure — the API is unreachable, not returning an error.
    throw new ApiRequestError(0, {
      statusCode: 0,
      error: 'NetworkError',
      message: 'Could not reach the server. Check your connection and try again.',
    });
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const body = text ? JSON.parse(text) : {};

  if (!res.ok) {
    throw new ApiRequestError(res.status, body as ApiError);
  }

  return body as T;
}

/** Customer-facing. Called from the storefront, where there is no session. */
export const storefrontApi = {
  request: <T>(path: string, slug: string, init: RequestInit = {}) =>
    request<T>(path, {
      ...init,
      headers: { 'X-Restaurant-Slug': slug, ...init.headers },
    }),

  getRestaurant: (slug: string) =>
    storefrontApi.request<StorefrontRestaurant>('/storefront/restaurant', slug),

  getMenu: (slug: string) => storefrontApi.request<MenuCategory[]>('/storefront/menu', slug),

  getDeliveryQuote: (slug: string, body: { address: Address; orderValueCents: number }) =>
    storefrontApi.request<DeliveryQuote>('/storefront/delivery-quote', slug, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  createOrder: (slug: string, body: unknown) =>
    storefrontApi.request<CreateOrderResponse>('/storefront/orders', slug, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  track: (slug: string, token: string) =>
    storefrontApi.request<TrackedOrder>(`/storefront/track/${token}`, slug),

  /**
   * A guest finding their own order again after closing the tab or losing the SMS.
   * Needs order number AND phone — an order number alone is sequential and would
   * let anyone read a stranger's order.
   */
  lookupOrder: (slug: string, body: { orderNumber: string; phone: string }) =>
    storefrontApi.request<TrackedOrder & { trackingToken: string }>('/storefront/lookup', slug, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** Fire-and-forget QR attribution ping. Must never block the page. */
  registerScan: (qrId: string) =>
    fetch(`${API_URL}/api/qr-scan/${qrId}`, { method: 'POST', keepalive: true }).catch(() => {}),

  /**
   * Customer account calls. `token` is a Clerk session token if the customer
   * happens to be signed in, and undefined if they're a guest.
   *
   * Every one of these is OPTIONAL to the ordering flow. A guest never calls them
   * and loses nothing but the convenience of not retyping their address.
   */
  getProfile: (slug: string, token: string) =>
    storefrontApi.request<CustomerProfile>('/storefront/me', slug, {
      headers: { Authorization: `Bearer ${token}` },
    }),

  saveAddress: (slug: string, token: string, body: unknown) =>
    storefrontApi.request<SavedAddress>('/storefront/me/addresses', slug, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),

  deleteAddress: (slug: string, token: string, id: string) =>
    storefrontApi.request<{ success: boolean }>(`/storefront/me/addresses/${id}`, slug, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }),

  /**
   * Place an order. `token` is optional — pass it if the customer is signed in and
   * the order gets attached to their account; omit it and they order as a guest.
   * Identical behaviour otherwise.
   */
  createOrderAs: (slug: string, body: unknown, token?: string) =>
    storefrontApi.request<CreateOrderResponse>('/storefront/orders', slug, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: JSON.stringify(body),
    }),
};

/**
 * Dashboard client. `getToken` comes from Clerk's `useAuth()` — passed in rather
 * than imported so this module stays usable from server components too.
 */
export function createDashboardApi(
  getToken: () => Promise<string | null>,
  restaurantId?: string,
) {
  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const token = await getToken();
    if (!token) {
      throw new ApiRequestError(401, {
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Your session expired. Please sign in again.',
      });
    }

    return request<T>(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(restaurantId ? { 'X-Restaurant-Id': restaurantId } : {}),
        ...init.headers,
      },
    });
  };

  return {
    call,

    // Restaurants / onboarding
    listMine: () => call<RestaurantWithRole[]>('/restaurants/mine'),
    createRestaurant: (body: unknown) =>
      call<Restaurant>('/restaurants', { method: 'POST', body: JSON.stringify(body) }),
    checkSlug: (slug: string) =>
      call<{ available: boolean }>(`/restaurants/slug-available?slug=${encodeURIComponent(slug)}`),
    getCurrent: () => call<Restaurant>('/restaurants/current'),
    updateCurrent: (body: unknown) =>
      call<Restaurant>('/restaurants/current', { method: 'PATCH', body: JSON.stringify(body) }),
    updateDeliverySettings: (body: unknown) =>
      call<Restaurant>('/restaurants/current/delivery-settings', {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    uploadLogo: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return call<{ logoUrl: string }>('/restaurants/current/logo', { method: 'POST', body: form });
    },
    getPublishReadiness: () => call<PublishReadiness>('/restaurants/current/publish-readiness'),
    publish: () => call<Restaurant>('/restaurants/current/publish', { method: 'POST' }),

    // Menu
    listCategories: () => call<Category[]>('/menu/categories'),
    createCategory: (body: unknown) =>
      call<Category>('/menu/categories', { method: 'POST', body: JSON.stringify(body) }),
    updateCategory: (id: string, body: unknown) =>
      call<Category>(`/menu/categories/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    deleteCategory: (id: string) =>
      call<{ success: boolean }>(`/menu/categories/${id}`, { method: 'DELETE' }),

    listProducts: () => call<Product[]>('/menu/products'),
    createProduct: (body: unknown) =>
      call<Product>('/menu/products', { method: 'POST', body: JSON.stringify(body) }),
    updateProduct: (id: string, body: unknown) =>
      call<Product>(`/menu/products/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    setProductAvailability: (id: string, isAvailable: boolean) =>
      call<Product>(`/menu/products/${id}/availability`, {
        method: 'PATCH',
        body: JSON.stringify({ isAvailable }),
      }),
    deleteProduct: (id: string) =>
      call<{ success: boolean }>(`/menu/products/${id}`, { method: 'DELETE' }),
    uploadProductImage: (id: string, file: File) => {
      const form = new FormData();
      form.append('file', file);
      return call<{ imageUrl: string }>(`/menu/products/${id}/image`, {
        method: 'POST',
        body: form,
      });
    },

    // Orders
    listActiveOrders: () => call<Order[]>('/orders/active'),
    listOrders: (params?: { status?: string; cursor?: string }) => {
      const qs = new URLSearchParams();
      if (params?.status) qs.set('status', params.status);
      if (params?.cursor) qs.set('cursor', params.cursor);
      return call<{ orders: Order[]; nextCursor: string | null }>(`/orders?${qs}`);
    },
    getOrder: (id: string) => call<Order>(`/orders/${id}`),
    setOrderStatus: (id: string, status: string, note?: string) =>
      call<{ order: Order; delivery?: Delivery | null; warning?: string }>(`/orders/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status, note }),
      }),
    cancelOrder: (id: string, reason: string) =>
      call<Order>(`/orders/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }),

    // Payments
    getStripeStatus: () => call<StripeStatus>('/payments/connect/status'),
    createStripeOnboardingLink: () =>
      call<{ url: string }>('/payments/connect/onboarding-link', { method: 'POST' }),
    refund: (orderId: string, body: { amountCents?: number; reason?: string }) =>
      call<{ refundId: string; amountCents: number; isFullRefund: boolean }>(
        `/payments/orders/${orderId}/refund`,
        { method: 'POST', body: JSON.stringify(body) },
      ),

    // Delivery
    dispatchUber: (orderId: string) =>
      call<Delivery>(`/delivery/orders/${orderId}`, { method: 'POST' }),
    selfDeliver: (orderId: string, driver: { name?: string; phone?: string }) =>
      call<Delivery>(`/delivery/orders/${orderId}/self`, {
        method: 'POST',
        body: JSON.stringify(driver),
      }),
    setSelfDeliveryStatus: (orderId: string, status: 'OUT_FOR_DELIVERY' | 'DELIVERED') =>
      call<{ order: Order }>(`/delivery/orders/${orderId}/self/status`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      }),
    /** Verify the courier at the counter is collecting THIS order. */
    verifyHandoff: (
      orderId: string,
      body: { code?: string; override?: boolean; overrideReason?: string },
    ) =>
      call<{ verified: boolean; alreadyHandedOver: boolean }>(
        `/delivery/orders/${orderId}/handoff`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    getDeliveryTrail: (orderId: string) =>
      call<{
        courierLatitude: number | null;
        courierLongitude: number | null;
        pings: Array<{ latitude: number; longitude: number }>;
      }>(`/delivery/orders/${orderId}/trail`),
    cancelDelivery: (orderId: string) =>
      call<Delivery>(`/delivery/orders/${orderId}/cancel`, { method: 'POST' }),
    refreshDelivery: (orderId: string) =>
      call<Delivery>(`/delivery/orders/${orderId}/refresh`, { method: 'POST' }),

    // QR
    createTableRange: (from: number, to: number) =>
      call<{ created: number; skipped: number }>('/qr/tables', {
        method: 'POST',
        body: JSON.stringify({ from, to }),
      }),

    // QR
    listQrCodes: () => call<QRCode[]>('/qr'),
    createQrCode: (body: unknown) =>
      call<QRCode>('/qr', { method: 'POST', body: JSON.stringify(body) }),
    getQrStats: () => call<QrStat[]>('/qr/stats'),
    deleteQrCode: (id: string) => call<{ success: boolean }>(`/qr/${id}`, { method: 'DELETE' }),

    // Staff & invitations
    listStaff: () => call<StaffMember[]>('/restaurants/current/staff'),
    updateStaffRole: (id: string, role: string) =>
      call<StaffMember>(`/restaurants/current/staff/${id}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      }),
    removeStaff: (id: string) =>
      call<{ success: boolean }>(`/restaurants/current/staff/${id}`, { method: 'DELETE' }),
    listInvites: () => call<StaffInvite[]>('/restaurants/current/invites'),
    inviteStaff: (body: { email: string; role: string }) =>
      call<StaffInvite>('/restaurants/current/invites', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    revokeInvite: (id: string) =>
      call<{ success: boolean }>(`/restaurants/current/invites/${id}`, { method: 'DELETE' }),

    // Notifications — "did the customer actually get their texts?"
    getOrderNotifications: (orderId: string) =>
      call<NotificationLogEntry[]>(`/notifications/orders/${orderId}`),

    // Custom domains (joesburgers.com -> their storefront)
    listDomains: () => call<CustomDomain[]>('/domains'),
    addDomain: (domain: string) =>
      call<CustomDomain>('/domains', { method: 'POST', body: JSON.stringify({ domain }) }),
    checkDomain: (id: string) => call<CustomDomain>(`/domains/${id}/check`, { method: 'POST' }),
    removeDomain: (id: string) =>
      call<{ success: boolean }>(`/domains/${id}`, { method: 'DELETE' }),

    // ---- PLATFORM ADMIN (us, not the restaurants) ----
    adminMe: () => call<PlatformAdmin>('/admin/me'),
    adminOverview: (days = 30) => call<AdminOverview>(`/admin/overview?days=${days}`),
    adminListRestaurants: (params?: { search?: string; status?: string }) => {
      const qs = new URLSearchParams();
      if (params?.search) qs.set('search', params.search);
      if (params?.status) qs.set('status', params.status);
      return call<{ restaurants: AdminRestaurant[]; nextCursor: string | null }>(
        `/admin/restaurants?${qs}`,
      );
    },
    adminGetRestaurant: (id: string) => call<AdminRestaurantDetail>(`/admin/restaurants/${id}`),
    adminCreateRestaurant: (body: unknown) =>
      call<AdminRestaurant>('/admin/restaurants', { method: 'POST', body: JSON.stringify(body) }),
    adminSetFee: (id: string, platformFeeBps: number) =>
      call<AdminRestaurant>(`/admin/restaurants/${id}/fee`, {
        method: 'PATCH',
        body: JSON.stringify({ platformFeeBps }),
      }),
    adminSetActive: (id: string, isActive: boolean, reason: string) =>
      call<AdminRestaurant>(`/admin/restaurants/${id}/active`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive, reason }),
      }),
    adminStartSupport: (id: string, reason: string) =>
      call<{ id: string; expiresAt: string }>(`/admin/restaurants/${id}/support-session`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),

    // Website integrations (embeddable widget)
    listIntegrations: () => call<WebsiteIntegration[]>('/website-integrations'),
    createIntegration: (body: { name: string; domain: string }) =>
      call<WebsiteIntegration>('/website-integrations', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    updateIntegration: (id: string, body: unknown) =>
      call<WebsiteIntegration>(`/website-integrations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    rotateWidgetKey: (id: string) =>
      call<WebsiteIntegration>(`/website-integrations/${id}/rotate-key`, { method: 'POST' }),
    deleteIntegration: (id: string) =>
      call<{ success: boolean }>(`/website-integrations/${id}`, { method: 'DELETE' }),
    getWidgetAnalytics: (days = 30) =>
      call<WidgetFunnel[]>(`/website-integrations/analytics?days=${days}`),

    // Customers & analytics
    listCustomers: (search?: string) =>
      call<{ customers: Customer[]; nextCursor: string | null }>(
        `/customers${search ? `?search=${encodeURIComponent(search)}` : ''}`,
      ),
    getAnalyticsOverview: (period = '30d') =>
      call<AnalyticsOverview>(`/analytics/overview?period=${period}`),
    getRevenueSeries: (period = '30d') =>
      call<Array<{ date: string; revenueCents: number; orderCount: number }>>(
        `/analytics/revenue?period=${period}`,
      ),
    getTopProducts: (period = '30d') =>
      call<Array<{ name: string; unitsSold: number; revenueCents: number }>>(
        `/analytics/top-products?period=${period}`,
      ),
    getDeliveryEconomics: (period = '30d') =>
      call<DeliveryEconomics>(`/analytics/delivery-economics?period=${period}`),
  };
}

export type DashboardApi = ReturnType<typeof createDashboardApi>;

// --- Types ------------------------------------------------------------------

export interface Address {
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  latitude?: number;
  longitude?: number;
}

export interface StorefrontRestaurant {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  phone: string;
  street: string;
  city: string;
  state: string;
  postalCode: string;
  logoUrl: string | null;
  coverImageUrl: string | null;
  brandPrimaryColor: string;
  brandAccentColor: string;
  currency: string;
  timezone: string;
  isOpen: boolean;
  acceptingOrders: boolean;
  pickupEnabled: boolean;
  deliveryEnabled: boolean;
  dineInEnabled: boolean;
  scheduledOrdersEnabled: boolean;
  deliveryFeeCents: number;
  minOrderCents: number;
  serviceFeeCents: number;
  taxRateBps: number;
  prepTimeMinutes: number;
  businessHours: unknown;
}

export interface MenuModifier {
  id: string;
  name: string;
  priceCents: number;
}

export interface MenuModifierGroup {
  id: string;
  name: string;
  selectionType: 'SINGLE' | 'MULTIPLE';
  required: boolean;
  minSelections: number;
  maxSelections: number;
  modifiers: MenuModifier[];
}

export interface MenuProduct {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  imageUrl: string | null;
  modifierGroups: MenuModifierGroup[];
}

export interface MenuCategory {
  id: string;
  name: string;
  description: string | null;
  products: MenuProduct[];
}

export type DeliveryQuote =
  | {
      deliverable: true;
      customerFeeCents: number;
      uberFeeCents: number | null;
      quoteId?: string;
      dropoffEta?: string;
      selfDelivery?: boolean;
    }
  | {
      deliverable: false;
      reason: string;
      /**
       * The address is outside the restaurant's OWN delivery radius — a definite
       * answer, not a failure. The checkout treats it differently: it says "too far"
       * and offers to switch them to pickup, rather than showing a red error.
       */
      outOfRange?: boolean;
      distanceMeters?: number;
      limitMeters?: number;
    };

export interface CreateOrderResponse {
  orderId: string;
  orderNumber: string;
  trackingToken: string;
  totalCents: number;
  currency: string;
  checkoutUrl: string;
}

export interface TrackedOrder {
  /** The unguessable key to this order's tracking page. */
  trackingToken: string;
  orderNumber: string;
  status: string;
  fulfillment: string;
  totalCents: number;
  currency: string;
  subtotalCents: number;
  taxCents: number;
  tipCents: number;
  deliveryFeeCents: number;
  serviceFeeCents: number;
  createdAt: string;
  scheduledFor: string | null;
  items: Array<{
    name: string;
    quantity: number;
    totalCents: number;
    modifiers: Array<{ name: string; priceCents: number }>;
  }>;
  payment: { status: string } | null;
  /** Where the food is going. Plotted as the destination pin on the map. */
  deliveryLatitude: number | null;
  deliveryLongitude: number | null;
  delivery: {
    id: string;
    status: string;
    trackingUrl: string | null;
    courierName: string | null;
    courierVehicle: string | null;
    /** The courier's live position. Never their phone number. */
    courierLatitude: number | null;
    courierLongitude: number | null;
    dropoffEta: string | null;
    /** Breadcrumbs, so the map draws the route rather than teleporting a pin. */
    pings: Array<{ latitude: number; longitude: number }>;
  } | null;
  restaurant: {
    name: string;
    slug: string;
    phone: string;
    logoUrl: string | null;
    brandPrimaryColor: string;
    street: string;
    city: string;
    latitude: number | null;
    longitude: number | null;
    prepTimeMinutes: number;
  };
  events: Array<{ status: string; createdAt: string; note: string | null }>;
}

export interface Restaurant {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  email: string;
  phone: string;
  street: string;
  city: string;
  state: string;
  postalCode: string;
  logoUrl: string | null;
  brandPrimaryColor: string;
  timezone: string;
  currency: string;
  isPublished: boolean;
  onboardingStep: string;
  stripeChargesEnabled: boolean;
  uberDirectEnabled: boolean;
  /** The restaurant has their own driver. Both on = the dashboard asks per order. */
  selfDeliveryEnabled: boolean;
  pickupEnabled: boolean;
  deliveryEnabled: boolean;
  dineInEnabled: boolean;
  scheduledOrdersEnabled: boolean;
  deliveryFeeCents: number;
  deliveryRadiusMeters: number;
  minOrderCents: number;
  serviceFeeCents: number;
  taxRateBps: number;
  prepTimeMinutes: number;
  businessHours: unknown;
}

export type RestaurantWithRole = Restaurant & { role: 'OWNER' | 'MANAGER' | 'STAFF' };

export interface PublishReadiness {
  ready: boolean;
  blockers: string[];
  warnings: string[];
  isPublished: boolean;
  storefrontUrl: string;
}

export interface Category {
  id: string;
  name: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  _count?: { products: number };
}

export interface Product {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  imageUrl: string | null;
  isAvailable: boolean;
  sortOrder: number;
  categoryId: string;
  category?: { id: string; name: string };
  modifierGroups: MenuModifierGroup[];
}

export interface Order {
  id: string;
  orderNumber: string;
  status: string;
  fulfillment: string;
  subtotalCents: number;
  taxCents: number;
  tipCents: number;
  deliveryFeeCents: number;
  serviceFeeCents: number;
  totalCents: number;
  currency: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  deliveryStreet: string | null;
  deliveryCity: string | null;
  tableNumber: string | null;
  notes: string | null;
  scheduledFor: string | null;
  createdAt: string;
  items: Array<{
    id: string;
    name: string;
    quantity: number;
    totalCents: number;
    notes: string | null;
    modifiers: Array<{ name: string; priceCents: number }>;
  }>;
  payment: {
    status: string;
    amountCents: number;
    refundedAmountCents: number;
    cardBrand: string | null;
    cardLast4: string | null;
  } | null;
  delivery: Delivery | null;
  customer: { id: string; name: string; totalOrders: number } | null;
}

export interface Delivery {
  id: string;
  status: string;
  /** UBER = a courier we dispatched. SELF = the restaurant's own driver. */
  provider: 'UBER' | 'SELF';
  driverName: string | null;
  driverPhone: string | null;
  trackingUrl: string | null;
  courierName: string | null;
  courierPhone: string | null;
  courierVehicle: string | null;
  courierLatitude: number | null;
  courierLongitude: number | null;
  feeCents: number | null;
  dropoffEta: string | null;
  lastError: string | null;
  /** The code the courier reads back, so staff know it's the right bag. */
  pickupCode: string | null;
  handedOverAt: string | null;
  /** How many couriers accepted this order and then fell through. */
  redispatchCount: number;
  /**
   * Set when automation gave up and a human must act. The order is NOT dead — it
   * is still live, still paid for, and now the restaurant's problem to solve.
   */
  escalatedAt: string | null;
  escalationReason: string | null;
}

// --- Customer accounts (storefront) ------------------------------------------

export interface SavedAddress {
  id: string;
  label: string | null;
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  notes: string | null;
  isDefault: boolean;
}

export interface CustomerProfile {
  customer: {
    id: string;
    name: string;
    phone: string;
    email: string | null;
    totalOrders: number;
    marketingOptIn: boolean;
  };
  addresses: SavedAddress[];
  orders: Array<{
    id: string;
    orderNumber: string;
    status: string;
    fulfillment: string;
    totalCents: number;
    currency: string;
    createdAt: string;
    trackingToken: string;
    items: Array<{ name: string; quantity: number }>;
  }>;
}

export interface StripeStatus {
  connected: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  requirementsDue?: string[];
}

export interface QRCode {
  id: string;
  type: 'TABLE' | 'FLYER' | 'COUNTER';
  label: string;
  tableNumber: string | null;
  targetUrl: string;
  imageUrl: string | null;
  scanCount: number;
  isActive: boolean;
}

export interface QrStat {
  id: string;
  label: string;
  type: string;
  scans: number;
  orders: number;
  conversionRate: number;
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  totalOrders: number;
  totalSpentCents: number;
  lastOrderAt: string | null;
}

export interface AnalyticsOverview {
  period: string;
  revenueCents: number;
  orderCount: number;
  averageOrderCents: number;
  newCustomers: number;
  refundedCents: number;
  changes: {
    revenue: number | null;
    orders: number | null;
    averageOrder: number | null;
  };
}

export interface StaffMember {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
  role: 'OWNER' | 'MANAGER' | 'STAFF';
  isActive: boolean;
  createdAt: string;
}

export interface StaffInvite {
  id: string;
  email: string;
  role: 'OWNER' | 'MANAGER' | 'STAFF';
  expiresAt: string;
  createdAt: string;
}

export interface NotificationLogEntry {
  id: string;
  channel: 'SMS' | 'EMAIL';
  audience: 'CUSTOMER' | 'RESTAURANT';
  status: 'SENT' | 'FAILED' | 'SKIPPED';
  template: string;
  /** Masked at write time — "***0188". We never store the full number. */
  recipient: string;
  error: string | null;
  createdAt: string;
}

export interface WebsiteIntegration {
  id: string;
  name: string;
  domain: string;
  /** Public — it lives in the customer's page source. Not a secret. */
  widgetKey: string;
  allowedDomains: string[];
  settings: unknown;
  isActive: boolean;
  /** Null until we've seen the widget load from an allowed origin. */
  installedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  /** Ready-to-paste <script> tag, built server-side so the CDN URL is never wrong. */
  embedCode: string;
}

export interface WidgetFunnel {
  integrationId: string;
  name: string;
  domain: string;
  installedAt: string | null;
  lastSeenAt: string | null;
  views: number;
  opens: number;
  addToCart: number;
  checkouts: number;
  paidOrders: number;
  revenueCents: number;
  /** Null when there's no traffic — "0%" would read as failure rather than absence. */
  conversionRate: number | null;
  openToOrderRate: number | null;
  abandonedCheckouts: number;
  averageOrderCents: number;
}

export interface DeliveryEconomics {
  deliveryCount: number;
  collectedCents: number;
  uberCostCents: number;
  marginCents: number;
  averageUberFeeCents: number;
}

// --- Platform admin (us, not the restaurants) --------------------------------

export interface PlatformAdmin {
  id: string;
  email: string;
  role: 'SUPER_ADMIN' | 'SUPPORT';
}

export interface AdminOverview {
  restaurants: { total: number; live: number; new: number; stuckInOnboarding: number };
  /** What customers paid across ALL restaurants. Not our money. */
  gmvCents: number;
  /** The platform fee — what WE actually earned. The real number. */
  platformRevenueCents: number;
  orders: number;
  refundedCents: number;
  changes: {
    gmv: number | null;
    platformRevenue: number | null;
    orders: number | null;
  };
}

export interface AdminRestaurant {
  id: string;
  name: string;
  slug: string;
  email: string;
  phone: string;
  city: string;
  isActive: boolean;
  isPublished: boolean;
  onboardingStep: string;
  stripeChargesEnabled: boolean;
  platformFeeBps: number;
  createdAt: string;
  _count: { orders: number; products: number; users: number };
}

export interface AdminRestaurantDetail extends AdminRestaurant {
  lifetimeGmvCents: number;
  lifetimePlatformFeeCents: number;
  lastOrderAt: string | null;
  /** Why they can't go live — the same checks the owner sees. */
  publishBlockers: string[];
  users: Array<{
    id: string;
    email: string;
    role: string;
    firstName: string | null;
    lastName: string | null;
  }>;
}

// --- Custom domains ----------------------------------------------------------

export interface DnsRecord {
  type: 'A' | 'CNAME' | 'TXT';
  /** "@" for an apex domain, or the subdomain label. */
  name: string;
  value: string;
}

export interface CustomDomain {
  id: string;
  domain: string;
  status: 'PENDING_DNS' | 'ISSUING_CERT' | 'ACTIVE' | 'FAILED';
  /** Exactly what the owner must paste into their registrar. */
  dnsRecords: DnsRecord[] | null;
  error: string | null;
  sslActive: boolean;
  /** Apple Pay is registered PER DOMAIN — without this the button never renders. */
  applePayRegistered: boolean;
  verifiedAt: string | null;
  createdAt: string;
}
