/**
 * "What's left to do before I can take money?"
 *
 * ONE definition of that, used by everyone: the owner's setup page, the publish
 * gate, and the platform console. It used to be written twice — once in
 * RestaurantsService and once in AdminService — and the two had already drifted:
 * the admin copy didn't know a restaurant needs a CATEGORY as well as a product,
 * and knew nothing about QR-only mode. So an owner could be told "you can't publish"
 * for a reason the support agent looking at the same restaurant could not see.
 *
 * That is the whole failure mode this file exists to prevent. When the owner phones
 * up saying "it won't let me go live", we must be looking at exactly what they are.
 *
 * Pure and dependency-free on purpose: the browser imports it too, and it is tested
 * without a database.
 */

export interface SetupFacts {
  orderingMode: 'WEBSITE' | 'QR_ONLY';
  categoryCount: number;
  /** Products that are actually available — an unavailable menu sells nothing. */
  availableProductCount: number;
  activeQrCount: number;
  stripeChargesEnabled: boolean;
  pickupEnabled: boolean;
  deliveryEnabled: boolean;
  dineInEnabled: boolean;
  hasLogo: boolean;
  /** Combined tax rate in basis points. 0 is legitimate — but only if deliberate. */
  taxRateBps: number;
  isPublished: boolean;
}

export interface SetupStep {
  id: string;
  /** What to do, in the owner's words. */
  label: string;
  /** Why it matters. Shown when it isn't done — a checklist without reasons is a chore list. */
  why: string;
  done: boolean;
  /**
   * REQUIRED steps block publishing: without them an order cannot be taken, or
   * cannot be fulfilled. Everything else is advice, and advice must never block a
   * business from opening.
   */
  required: boolean;
  /** Where in the dashboard to go and do it. */
  href: string;
}

export function buildSetupChecklist(f: SetupFacts): SetupStep[] {
  const qrOnly = f.orderingMode === 'QR_ONLY';

  const steps: SetupStep[] = [
    {
      id: 'menu',
      label: 'Add your menu',
      why: 'A category and at least one available item. There is nothing to sell without it.',
      done: f.categoryCount > 0 && f.availableProductCount > 0,
      required: true,
      href: '/dashboard/menu',
    },
    {
      id: 'fulfillment',
      label: 'Choose how customers get their food',
      why: 'Pickup, delivery or dine-in. With none of them on, nobody can complete an order.',
      done: f.pickupEnabled || f.deliveryEnabled || f.dineInEnabled,
      required: true,
      href: '/dashboard/settings',
    },
    {
      id: 'stripe',
      label: 'Connect Stripe',
      why: 'This is how the money reaches your bank account. Payouts go to you, not to us.',
      done: f.stripeChargesEnabled,
      required: true,
      href: '/dashboard/setup',
    },
  ];

  /**
   * A QR-only restaurant has no website — the printed code IS the front door.
   * Publishing one with no codes gives customers literally no way to order, and it
   * looks to the owner like the product simply doesn't work.
   */
  steps.push({
    id: 'qr',
    label: qrOnly ? 'Print your QR codes' : 'Add QR codes for your tables',
    why: qrOnly
      ? 'You have no website, so the code is the only way in. Publishing is blocked until one exists.'
      : 'Optional. A code on the table lets people order without queueing.',
    done: f.activeQrCount > 0,
    required: qrOnly,
    href: '/dashboard/qr',
  });

  steps.push(
    {
      id: 'tax',
      label: 'Confirm your tax rate',
      why: 'It is currently 0%. If that is wrong, you under-collect on every order and find out at audit.',
      // 0% is a legitimate answer in some places. It is not a legitimate DEFAULT,
      // so it stays on the list until it is non-zero or explicitly set.
      done: f.taxRateBps > 0,
      required: false,
      href: '/dashboard/settings',
    },
    {
      id: 'logo',
      label: 'Upload your logo',
      why: 'Your page looks unfinished without one, and people do not order from a page that looks abandoned.',
      done: f.hasLogo,
      required: false,
      href: '/dashboard/settings',
    },
  );

  return steps;
}

/** The steps that stand between them and taking money. */
export function publishBlockers(steps: SetupStep[]): SetupStep[] {
  return steps.filter((s) => s.required && !s.done);
}

/** How far along are they? Required steps only — advice must not affect the score. */
export function setupProgress(steps: SetupStep[]): { done: number; total: number } {
  const required = steps.filter((s) => s.required);
  return { done: required.filter((s) => s.done).length, total: required.length };
}
