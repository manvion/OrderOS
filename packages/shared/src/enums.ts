/**
 * Enum values mirror the Prisma enums exactly. Keep both in sync — the API
 * validates inbound payloads against these, Prisma persists them.
 */

export const StaffRole = {
  OWNER: 'OWNER',
  MANAGER: 'MANAGER',
  STAFF: 'STAFF',
} as const;
export type StaffRole = (typeof StaffRole)[keyof typeof StaffRole];

/** Ordered from least to most privileged. Used for hierarchical RBAC checks. */
export const ROLE_RANK: Record<StaffRole, number> = {
  STAFF: 1,
  MANAGER: 2,
  OWNER: 3,
};

export const OrderStatus = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  PREPARING: 'PREPARING',
  READY: 'READY',
  DRIVER_ASSIGNED: 'DRIVER_ASSIGNED',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const FulfillmentType = {
  PICKUP: 'PICKUP',
  DELIVERY: 'DELIVERY',
  DINE_IN: 'DINE_IN',
} as const;
export type FulfillmentType = (typeof FulfillmentType)[keyof typeof FulfillmentType];

export const PaymentStatus = {
  PENDING: 'PENDING',
  PAID: 'PAID',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export const DeliveryStatus = {
  PENDING: 'PENDING',
  QUOTED: 'QUOTED',
  CREATED: 'CREATED',
  PICKUP_ENROUTE: 'PICKUP_ENROUTE',
  DROPOFF_ENROUTE: 'DROPOFF_ENROUTE',
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
} as const;
export type DeliveryStatus = (typeof DeliveryStatus)[keyof typeof DeliveryStatus];

export const QRCodeType = {
  TABLE: 'TABLE',
  FLYER: 'FLYER',
  COUNTER: 'COUNTER',
} as const;
export type QRCodeType = (typeof QRCodeType)[keyof typeof QRCodeType];

/**
 * Legal status transitions. Any transition not listed here is rejected by the
 * order state machine — this is the single source of truth for order lifecycle.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['ACCEPTED', 'CANCELLED'],
  ACCEPTED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY', 'CANCELLED'],
  // READY -> COMPLETED is the pickup/dine-in terminal path (customer collected it).
  // READY -> DRIVER_ASSIGNED is the delivery path once Uber assigns a courier.
  READY: ['DRIVER_ASSIGNED', 'COMPLETED', 'CANCELLED'],
  DRIVER_ASSIGNED: ['OUT_FOR_DELIVERY', 'CANCELLED'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'CANCELLED'],
  DELIVERED: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

export const TERMINAL_ORDER_STATUSES: OrderStatus[] = ['COMPLETED', 'CANCELLED'];

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from]?.includes(to) ?? false;
}
