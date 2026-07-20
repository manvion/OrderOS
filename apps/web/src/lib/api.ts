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

import type {
  BillingInterval,
  PlanDefinition,
  PlanPrice,
  PlanTier,
  SubscriptionStatus,
  TaxComponent,
} from '@dinedirect/shared';

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
// --- Catering & parties ------------------------------------------------------

export interface CateringPackage {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  pricePerPersonCents: number;
  minPeople: number;
  maxPeople: number | null;
  isActive: boolean;
  sortOrder: number;
}

export type CateringType = 'PACKAGE' | 'CUSTOM';
export type CateringStatus = 'NEW' | 'IN_PROGRESS' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED';

export interface CateringRequest {
  id: string;
  type: CateringType;
  status: CateringStatus;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  headCount: number;
  eventDate: string;
  fulfillment: 'PICKUP' | 'DELIVERY';
  deliveryAddress: string | null;
  message: string | null;
  packageId: string | null;
  packageName: string | null;
  pricePerPersonCents: number | null;
  totalCents: number | null;
  paymentStatus: 'PENDING' | 'PAID' | 'FAILED' | 'REFUNDED' | 'PARTIALLY_REFUNDED';
  createdAt: string;
}

export interface CateringOffering {
  enabled: boolean;
  packages: CateringPackage[];
}

/** What the storefront catering form submits. */
export interface CateringSubmission {
  type: CateringType;
  packageId?: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  headCount: number;
  eventDate: string;
  fulfillment: 'PICKUP' | 'DELIVERY';
  deliveryAddress?: string;
  message?: string;
}

/** What an admin sends when creating/editing a package. */
export interface CateringPackageInput {
  name: string;
  description?: string | null;
  imageUrl?: string | null;
  pricePerPersonCents: number;
  minPeople?: number;
  maxPeople?: number | null;
  isActive?: boolean;
  sortOrder?: number;
}

// --- Reservations ------------------------------------------------------------

export interface ReservationSettings {
  enabled: boolean;
  maxPartySize: number;
  leadHours: number;
  windowDays: number;
}

export interface ReservationSlot {
  /** Local wall-clock label, e.g. "19:00". */
  time: string;
  /** The exact instant (UTC ISO) — sent back to book. */
  iso: string;
  available: boolean;
}

export interface ReservationBookInput {
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  partySize: number;
  reservedAt: string;
  notes?: string;
}

export type ReservationStatus = 'CONFIRMED' | 'SEATED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';

export interface Reservation {
  id: string;
  status: ReservationStatus;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  partySize: number;
  reservedAt: string;
  notes: string | null;
  createdAt: string;
}

/**
 * Cache policy for public storefront reads.
 *
 * The restaurant profile and menu change on the order of edits per day, not per
 * request — so caching them in Next's data cache for a short window turns "hit the
 * API on every page view" into "hit it at most once a minute per restaurant", which
 * is the difference between a snappy storefront and a slow one when the API is a
 * network hop away. A staff PREVIEW must always reflect unsaved-a-second-ago edits,
 * so it opts out entirely.
 */
function storefrontCache(previewToken?: string): RequestInit {
  return previewToken
    ? { cache: 'no-store' }
    : ({ next: { revalidate: 60 } } as RequestInit);
}

export const storefrontApi = {
  request: <T>(path: string, slug: string, init: RequestInit = {}) =>
    request<T>(path, {
      ...init,
      headers: { 'X-Restaurant-Slug': slug, ...init.headers },
    }),

  /**
   * `previewToken` (optional) unlocks an UNPUBLISHED restaurant for its own staff —
   * the pages read it from the sf-preview cookie set by /preview-gate. The API
   * validates it; an invalid or expired token is simply the public 404.
   */
  getRestaurant: (slug: string, previewToken?: string) =>
    // The slug rides in the URL (as well as the header the API reads) so Next's data
    // cache keys per-restaurant and never serves one tenant's data for another —
    // the cache is URL-keyed, and the header alone would not distinguish them.
    storefrontApi.request<StorefrontRestaurant>(
      `/storefront/restaurant?tenant=${encodeURIComponent(slug)}`,
      slug,
      {
        headers: previewToken ? { 'X-Preview-Token': previewToken } : {},
        // Public loads are cached in Next's data cache so we don't round-trip to the
        // API on every single page view — the single biggest storefront latency. A
        // staff PREVIEW must always be live, so it opts out.
        ...storefrontCache(previewToken),
      },
    ),

  getMenu: (slug: string, previewToken?: string) =>
    storefrontApi.request<MenuCategory[]>(
      `/storefront/menu?tenant=${encodeURIComponent(slug)}`,
      slug,
      {
        headers: previewToken ? { 'X-Preview-Token': previewToken } : {},
        ...storefrontCache(previewToken),
      },
    ),

  getDeliveryQuote: (slug: string, body: { address: Address; orderValueCents: number }) =>
    storefrontApi.request<DeliveryQuote>('/storefront/delivery-quote', slug, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /**
   * Address suggestions as the customer types.
   *
   * `session` groups every keystroke of one address search into a single billable
   * Google Places session — mint one per address field and reuse it until the
   * customer picks something. See AddressAutocompleteService on the API side.
   *
   * `available: false` means no geocoder key is configured; the form must fall back
   * to plain manual entry rather than showing a picker that never suggests.
   */
  suggestAddresses: (slug: string, q: string, session: string) =>
    storefrontApi.request<{ available: boolean; suggestions: AddressSuggestion[] }>(
      `/storefront/address/suggest?q=${encodeURIComponent(q)}&session=${encodeURIComponent(session)}`,
      slug,
    ),

  /** Expand a picked suggestion into a full, geocoded address. */
  resolveAddress: (slug: string, id: string, session: string) =>
    storefrontApi.request<{ address: ResolvedAddress | null }>(
      `/storefront/address/resolve?id=${encodeURIComponent(id)}&session=${encodeURIComponent(session)}`,
      slug,
    ),

  createOrder: (slug: string, body: unknown) =>
    storefrontApi.request<CreateOrderResponse>('/storefront/orders', slug, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** Live "how much does this code save me" preview for the cart page. */
  previewPromotion: (
    slug: string,
    items: Array<{ productId: string; lineTotalCents: number }>,
    code?: string,
  ) =>
    storefrontApi.request<{ discountCents: number }>('/storefront/promotions/preview', slug, {
      method: 'POST',
      body: JSON.stringify({ items, code }),
    }),

  track: (slug: string, token: string) =>
    storefrontApi.request<TrackedOrder>(`/storefront/track/${token}`, slug),

  /** The public "now serving" board -- no customer PII, safe for a TV or a QR. */
  getStatusBoard: (slug: string) =>
    storefrontApi.request<StatusBoardEntry[]>('/storefront/order-status-board', slug),

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

  /** Confirm a Razorpay (India) payment the Checkout modal just completed. */
  verifyRazorpay: (
    slug: string,
    orderId: string,
    body: { razorpayPaymentId: string; razorpaySignature: string },
  ) =>
    storefrontApi.request<{ paid: boolean }>(`/storefront/orders/${orderId}/razorpay/verify`, slug, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** Whether this restaurant offers catering, and its live packages. */
  getCatering: (slug: string) =>
    storefrontApi.request<CateringOffering>('/storefront/catering', slug),

  /** Submit a package order (→ checkoutUrl to pay) or a custom enquiry (→ lead). */
  submitCatering: (slug: string, body: CateringSubmission) =>
    storefrontApi.request<{ requestId: string; checkoutUrl: string | null }>(
      '/storefront/catering/request',
      slug,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  /** Whether the restaurant takes reservations, and the booking-form limits. */
  getReservationSettings: (slug: string) =>
    storefrontApi.request<ReservationSettings>('/storefront/reservations', slug),

  /** Bookable slots for a given YYYY-MM-DD (restaurant's timezone). */
  getReservationAvailability: (slug: string, date: string) =>
    storefrontApi.request<ReservationSlot[]>(
      `/storefront/reservations/availability?date=${encodeURIComponent(date)}`,
      slug,
    ),

  /** Book a table. Returns the confirmed slot. */
  book: (slug: string, body: ReservationBookInput) =>
    storefrontApi.request<{ reservationId: string; reservedAt: string }>(
      '/storefront/reservations',
      slug,
      { method: 'POST', body: JSON.stringify(body) },
    ),
};

/** An AI-suggested brand: a name plus a monogram spec the UI renders as SVG. */
export interface BrandIdea {
  name: string;
  tagline: string;
  initials: string;
  bg: string;
  fg: string;
  font: 'serif' | 'sans' | 'script';
}

export interface DriverContext {
  orderNumber: string;
  restaurantName: string;
  customerName: string;
  dropoffAddress: string | null;
  dropoffNotes: string | null;
  dropoffLatitude: number | null;
  dropoffLongitude: number | null;
  status: string;
  finished: boolean;
}

/**
 * The restaurant's own driver, on the /d/<token> page. No session — the token in
 * the URL is the whole credential (same model as the customer's tracking link), so
 * these calls carry nothing but the token.
 */
export const driverApi = {
  getContext: (token: string) => request<DriverContext>(`/delivery/driver/${token}`),

  ping: (token: string, lat: number, lng: number) =>
    request<{ accepted: boolean }>(`/delivery/driver/${token}/ping`, {
      method: 'POST',
      // keepalive so a fix still posts even as the driver backgrounds the tab.
      keepalive: true,
      body: JSON.stringify({ lat, lng }),
    }),

  setStatus: (
    token: string,
    status: 'OUT_FOR_DELIVERY' | 'DELIVERED',
    photo?: string,
  ) =>
    request<unknown>(`/delivery/driver/${token}/status`, {
      method: 'POST',
      body: JSON.stringify({ status, ...(photo ? { photo } : {}) }),
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
    /** The hero image. The endpoint has existed since day one with nothing calling it. */
    uploadCover: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return call<{ coverImageUrl: string }>('/restaurants/current/cover', {
        method: 'POST',
        body: form,
      });
    },

    /** Re-run background removal on the current logo. */
    removeLogoBackground: () =>
      call<{ logoUrl: string }>('/restaurants/current/logo/remove-bg', { method: 'POST' }),

    /** The immersive hero's background video. */
    uploadHeroVideo: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return call<{ heroVideoUrl: string }>('/restaurants/current/hero-video', {
        method: 'POST',
        body: form,
      });
    },

    // About page photos (also feed the hero slideshow when there's no video)
    listGallery: () => call<RestaurantGalleryImage[]>('/restaurants/current/gallery'),
    addGalleryImage: (file: File, caption?: string) => {
      const form = new FormData();
      form.append('file', file);
      if (caption) form.append('caption', caption);
      return call<RestaurantGalleryImage>('/restaurants/current/gallery', {
        method: 'POST',
        body: form,
      });
    },
    removeGalleryImage: (id: string) =>
      call<{ success: boolean }>(`/restaurants/current/gallery/${id}`, { method: 'DELETE' }),
    getPublishReadiness: () => call<PublishReadiness>('/restaurants/current/publish-readiness'),
    publish: () => call<Restaurant>('/restaurants/current/publish', { method: 'POST' }),
    /** A 30-minute link to view the storefront BEFORE it's published. */
    createPreviewLink: () =>
      call<{ url: string; expiresAt: string }>('/restaurants/current/preview-link', {
        method: 'POST',
      }),

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

    /** Is menu-from-photo configured on this deployment? Decides whether to show the button. */
    getMenuImportAvailability: () => call<{ available: boolean }>('/menu/import/availability'),

    /**
     * Photograph -> structured menu DRAFT. Nothing is written by this call; the
     * draft is reviewed and edited in the dashboard, and only approved rows are
     * created — through createCategory/createProduct like any manual entry.
     */
    /** Same draft as the photo path — the menu already lives on a web page. */
    importMenuFromLink: (url: string) =>
      call<MenuImportDraft>('/menu/import/url', {
        method: 'POST',
        body: JSON.stringify({ url }),
      }),

    importMenuFromPhoto: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return call<MenuImportDraft>('/menu/import/photo', { method: 'POST', body: form });
    },

    /**
     * One AI-written sentence from just the item's name + category. `language`
     * picks English, French, or both (two lines) — defaults to English.
     */
    generateProductDescription: (
      name: string,
      categoryName?: string,
      language: 'EN' | 'FR' | 'BOTH' = 'EN',
    ) =>
      call<{ description: string }>('/menu/ai-description', {
        method: 'POST',
        body: JSON.stringify({ name, categoryName, language }),
      }),

    /** A few AI brand ideas (name + monogram spec) from a one-line brief. */
    generateBrandIdeas: (brief?: string) =>
      call<{ ideas: BrandIdea[] }>('/menu/ai-brand', {
        method: 'POST',
        body: JSON.stringify({ brief }),
      }),


    // Catering
    listCateringPackages: () => call<CateringPackage[]>('/catering/packages'),
    createCateringPackage: (body: CateringPackageInput) =>
      call<CateringPackage>('/catering/packages', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    updateCateringPackage: (id: string, body: Partial<CateringPackageInput>) =>
      call<CateringPackage>(`/catering/packages/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    deleteCateringPackage: (id: string) =>
      call<{ success: boolean }>(`/catering/packages/${id}`, { method: 'DELETE' }),
    generateCateringPackageDescription: (name?: string, language: 'EN' | 'FR' | 'BOTH' = 'EN') =>
      call<{ description: string }>('/catering/ai-package', {
        method: 'POST',
        body: JSON.stringify({ name, language }),
      }),
    // Reservations
    listReservations: () => call<Reservation[]>('/reservations'),
    setReservationStatus: (id: string, status: ReservationStatus) =>
      call<Reservation>(`/reservations/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      }),

    listCateringRequests: () => call<CateringRequest[]>('/catering/requests'),
    setCateringRequestStatus: (id: string, status: CateringStatus) =>
      call<CateringRequest>(`/catering/requests/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      }),

    // Orders
    listActiveOrders: () => call<Order[]>('/orders/active'),
    /** Order history -- every PAID order ever placed, newest first. Cursor-paginated. */
    listOrders: (params?: {
      status?: string;
      from?: string;
      to?: string;
      cursor?: string;
      limit?: number;
    }) => {
      const qs = new URLSearchParams();
      if (params?.status) qs.set('status', params.status);
      if (params?.from) qs.set('from', params.from);
      if (params?.to) qs.set('to', params.to);
      if (params?.cursor) qs.set('cursor', params.cursor);
      if (params?.limit) qs.set('limit', String(params.limit));
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
    /** Override the countdown the public status board shows for this order. */
    setOrderEta: (id: string, minutesFromNow: number) =>
      call<Order>(`/orders/${id}/eta`, {
        method: 'PATCH',
        body: JSON.stringify({ minutesFromNow }),
      }),
    /** A walk-in or phone order, paid at the counter -- cash or a card terminal. */
    createWalkInOrder: (body: {
      items: Array<{ productId: string; quantity: number; notes?: string; modifierIds: string[] }>;
      fulfillment: 'PICKUP' | 'DINE_IN';
      customerName?: string;
      customerPhone?: string;
      customerEmail?: string;
      tableNumber?: string;
      paymentMethod: 'CASH' | 'CARD_TERMINAL';
      notes?: string;
    }) => call<Order>('/orders/walk-in', { method: 'POST', body: JSON.stringify(body) }),

    // Payments
    getStripeStatus: () => call<StripeStatus>('/payments/connect/status'),
    createStripeOnboardingLink: () =>
      call<{ url: string }>('/payments/connect/onboarding-link', { method: 'POST' }),
    /** Edit bank account, payout schedule, business details — Stripe's own dashboard. */
    createStripeManageLink: () =>
      call<{ url: string }>('/payments/connect/manage-link', { method: 'POST' }),

    // Razorpay Route (India payments)
    createRazorpayOnboarding: () =>
      call<{ accountId: string; alreadyConnected: boolean }>('/payments/razorpay/onboarding', {
        method: 'POST',
      }),
    getRazorpayStatus: () =>
      call<{ connected: boolean; enabled: boolean; status: string | null }>(
        '/payments/razorpay/status',
      ),
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

    // Promotions
    listPromotions: () => call<Promotion[]>('/promotions'),
    createPromotion: (body: unknown) =>
      call<Promotion>('/promotions', { method: 'POST', body: JSON.stringify(body) }),
    setPromotionActive: (id: string, isActive: boolean) =>
      call<Promotion>(`/promotions/${id}/active`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive }),
      }),
    deletePromotion: (id: string) =>
      call<{ success: boolean }>(`/promotions/${id}`, { method: 'DELETE' }),

    // Staff & invitations
    listStaff: () => call<StaffMember[]>('/restaurants/current/staff'),
    updateStaffRole: (id: string, role: string) =>
      call<StaffMember>(`/restaurants/current/staff/${id}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      }),
    removeStaff: (id: string) =>
      call<{ success: boolean }>(`/restaurants/current/staff/${id}`, { method: 'DELETE' }),
    getActivity: (params?: { userId?: string; limit?: number }) => {
      const qs = new URLSearchParams();
      if (params?.userId) qs.set('userId', params.userId);
      if (params?.limit) qs.set('limit', String(params.limit));
      const query = qs.toString();
      return call<ActivityLogEntry[]>(`/restaurants/current/activity${query ? `?${query}` : ''}`);
    },
    listInvites: () => call<StaffInvite[]>('/restaurants/current/invites'),
    inviteStaff: (body: { email: string; role: string }) =>
      call<StaffInvite>('/restaurants/current/invites', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    revokeInvite: (id: string) =>
      call<{ success: boolean }>(`/restaurants/current/invites/${id}`, { method: 'DELETE' }),

    // Shift scheduling. Staff always get back only their own shifts regardless
    // of `userId` -- the API enforces that scoping, not this client.
    listShifts: (params?: { userId?: string; from?: string; to?: string }) => {
      const qs = new URLSearchParams();
      if (params?.userId) qs.set('userId', params.userId);
      if (params?.from) qs.set('from', params.from);
      if (params?.to) qs.set('to', params.to);
      const query = qs.toString();
      return call<Shift[]>(`/shifts${query ? `?${query}` : ''}`);
    },
    createShift: (body: { userId: string; startsAt: string; endsAt: string; note?: string }) =>
      call<Shift>('/shifts', { method: 'POST', body: JSON.stringify(body) }),
    updateShift: (
      id: string,
      body: Partial<{ userId: string; startsAt: string; endsAt: string; note: string }>,
    ) => call<Shift>(`/shifts/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    deleteShift: (id: string) => call<{ success: boolean }>(`/shifts/${id}`, { method: 'DELETE' }),

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
    /** Comp a restaurant onto a plan for free. Returns their new plan state. */
    adminSetPlan: (id: string, tier: PlanTier) =>
      call<PlanState>(`/admin/restaurants/${id}/plan`, {
        method: 'PATCH',
        body: JSON.stringify({ tier }),
      }),

    // Book-a-demo leads
    adminListDemoRequests: (status?: string) =>
      call<DemoRequest[]>(`/admin/demo-requests${status ? `?status=${encodeURIComponent(status)}` : ''}`),
    adminUpdateDemoRequest: (id: string, status: DemoRequestStatus) =>
      call<DemoRequest>(`/admin/demo-requests/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
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
      call<Array<{ date: string; revenueCents: number; payoutCents: number; orderCount: number }>>(
        `/analytics/revenue?period=${period}`,
      ),
    getTopProducts: (period = '30d') =>
      call<Array<{ name: string; unitsSold: number; revenueCents: number }>>(
        `/analytics/top-products?period=${period}`,
      ),
    getDeliveryEconomics: (period = '30d') =>
      call<DeliveryEconomics>(`/analytics/delivery-economics?period=${period}`),

    /** `from`/`to` are ISO date strings, e.g. "2026-07-01". */
    getTaxReport: (from: string, to: string) =>
      call<TaxReport>(
        `/analytics/tax-report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      ),

    /** Raw text, not JSON -- can't go through `call`, which always parses the body. */
    downloadTaxReportCsv: async (from: string, to: string): Promise<Blob> => {
      const token = await getToken();
      const res = await fetch(
        `${API_URL}/api/analytics/tax-report.csv?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            ...(restaurantId ? { 'X-Restaurant-Id': restaurantId } : {}),
          },
        },
      );
      if (!res.ok) throw new Error('Could not download the report');
      return res.blob();
    },

    // Subscription / billing
    /** Current plan + the tiers this restaurant can move to, priced in its currency. */
    getPlanState: () => call<PlanState>('/subscriptions/plan'),
    /** Start Stripe Checkout for a paid plan. Returns a URL to send the browser to. */
    createPlanCheckout: (tier: PlanTier, interval: BillingInterval) =>
      call<{ checkoutUrl: string }>('/subscriptions/checkout', {
        method: 'POST',
        body: JSON.stringify({ tier, interval }),
      }),
    /** A link into Stripe's billing portal to change card, switch plan, or cancel. */
    createBillingPortal: () =>
      call<{ url: string }>('/subscriptions/portal', { method: 'POST' }),
    /** Apply a just-finished checkout immediately (called on the success return). */
    reconcilePlanCheckout: (sessionId: string) =>
      call<PlanState>('/subscriptions/reconcile', {
        method: 'POST',
        body: JSON.stringify({ sessionId }),
      }),
  };
}

export type DashboardApi = ReturnType<typeof createDashboardApi>;

/**
 * The public pricing table for the marketing page — no session, localised by
 * currency. `currency` is optional; the server falls back to USD.
 */
export function getPlanPricing(currency?: string) {
  const qs = currency ? `?currency=${encodeURIComponent(currency)}` : '';
  return request<PublicPricing>(`/subscriptions/pricing${qs}`);
}

export interface DemoRequestInput {
  name: string;
  email: string;
  phone?: string;
  restaurantName?: string;
  city?: string;
  message?: string;
  interest?: string;
}

/** Submit a "book a demo" / done-for-you-setup enquiry from the marketing page. */
export function submitDemoRequest(body: DemoRequestInput) {
  return request<{ received: boolean }>('/demo-requests', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// --- Types ------------------------------------------------------------------

/** One tier as priced for a specific restaurant, with its full definition attached. */
export interface PlanPriceWithDefinition extends PlanPrice {
  plan: PlanDefinition;
}

/** A tier option in the current restaurant's context — same, plus "is this my plan". */
export interface PlanTierOption extends PlanPriceWithDefinition {
  current: boolean;
}

/** The signed-in restaurant's subscription state. Mirrors SubscriptionsService.getPlanState. */
export interface PlanState {
  tier: PlanTier;
  status: SubscriptionStatus;
  interval: BillingInterval | null;
  currentPeriodEnd: string | null;
  currency: string;
  plan: PlanDefinition;
  commissionBps: number;
  /** True when a live Stripe subscription exists — show "Manage billing". */
  manageable: boolean;
  pricing: PlanTierOption[];
}

/** The public pricing table for the marketing page. */
export interface PublicPricing {
  currency: string;
  tiers: PlanPriceWithDefinition[];
}

export interface Address {
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  latitude?: number;
  longitude?: number;
}

/**
 * What Claude read off a photographed menu — a draft for the owner to review,
 * never something that lands on the live menu unedited. `priceCents: null` means
 * the price was illegible; the review form forces a human to type it.
 */
export interface MenuImportDraft {
  categories: Array<{
    name: string;
    items: Array<{
      name: string;
      description: string | null;
      priceCents: number | null;
    }>;
  }>;
  warnings: string[];
}

/** One row in the address autocomplete dropdown. `id` is opaque — pass it back as-is. */
export interface AddressSuggestion {
  id: string;
  /** The bold line: "221B Baker Street". */
  primary: string;
  /** The grey line: "London, UK". */
  secondary: string;
}

/**
 * A suggestion the customer picked, expanded into a real address with coordinates.
 *
 * Deliberately NOT `extends Address`: the geocoder can return a match it cannot pin
 * to a point, so lat/lng are explicitly nullable here, whereas on `Address` they are
 * merely optional. Widening them in an extends clause is a type error, and papering
 * over it with `?` would hide the one case the caller has to handle.
 */
export interface ResolvedAddress {
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  latitude: number | null;
  longitude: number | null;
  /** The provider's one-line rendering — what they actually clicked on. */
  formatted: string;
}

/**
 * WEBSITE — the full storefront: homepage, about page, menu.
 * QR_ONLY — no website. The only way in is scanning a code on the table, so the
 *           root redirects to the menu, the marketing pages are gone, and the page
 *           is noindexed.
 */
export type OrderingMode = 'WEBSITE' | 'QR_ONLY';

export interface RestaurantGalleryImage {
  id: string;
  url: string;
  caption: string | null;
  sortOrder: number;
}

export interface StorefrontRestaurant {
  id: string;
  slug: string;
  name: string;
  /** False only ever reaches a browser through a staff preview token. */
  isPublished: boolean;
  description: string | null;
  orderingMode: OrderingMode;

  /** The About page, in their own words. PLAIN TEXT — never render it as HTML. */
  aboutHeadline: string | null;
  aboutBody: string | null;
  aboutHeadlineFr: string | null;
  aboutBodyFr: string | null;
  galleryImages: RestaurantGalleryImage[];
  phone: string;
  street: string;
  city: string;
  state: string;
  postalCode: string;
  /**
   * ISO-3166 alpha-2. The API has always returned this; it just wasn't on the type,
   * so the checkout form defaulted every customer's address to 'US'. It drives the
   * address default, the geocoder's country bias, and the tax regime.
   */
  country: string;
  logoUrl: string | null;
  coverImageUrl: string | null;
  /** Optional background video (.mp4/.webm) for the immersive hero. */
  heroVideoUrl: string | null;
  /** A short, stylable hero tagline in the restaurant's own words. */
  heroTagline: string | null;
  heroTaglineColor: string | null;
  heroTaglineFont: 'DISPLAY' | 'SERIF' | 'SANS' | 'MONO' | 'SCRIPT';
  brandPrimaryColor: string;
  brandAccentColor: string;
  /** Three genuinely different storefront layouts -- see the homepage, which
   *  branches its whole render tree on this. */
  websiteTemplate: 'CLASSIC' | 'BOLD' | 'MINIMAL' | 'RUSTIC' | 'BUILDER' | 'BENTO' | 'ELEGANT' | 'PUNCHY' | 'SIGNATURE';
  themeMode: 'LIGHT' | 'DARK';
  logoDisplayMode: 'LOGO_AND_NAME' | 'LOGO_ONLY' | 'NAME_ONLY';
  logoColor: string;
  heroLogoColor: string;
  /** Header logo size as a percentage of default (100 = default). */
  logoScale: number;
  /** Soft brand-coloured backdrop behind the header logo. */
  logoBackdrop: boolean;
  /** Text-wordmark styling for the restaurant name in the header. */
  nameFont: 'DISPLAY' | 'SERIF' | 'SANS' | 'MONO' | 'SCRIPT';
  nameColor: string | null;
  nameTransform: 'NONE' | 'UPPERCASE';
  /** The restaurant's own social profiles, shown as an icon row on the storefront. */
  socialLinks: Array<{ platform: string; url: string }> | null;
  currency: string;
  timezone: string;
  isOpen: boolean;
  acceptingOrders: boolean;
  /** Pro plan: hide the "Powered by DineDirect" footer — fully the restaurant's brand. */
  removeBranding: boolean;
  /** Growth/Pro: show the "Catering & Parties" entry and page. */
  cateringEnabled: boolean;
  /** Drives the storefront "Reserve" nav entry; slots come from a separate call. */
  reservationsEnabled: boolean;
  /** Content language(s). BOTH shows the customer a French/English toggle. */
  menuLanguage: 'EN' | 'FR' | 'BOTH';
  pickupEnabled: boolean;
  deliveryEnabled: boolean;
  dineInEnabled: boolean;
  scheduledOrdersEnabled: boolean;
  deliveryFeeCents: number;
  minOrderCents: number;
  serviceFeeCents: number;
  taxRateBps: number;
  /** Named tax components (GST/QST, …). Preferred over taxRateBps when present. */
  taxComponents: Array<{ name: string; rateBps: number }> | null;
  prepTimeMinutes: number;
  businessHours: unknown;
  loyaltyEnabled: boolean;
  loyaltyPointsPerDollar: number;
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
  /** French name/description for a bilingual storefront; null falls back to default. */
  nameFr: string | null;
  description: string | null;
  descriptionFr: string | null;
  priceCents: number;
  imageUrl: string | null;
  modifierGroups: MenuModifierGroup[];
  /** e.g. "10% OFF". Null when no active promotion covers this item. */
  promoLabel: string | null;
}

export interface MenuCategory {
  id: string;
  name: string;
  nameFr: string | null;
  description: string | null;
  products: MenuProduct[];
}

export type DeliveryQuote =
  | {
      deliverable: true;
      customerFeeCents: number;
      /** What the COURIER charges the restaurant — Uber or DoorDash, whoever won. */
      courierFeeCents: number | null;
      /** Which courier gave us this price. Null for self-delivery. */
      provider?: 'UBER' | 'DOORDASH';
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

/** How the customer pays — Stripe (hosted redirect) or Razorpay (Checkout modal). */
export type OrderPayment =
  | { provider: 'STRIPE'; checkoutUrl: string }
  | {
      provider: 'RAZORPAY';
      razorpayOrderId: string;
      keyId: string;
      amount: number;
      currency: string;
      restaurantName: string;
      orderNumber: string;
      prefill: { name: string; email: string; contact: string };
    };

export interface CreateOrderResponse {
  orderId: string;
  orderNumber: string;
  trackingToken: string;
  totalCents: number;
  currency: string;
  /** Present for Stripe orders (kept for backward compatibility). */
  checkoutUrl?: string;
  /** The provider-tagged payment instructions the client should branch on. */
  payment: OrderPayment;
}

export interface StatusBoardEntry {
  /** Last 3 digits of the order number -- see OrdersService.listStatusBoard. */
  shortId: string;
  status: string;
  fulfillment: string;
  tableNumber: string | null;
  createdAt: string;
  acceptedAt: string | null;
  estimatedReadyAt: string | null;
  customerFirstName: string | null;
}

export interface TrackedOrder {
  /** The unguessable key to this order's tracking page. */
  trackingToken: string;
  orderNumber: string;
  tableNumber: string | null;
  status: string;
  fulfillment: string;
  totalCents: number;
  currency: string;
  subtotalCents: number;
  /** Promo discount applied to the order. 0 when none. */
  discountCents: number;
  taxCents: number;
  /** Tax broken out by name (GST, QST, …) exactly as charged. Null on legacy orders. */
  taxLines: Array<{ name: string; amountCents: number }> | null;
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
  /** Drives currency, timezone, tax regime, Stripe eligibility, and the tax-number format. */
  country: string;
  /**
   * The legal identity behind the brand: the entity a receipt is issued BY, and the
   * tax number that makes that receipt valid. Null for a restaurant below a
   * registration threshold, and for everyone who signed up before we asked.
   */
  legalName: string | null;
  taxId: string | null;
  businessNumber: string | null;
  logoUrl: string | null;
  /** The hero image at the top of their page. */
  coverImageUrl: string | null;
  /** Optional background video (.mp4/.webm) for the immersive hero. */
  heroVideoUrl: string | null;
  /** A short, stylable hero tagline in the restaurant's own words. */
  heroTagline: string | null;
  heroTaglineColor: string | null;
  heroTaglineFont: 'DISPLAY' | 'SERIF' | 'SANS' | 'MONO' | 'SCRIPT';
  brandPrimaryColor: string;
  brandAccentColor: string;
  websiteTemplate: 'CLASSIC' | 'BOLD' | 'MINIMAL' | 'RUSTIC' | 'BUILDER' | 'BENTO' | 'ELEGANT' | 'PUNCHY' | 'SIGNATURE';
  themeMode: 'LIGHT' | 'DARK';
  logoDisplayMode: 'LOGO_AND_NAME' | 'LOGO_ONLY' | 'NAME_ONLY';
  logoColor: string;
  heroLogoColor: string;
  /** Header logo size as a percentage of default (100 = default). */
  logoScale: number;
  /** Soft brand-coloured backdrop behind the header logo. */
  logoBackdrop: boolean;
  /** Text-wordmark styling for the restaurant name in the header. */
  nameFont: 'DISPLAY' | 'SERIF' | 'SANS' | 'MONO' | 'SCRIPT';
  nameColor: string | null;
  nameTransform: 'NONE' | 'UPPERCASE';
  /** The restaurant's own social profiles, shown as an icon row on the storefront. */
  socialLinks: Array<{ platform: string; url: string }> | null;
  /** Table reservations — "simple capacity per slot". */
  reservationsEnabled: boolean;
  reservationCapacityPerSlot: number;
  reservationSlotMinutes: number;
  reservationMaxPartySize: number;
  reservationLeadHours: number;
  reservationWindowDays: number;
  /** Content language(s) — drives the AI-fill language options. */
  menuLanguage: 'EN' | 'FR' | 'BOTH';
  /** About page content. Plain text, never HTML. */
  aboutHeadline: string | null;
  aboutBody: string | null;
  aboutHeadlineFr: string | null;
  aboutBodyFr: string | null;
  timezone: string;
  /** Derived from the country, never chosen. See deriveLocaleDefaults in @dinedirect/shared. */
  currency: string;
  /** The tax actually charged, as named lines. Null for a restaurant that never set it. */
  taxComponents: TaxComponent[] | null;
  taxCountry: string | null;
  taxRegion: string | null;
  isPublished: boolean;
  onboardingStep: string;
  stripeChargesEnabled: boolean;
  uberDirectEnabled: boolean;
  doorDashEnabled: boolean;
  /** Dispatch a Porter courier (India). */
  porterEnabled: boolean;
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
  loyaltyEnabled: boolean;
  loyaltyPointsPerDollar: number;
}

export type RestaurantWithRole = Restaurant & { role: 'OWNER' | 'MANAGER' | 'STAFF' };

/**
 * One step on the road to taking money. Defined once, in
 * packages/shared/src/setup.ts, and used by the owner's setup page, the publish
 * gate AND the platform console — so when an owner phones up saying "it won't let
 * me go live", support is looking at the identical list.
 */
export interface SetupStep {
  id: string;
  label: string;
  /** Why it matters. A checklist without reasons is a chore list. */
  why: string;
  done: boolean;
  /** Required steps block publishing. The rest is advice, and advice never blocks. */
  required: boolean;
  href: string;
}

export interface SetupProgress {
  done: number;
  total: number;
}

export interface PublishReadiness {
  ready: boolean;
  steps: SetupStep[];
  progress: SetupProgress;
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
  /** Manually-entered French name/description for a bilingual storefront. */
  nameFr: string | null;
  description: string | null;
  descriptionFr: string | null;
  priceCents: number;
  imageUrl: string | null;
  isAvailable: boolean;
  sortOrder: number;
  trackInventory: boolean;
  stockQuantity: number;
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
  /** Countdown target shown on the public status board. Null until accepted. */
  estimatedReadyAt: string | null;
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
  /** For a SELF delivery: the capability token behind the /d/<token> driver link. */
  driverShareToken: string | null;
  /** Proof-of-delivery photo the driver took at handover, if any. */
  proofOfDeliveryUrl: string | null;
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
    loyaltyPoints: number;
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
  type: 'TABLE' | 'FLYER' | 'COUNTER' | 'BOARD';
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

export interface Promotion {
  id: string;
  name: string;
  type: 'PERCENT' | 'FIXED';
  value: number;
  code: string | null;
  /** Empty = whole order. Non-empty = only these product ids are discounted + tagged. */
  productIds: string[];
  minSubtotalCents: number;
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
  redemptions: number;
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  totalOrders: number;
  totalSpentCents: number;
  lastOrderAt: string | null;
  loyaltyPoints: number;
}

export interface AnalyticsOverview {
  period: string;
  /** Gross, net of refunds only -- what customers paid. */
  revenueCents: number;
  /** Gross minus platform commission minus courier cost -- what actually lands
   *  in the restaurant's Stripe payout (before Stripe's own processing fee,
   *  which Stripe's own payout report shows exactly). This is "your money". */
  payoutCents: number;
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

export interface Shift {
  id: string;
  startsAt: string;
  endsAt: string;
  note: string | null;
  userId: string;
  user: { id: string; firstName: string | null; lastName: string | null; email: string };
}

export interface ActivityLogEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  user: { id: string; firstName: string | null; lastName: string | null; email: string } | null;
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

export interface TaxReport {
  from: string;
  to: string;
  /** Whatever tax component names actually appeared in this window's orders, e.g. ["GST", "QST"]. */
  taxNames: string[];
  summary: {
    subtotalCents: number;
    discountCents: number;
    taxCents: number;
    totalCents: number;
    orderCount: number;
  };
  taxByName: Array<{ name: string; amountCents: number }>;
  daily: Array<{
    date: string;
    subtotalCents: number;
    discountCents: number;
    taxCents: number;
    totalCents: number;
    orderCount: number;
    taxByName: Record<string, number>;
  }>;
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

export type DemoRequestStatus = 'NEW' | 'CONTACTED' | 'SCHEDULED' | 'WON' | 'LOST';

export interface DemoRequest {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  restaurantName: string | null;
  city: string | null;
  message: string | null;
  interest: string | null;
  status: DemoRequestStatus;
  handledByAdmin: string | null;
  handledAt: string | null;
  createdAt: string;
}

export interface AdminRestaurant {
  id: string;
  name: string;
  slug: string;
  email: string;
  phone: string;
  city: string;
  /** QR_ONLY restaurants have no website — the printed code is the only way in. */
  orderingMode: OrderingMode;
  isActive: boolean;
  isPublished: boolean;
  onboardingStep: string;
  stripeChargesEnabled: boolean;
  platformFeeBps: number;
  /** Which SaaS tier they're on. */
  planTier: PlanTier;
  /** Subscription lifecycle state. */
  subscriptionStatus: SubscriptionStatus;
  createdAt: string;
  _count: { orders: number; products: number; users: number };

  /** How far through setup they are. Required steps only. */
  setupProgress: SetupProgress;
  /** Exactly what is stopping them going live. The reason to call them. */
  publishBlockers: string[];
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
