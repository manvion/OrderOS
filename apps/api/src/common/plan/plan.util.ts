import { ForbiddenException } from '@nestjs/common';
import {
  commissionBpsForTier,
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
 * The commission a restaurant actually pays, per order, in basis points.
 *
 * The PLAN is the source of truth, not a stored number: the effective rate is the
 * plan's rate for the restaurant's tier — UNLESS a SUPER_ADMIN negotiated a custom
 * one (`commissionOverridden`), in which case their exact `platformFeeBps` stands.
 * Deriving it (rather than reading a materialised column) means changing a plan's
 * rate in plans.ts updates every restaurant on it at once, with nothing to re-sync.
 *
 * When the tier genuinely can't be read — the transient window where the plan
 * migration hasn't rolled out yet and the order path loaded the row with the plan
 * columns omitted — we assume the BASE PAID RATE (Starter), not the stored
 * `platformFeeBps`. That stored column defaults to 0, so the old fallback silently
 * dropped commission to 0% on every order across the whole platform whenever a
 * migration lagged — the platform gave away its cut and no one noticed. Starter is
 * also exactly what every row backfills to once the migration lands, so this is the
 * value they're about to have anyway. A negotiated custom rate still wins.
 */
export function effectiveCommissionBps(r: {
  planTier?: PlanTier | null;
  platformFeeBps: number;
  commissionOverridden?: boolean | null;
}): number {
  if (r.commissionOverridden) return r.platformFeeBps;
  if (!r.planTier) return commissionBpsForTier('STARTER');
  return commissionBpsForTier(r.planTier);
}

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
  CATERING: 'party & catering orders',
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
 * True when a query failed because the subscription columns aren't in the database
 * yet — i.e. the plan migration hasn't been applied in this environment.
 *
 * Before that migration there was no plan gating at all, so the safe behaviour when
 * we literally cannot read a tier is to FAIL OPEN: let the action through, exactly
 * as it would have before subscriptions existed, rather than block a restaurant out
 * of a feature it already had. Duck-typed so it needs no Prisma value import.
 */
export function isMissingPlanColumn(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  if (e.code === 'P2022') return true; // Prisma: "column does not exist"
  return /planTier|subscriptionStatus|PlanTier|SubscriptionStatus/.test(e.message ?? '');
}

/**
 * The columns the subscription migration adds. Pass as Prisma `omit` on a full-row
 * read to keep it working against a database where that migration hasn't been
 * applied yet — the fallback path after `isMissingPlanColumn` catches the first try.
 */
export const PLAN_DB_COLUMNS = {
  planTier: true,
  subscriptionStatus: true,
  billingInterval: true,
  stripeCustomerId: true,
  stripeSubscriptionId: true,
  planCurrentPeriodEnd: true,
  commissionOverridden: true,
} as const;

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
  let r: { planTier: PlanTier } | null;
  try {
    r = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { planTier: true },
    });
  } catch (err) {
    if (isMissingPlanColumn(err)) return; // migration not applied here — fail open
    throw err;
  }
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
  let r: { planTier: PlanTier } | null;
  try {
    r = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { planTier: true },
    });
  } catch (err) {
    if (isMissingPlanColumn(err)) return; // migration not applied here — fail open
    throw err;
  }
  if (r) assertWithinLimit(r, key, currentCount, what);
}
