import type { Request } from 'express';
import type { StaffRole } from '@orderos/shared';

/** The authenticated staff member, resolved by ClerkAuthGuard. */
export interface AuthUser {
  /** OrderOS User.id (the membership row), not the Clerk id. */
  id: string;
  clerkUserId: string;
  email: string;
  role: StaffRole;
  restaurantId: string;
}

/**
 * Every authenticated request carries the tenant it acts on. Services take this
 * and never accept a bare restaurantId from the request body — that's the whole
 * point: a client cannot name a tenant it isn't a member of.
 */
export interface AuthedRequest extends Request {
  user?: AuthUser;
  restaurantId?: string;
  /** Set on public storefront routes, resolved from the subdomain. */
  publicRestaurantId?: string;
}
