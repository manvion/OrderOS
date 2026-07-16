import { z } from 'zod';
import { WEEKDAYS } from './hours';
import { SUPPORTED_TAX_COUNTRIES, taxComponentSchema } from './tax';

/**
 * Validation schemas shared by the API (DTO validation) and the web app
 * (react-hook-form resolvers), so a form can never submit something the API
 * would reject for a reason the form didn't already surface.
 */

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be HH:mm');

export const hoursWindowSchema = z.object({ open: hhmm, close: hhmm });

export const dayHoursSchema = z.object({
  closed: z.boolean(),
  windows: z.array(hoursWindowSchema).max(3),
});

export const businessHoursSchema = z.object(
  WEEKDAYS.reduce(
    (acc, day) => ({ ...acc, [day]: dayHoursSchema }),
    {} as Record<(typeof WEEKDAYS)[number], typeof dayHoursSchema>,
  ),
);

export const addressSchema = z.object({
  street: z.string().min(1).max(200),
  city: z.string().min(1).max(100),
  state: z.string().min(2).max(50),
  postalCode: z.string().min(3).max(12),
  country: z.string().length(2).default('US'),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});
export type AddressInput = z.infer<typeof addressSchema>;

/**
 * Subdomain slug: this becomes `<slug>.dinedirect.manvion.ca`, so it must be DNS-safe and
 * must not collide with our own reserved hostnames.
 */
export const RESERVED_SLUGS = [
  'www',
  'api',
  'app',
  'admin',
  'dashboard',
  'auth',
  'static',
  'assets',
  'cdn',
  'mail',
  'support',
  'docs',
  'status',
  'blog',
];

export const slugSchema = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Lowercase letters, numbers and hyphens only')
  .refine((s) => !RESERVED_SLUGS.includes(s), 'This name is reserved');

/**
 * Everything needed to create a restaurant that is SAFE to take an order.
 *
 * The optional fields below are optional to the *type*, not to the product: the
 * signup wizard collects every one of them. They are optional here only so the
 * admin's "create on behalf" flow and the seed can skip them.
 *
 * Why they moved into signup at all: each one has a default, and every default is
 * a quiet lie about somebody's business.
 *
 *  - taxRateBps defaults to 0. A restaurant that never finds Settings goes live
 *    under-collecting tax on every single order. They find out at audit, and blame us.
 *  - businessHours defaults to 11:00-22:00, seven days. A restaurant closed on
 *    Mondays takes Monday orders it cannot cook.
 *  - pickupEnabled defaults to true. A delivery-only kitchen silently offers a
 *    pickup counter it does not have.
 *
 * A default that is right for nobody is worse than a question.
 */
export const createRestaurantSchema = z.object({
  name: z.string().min(2).max(120),
  slug: slugSchema,
  phone: z.string().min(7).max(20),
  email: z.string().email(),
  address: addressSchema,
  timezone: z.string().min(1).default('America/New_York'),
  currency: z.string().length(3).default('USD'),

  description: z.string().max(1000).optional(),

  /** Real opening hours, not our guess at them. */
  businessHours: businessHoursSchema.optional(),

  // How they actually serve food.
  pickupEnabled: z.boolean().optional(),
  deliveryEnabled: z.boolean().optional(),
  dineInEnabled: z.boolean().optional(),

  /**
   * WEBSITE (default) or QR_ONLY — a restaurant that wants no website at all and
   * takes every order through a scanned code. See the OrderingMode enum.
   */
  orderingMode: z.enum(['WEBSITE', 'QR_ONLY']).optional(),

  /** Basis points. Asked explicitly, never assumed — see above. */
  taxRateBps: z.number().int().min(0).max(3000).optional(),

  /**
   * Named tax components. The real path for Canada (GST + QST) and India
   * (CGST + SGST), where the law requires each to be printed under its own name.
   */
  taxComponents: z.array(taxComponentSchema).max(4).optional(),
  taxCountry: z.enum(SUPPORTED_TAX_COUNTRIES).optional(),
  taxRegion: z.string().max(40).optional(),
  deliveryFeeCents: z.number().int().min(0).max(100_00).optional(),
  serviceFeeCents: z.number().int().min(0).max(50_00).optional(),
  minOrderCents: z.number().int().min(0).max(500_00).optional(),
  prepTimeMinutes: z.number().int().min(1).max(180).optional(),
});
export type CreateRestaurantInput = z.infer<typeof createRestaurantSchema>;

export const updateRestaurantSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  phone: z.string().min(7).max(20).optional(),
  email: z.string().email().optional(),
  address: addressSchema.optional(),

  /**
   * Overridable, but DERIVED from the address when it isn't sent.
   *
   * A country with one timezone needs no picker at all; a country with six needs the
   * owner to say which. Either way the address decides the default — see
   * deriveLocaleDefaults() in ./countries.
   */
  timezone: z.string().min(1).optional(),

  /**
   * Note what is NOT here: `currency`.
   *
   * Currency is not a preference, it is a fact about where the restaurant is. A
   * restaurant in Toronto is paid in CAD, and a form that lets them choose USD is a
   * form that lets them silently mis-price their entire menu — the numbers on the
   * products don't change, only the symbol in front of them. So the server derives it
   * from the country and the client cannot override it.
   */

  /**
   * The rate actually charged. Pre-filled from the jurisdiction, then CONFIRMED or
   * corrected by the owner — never applied silently. See the honesty note in ./tax.
   */
  taxComponents: z.array(taxComponentSchema).max(4).optional(),
  taxCountry: z.enum(SUPPORTED_TAX_COUNTRIES).optional(),
  taxRegion: z.string().max(40).optional(),

  logoUrl: z.string().url().nullable().optional(),
  coverImageUrl: z.string().url().nullable().optional(),
  description: z.string().max(1000).nullable().optional(),

  /**
   * The About page, in the restaurant's own words.
   *
   * PLAIN TEXT. Blank lines separate paragraphs; that is the entire formatting
   * model. It is never parsed as HTML or markdown — see aboutParagraphs().
   */
  aboutHeadline: z.string().max(120).nullable().optional(),
  aboutBody: z.string().max(4000).nullable().optional(),

  /**
   * Who the restaurant is to a tax authority.
   *
   * The shape of `taxId` depends entirely on the country, so it cannot be checked
   * here — validate it with isValidTaxId(country, value) from './countries', which
   * knows that a GSTIN is not an ABN. This schema only stops absurd input.
   */
  legalName: z.string().max(160).nullable().optional(),
  taxId: z.string().max(30).nullable().optional(),
  businessNumber: z.string().max(40).nullable().optional(),

  businessHours: businessHoursSchema.optional(),
  orderingMode: z.enum(['WEBSITE', 'QR_ONLY']).optional(),
  brandPrimaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex colour like #FF5722')
    .optional(),
  brandAccentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  websiteTemplate: z
    .enum(['CLASSIC', 'BOLD', 'MINIMAL', 'RUSTIC', 'BUILDER', 'BENTO', 'ELEGANT', 'PUNCHY'])
    .optional(),
  themeMode: z.enum(['LIGHT', 'DARK']).optional(),
  logoDisplayMode: z.enum(['LOGO_AND_NAME', 'LOGO_ONLY', 'NAME_ONLY']).optional(),

  /**
   * Where the RESTAURANT wants to be alerted. Distinct from `phone`/`email`, which
   * are public and shown to customers: the number that gets woken up when an order
   * lands at 8pm is the pass phone, not the one on the website.
   */
  notifyPhone: z.string().min(7).max(20).nullable().optional(),
  notifyEmail: z.string().email().nullable().optional(),
  notifySmsEnabled: z.boolean().optional(),
  notifyEmailEnabled: z.boolean().optional(),

  loyaltyEnabled: z.boolean().optional(),
  /** Points credited per whole dollar of subtotal (pre-tax, pre-tip) on a paid order. */
  loyaltyPointsPerDollar: z.number().int().min(1).max(100).optional(),
});
export type UpdateRestaurantInput = z.infer<typeof updateRestaurantSchema>;

export const deliverySettingsSchema = z.object({
  deliveryEnabled: z.boolean(),
  pickupEnabled: z.boolean(),
  dineInEnabled: z.boolean(),
  scheduledOrdersEnabled: z.boolean(),
  /** What the customer pays for delivery. Not what Uber charges us. */
  deliveryFeeCents: z.number().int().min(0).max(100_00),
  deliveryRadiusMeters: z.number().int().min(500).max(50_000),
  minOrderCents: z.number().int().min(0).max(500_00),
  serviceFeeCents: z.number().int().min(0).max(50_00),
  /**
   * Tax is NOT here, and that is the point.
   *
   * It used to be a single `taxRateBps` on this schema, set from a percentage box on
   * the fulfillment form — a rate with no jurisdiction attached, that could not express
   * Quebec (GST + QST) or India (CGST + SGST), both of which legally require the
   * components to be printed as separate named lines.
   *
   * Tax now belongs to the ADDRESS (updateRestaurantSchema.taxComponents), because the
   * address is what determines it. Zod strips unknown keys, so an older client still
   * sending taxRateBps here is ignored rather than rejected — which matters, because
   * that client would be sending a stale rate that would silently clobber the itemised
   * one.
   */
  prepTimeMinutes: z.number().int().min(1).max(180),
  /** We can dispatch an Uber courier. */
  uberDirectEnabled: z.boolean(),
  /**
   * We can dispatch a DoorDash Drive courier.
   *
   * Independent of Uber, and both can be on at once. When they are, we quote BOTH on
   * every order and dispatch the cheaper — which is worth real money, because courier
   * pricing swings with surge and driver supply and the winner is not knowable in
   * advance. It is also the failover: one courier having a bad afternoon no longer
   * strands an order that is already paid for and cooked.
   */
  doorDashEnabled: z.boolean().default(false),
  /**
   * The restaurant has their own driver. If BOTH are on, the dashboard asks per
   * order rather than guessing — the right answer depends on distance and who's on
   * shift, which is knowledge the person at the pass has and we don't.
   */
  selfDeliveryEnabled: z.boolean().default(false),
});
export type DeliverySettingsInput = z.infer<typeof deliverySettingsSchema>;

export const categorySchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).nullable().optional(),
  sortOrder: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
});
export type CategoryInput = z.infer<typeof categorySchema>;

export const modifierSchema = z.object({
  id: z.string().cuid().optional(),
  name: z.string().min(1).max(80),
  priceCents: z.number().int().min(0).max(100_00),
  isAvailable: z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(0),
});

export const modifierGroupSchema = z
  .object({
    id: z.string().cuid().optional(),
    name: z.string().min(1).max(80),
    /** SINGLE renders as radios (Size), MULTIPLE as checkboxes (Extras). */
    selectionType: z.enum(['SINGLE', 'MULTIPLE']),
    required: z.boolean().default(false),
    minSelections: z.number().int().min(0).max(20).default(0),
    maxSelections: z.number().int().min(1).max(20).default(1),
    sortOrder: z.number().int().min(0).default(0),
    modifiers: z.array(modifierSchema).min(1).max(50),
  })
  .refine((g) => g.maxSelections >= g.minSelections, {
    message: 'maxSelections must be >= minSelections',
    path: ['maxSelections'],
  })
  .refine((g) => g.selectionType !== 'SINGLE' || g.maxSelections === 1, {
    message: 'A SINGLE-select group can allow at most one selection',
    path: ['maxSelections'],
  })
  .refine((g) => !g.required || g.minSelections >= 1, {
    message: 'A required group must require at least one selection',
    path: ['minSelections'],
  });
export type ModifierGroupInput = z.infer<typeof modifierGroupSchema>;

export const productSchema = z.object({
  categoryId: z.string().cuid(),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).nullable().optional(),
  priceCents: z.number().int().min(0).max(1000_00),
  imageUrl: z.string().url().nullable().optional(),
  isAvailable: z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(0),
  trackInventory: z.boolean().default(false),
  stockQuantity: z.number().int().min(0).max(1_000_000).default(0),
  modifierGroups: z.array(modifierGroupSchema).max(10).default([]),
});
export type ProductInput = z.infer<typeof productSchema>;

/**
 * What the browser sends at checkout. Note it contains NO prices — the API
 * looks every price up from the database. A client that sends a $0 burger gets
 * charged the real price.
 */
export const cartItemSchema = z.object({
  productId: z.string().cuid(),
  quantity: z.number().int().min(1).max(99),
  notes: z.string().max(280).optional(),
  modifierIds: z.array(z.string().cuid()).max(50).default([]),
});
export type CartItemInput = z.infer<typeof cartItemSchema>;

export const createOrderSchema = z
  .object({
    items: z.array(cartItemSchema).min(1).max(100),
    fulfillment: z.enum(['PICKUP', 'DELIVERY', 'DINE_IN']),
    customer: z.object({
      name: z.string().min(1).max(120),
      phone: z.string().min(7).max(20),
      email: z.string().email(),
    }),
    deliveryAddress: addressSchema.optional(),
    /** ISO 8601. Absent means "as soon as possible". */
    scheduledFor: z.string().datetime().optional(),
    tipCents: z.number().int().min(0).max(500_00).default(0),
    notes: z.string().max(500).optional(),
    /** Set when the order came from a table QR code. */
    tableNumber: z.string().max(20).optional(),
    qrCodeId: z.string().cuid().optional(),
    /** Customer-entered promo code. Re-validated server-side; never trust the discount from the client. */
    promoCode: z.string().max(40).optional(),
  })
  .refine((o) => o.fulfillment !== 'DELIVERY' || !!o.deliveryAddress, {
    message: 'A delivery address is required for delivery orders',
    path: ['deliveryAddress'],
  });
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const qrCodeSchema = z.object({
  type: z.enum(['TABLE', 'FLYER', 'COUNTER']),
  label: z.string().min(1).max(60),
  tableNumber: z.string().max(20).optional(),
});
export type QRCodeInput = z.infer<typeof qrCodeSchema>;

export const promotionSchema = z
  .object({
    name: z.string().min(1).max(80),
    type: z.enum(['PERCENT', 'FIXED']),
    /** PERCENT: basis points (500 = 5%, max 10000 = 100%). FIXED: cents. */
    value: z.number().int().min(1),
    /** Blank/omitted applies automatically to every qualifying order. */
    code: z.string().max(40).optional(),
    /** Empty = whole order. Non-empty = only these products are discounted and tagged. */
    productIds: z.array(z.string()).default([]),
    minSubtotalCents: z.number().int().min(0).default(0),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
  })
  .refine((p) => p.type !== 'PERCENT' || p.value <= 10_000, {
    message: 'A percentage discount cannot exceed 100%',
    path: ['value'],
  });
export type PromotionInput = z.infer<typeof promotionSchema>;

const shiftObjectSchema = z.object({
  userId: z.string().cuid(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  note: z.string().max(280).optional(),
});
export const shiftSchema = shiftObjectSchema.refine(
  (s) => new Date(s.endsAt) > new Date(s.startsAt),
  { message: 'A shift must end after it starts', path: ['endsAt'] },
);
export type ShiftInput = z.infer<typeof shiftSchema>;
/** Partial updates skip the cross-field refine — ShiftsService re-checks
 *  endsAt > startsAt itself once it has resolved both against the existing row. */
export const shiftUpdateSchema = shiftObjectSchema.partial();

export const refundSchema = z.object({
  amountCents: z.number().int().min(1).optional(), // omit for a full refund
  reason: z.string().max(500).optional(),
});
export type RefundInput = z.infer<typeof refundSchema>;
