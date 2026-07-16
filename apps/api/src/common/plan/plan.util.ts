import { ForbiddenException } from '@nestjs/common';
import {
  getPlan,
  lowestTierWith,
  planAllows,
  planLimit,
  type PlanCapability,
  type PlanLimits,
  type PlanTier,
} from '@dinedirect/shared';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Server-side plan enforcement.
 *
 * The dashboard hides what a plan doesn't include, but hiding a button is a
 * courtesy, not a control — the API endpoint is still there and still reachable
 * with a curl. So the gate that actually MATTERS is this one, on the server, and the
 * two read the SAME plan definition (packages/shared/src/plans.ts) so they can never
 * disagree about what a tier grants.
 *
 * A refusal is a 403 whose message names the feature and the tier that unlocks it —
 * so the web app can turn "delivery isn't on your plan" straight into an upgrade
 * prompt instead of a dead-end error.
 */

const CAPABILITY_LABELS: Record<PlanCapability, string> = {
  WEBSITE_STOREFRONT: 'a branded ordering website',
  DELIVERY: 'automatic delivery dispatch',
  PROMOTIONS: 'promotions & discount codes',
  LOYALTY: 'the loyalty program',
  WIDGET: 'the embeddable ordering widget',
  FULL_ANALYTICS: 'full analytics & order history',
  CUSTOM_DOMAIN: 'a custom domain',
  INVENTORY: 'inventory management',
  SHIFTS: 'staff scheduling',
  TAX_REPORTS: 'tax reports',
  REMOVE_BRANDING: 'removing DineDirect branding',
};

/** Just the plan fields the guards need — accept any object that carries them. */
export interface PlanBearer {
  planTier: PlanTier;
}

/** Throw a 403 unless the restaurant's plan grants the capability. */
export function assertPlanCapability(r: PlanBearer, capability: PlanCapability): void {
  if (planAllows(r.planTier, capability)) return;
  const needed = lowestTierWith(capability);
  throw new ForbiddenException({
    message: `Your ${getPlan(r.planTier).name} plan doesn't include ${CAPABILITY_LABELS[capability]}. Upgrade to ${getPlan(needed).name} to turn it on.`,
    code: 'PLAN_UPGRADE_REQUIRED',
    capability,
    requiredTier: needed,
  });
}

/**
 * Throw a 403 when adding one more of something would exceed the plan's limit.
 *
 * `currentCount` is what already exists; this is called before the insert, so the
 * check is "would this be one too many". null limit = unlimited, always allowed.
 */
export function assertWithinLimit(
  r: PlanBearer,
  key: keyof PlanLimits,
  currentCount: number,
  what: string,
): void {
  const limit = planLimit(r.planTier, key);
  if (limit === null) return;
  if (currentCount < limit) return;
  throw new ForbiddenException({
    message: `Your ${getPlan(r.planTier).name} plan is limited to ${limit} ${what}. Upgrade for more.`,
    code: 'PLAN_LIMIT_REACHED',
    limit,
    key,
  });
}

/**
 * Load a restaurant's tier and assert a capability, in one call. The common shape:
 * a service already has a `restaurantId` and just wants to gate before it acts.
 * A missing restaurant is left to the downstream write to reject (a bad FK), so
 * gating never invents its own 404.
 */
export async function assertRestaurantCapability(
  prisma: PrismaService,
  restaurantId: string,
  capability: PlanCapability,
): Promise<void> {
  const r = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { planTier: true },
  });
  if (r) assertPlanCapability(r, capability);
}

/** Load a restaurant's tier and assert `currentCount` is still under the plan limit. */
export async function assertRestaurantWithinLimit(
  prisma: PrismaService,
  restaurantId: string,
  key: keyof PlanLimits,
  currentCount: number,
  what: string,
): Promise<void> {
  const r = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { planTier: true },
  });
  if (r) assertWithinLimit(r, key, currentCount, what);
}
