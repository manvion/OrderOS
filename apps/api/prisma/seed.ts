/**
 * Development seed. Creates one fully-onboarded restaurant with a real menu, so
 * `npm run db:seed && npm run dev` gives you a working storefront at
 * http://bellaburger.localhost:3000 without clicking through onboarding.
 *
 * Idempotent: safe to re-run. It upserts by slug and clears the tenant's menu
 * first, so you always land on exactly this state.
 */
import { PrismaClient } from '@prisma/client';
import { DEFAULT_BUSINESS_HOURS } from '../../../packages/shared/src/hours';

const prisma = new PrismaClient();

const SLUG = 'bellaburger';

async function main(): Promise<void> {
  console.log('Seeding DineDirect...');

  const restaurant = await prisma.restaurant.upsert({
    where: { slug: SLUG },
    update: {},
    create: {
      slug: SLUG,
      name: 'Bella Burger',
      description: 'Smash burgers, hand-cut fries, and milkshakes worth the calories.',
      email: 'hello@bellaburger.test',
      phone: '+14155550123',
      street: '535 Mission St',
      city: 'San Francisco',
      state: 'CA',
      postalCode: '94105',
      country: 'US',
      latitude: 37.788,
      longitude: -122.397,
      timezone: 'America/Los_Angeles',
      currency: 'USD',
      brandPrimaryColor: '#EA580C',
      brandAccentColor: '#0F172A',
      businessHours: DEFAULT_BUSINESS_HOURS as unknown as object,

      pickupEnabled: true,
      deliveryEnabled: true,
      dineInEnabled: true,
      scheduledOrdersEnabled: true,
      uberDirectEnabled: false, // no sandbox credentials by default
      deliveryFeeCents: 499,
      serviceFeeCents: 100,
      taxRateBps: 875, // 8.75%
      minOrderCents: 1000,
      prepTimeMinutes: 20,

      // Pretend Stripe is connected so the storefront is reachable end-to-end.
      // Checkout will still fail without real keys — that's the honest behaviour.
      stripeChargesEnabled: true,
      isPublished: true,
      publishedAt: new Date(),
      onboardingStep: 'PUBLISHED',
    },
  });

  console.log(`  Restaurant: ${restaurant.name} (${restaurant.slug})`);

  // Wipe and rebuild the menu so re-seeding doesn't stack duplicates.
  await prisma.category.deleteMany({ where: { restaurantId: restaurant.id } });

  const burgers = await prisma.category.create({
    data: {
      restaurantId: restaurant.id,
      name: 'Burgers',
      description: 'Griddled to order on a brioche bun',
      sortOrder: 0,
    },
  });

  const sides = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Sides', sortOrder: 1 },
  });

  const drinks = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Drinks', sortOrder: 2 },
  });

  // The canonical example from the spec: a burger with a required Size group
  // (single-select) and an optional Extras group (multi-select).
  await prisma.product.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: burgers.id,
      name: 'The Classic',
      description: 'Two smashed patties, American cheese, pickles, house sauce.',
      priceCents: 1200,
      sortOrder: 0,
      modifierGroups: {
        create: [
          {
            restaurantId: restaurant.id,
            name: 'Size',
            selectionType: 'SINGLE',
            required: true,
            minSelections: 1,
            maxSelections: 1,
            sortOrder: 0,
            modifiers: {
              create: [
                { name: 'Small', priceCents: 0, sortOrder: 0 },
                { name: 'Medium', priceCents: 200, sortOrder: 1 },
                { name: 'Large', priceCents: 400, sortOrder: 2 },
              ],
            },
          },
          {
            restaurantId: restaurant.id,
            name: 'Extras',
            selectionType: 'MULTIPLE',
            required: false,
            minSelections: 0,
            maxSelections: 5,
            sortOrder: 1,
            modifiers: {
              create: [
                { name: 'Extra cheese', priceCents: 150, sortOrder: 0 },
                { name: 'Bacon', priceCents: 250, sortOrder: 1 },
                { name: 'Fried egg', priceCents: 200, sortOrder: 2 },
                { name: 'Jalapeños', priceCents: 100, sortOrder: 3 },
              ],
            },
          },
        ],
      },
    },
  });

  await prisma.product.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: burgers.id,
      name: 'Mushroom Swiss',
      description: 'Caramelised onions, Swiss, garlic aioli.',
      priceCents: 1400,
      sortOrder: 1,
      modifierGroups: {
        create: [
          {
            restaurantId: restaurant.id,
            name: 'Size',
            selectionType: 'SINGLE',
            required: true,
            minSelections: 1,
            maxSelections: 1,
            modifiers: {
              create: [
                { name: 'Single', priceCents: 0, sortOrder: 0 },
                { name: 'Double', priceCents: 350, sortOrder: 1 },
              ],
            },
          },
        ],
      },
    },
  });

  await prisma.product.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: sides.id,
      name: 'Hand-cut Fries',
      description: 'Twice-fried, rosemary salt.',
      priceCents: 500,
      sortOrder: 0,
      modifierGroups: {
        create: [
          {
            restaurantId: restaurant.id,
            name: 'Make it loaded',
            selectionType: 'MULTIPLE',
            required: false,
            maxSelections: 3,
            modifiers: {
              create: [
                { name: 'Cheese sauce', priceCents: 200, sortOrder: 0 },
                { name: 'Bacon bits', priceCents: 250, sortOrder: 1 },
                { name: 'Truffle oil', priceCents: 300, sortOrder: 2 },
              ],
            },
          },
        ],
      },
    },
  });

  await prisma.product.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: sides.id,
      name: 'Onion Rings',
      priceCents: 600,
      sortOrder: 1,
    },
  });

  await prisma.product.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: drinks.id,
      name: 'Milkshake',
      description: 'Thick enough to hold a straw upright.',
      priceCents: 700,
      sortOrder: 0,
      modifierGroups: {
        create: [
          {
            restaurantId: restaurant.id,
            name: 'Flavour',
            selectionType: 'SINGLE',
            required: true,
            minSelections: 1,
            maxSelections: 1,
            modifiers: {
              create: [
                { name: 'Vanilla', priceCents: 0, sortOrder: 0 },
                { name: 'Chocolate', priceCents: 0, sortOrder: 1 },
                { name: 'Salted caramel', priceCents: 100, sortOrder: 2 },
              ],
            },
          },
        ],
      },
    },
  });

  await prisma.product.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: drinks.id,
      name: 'Fountain Soda',
      priceCents: 300,
      sortOrder: 1,
    },
  });

  // A table QR, so the dine-in flow is testable immediately.
  await prisma.qRCode.deleteMany({ where: { restaurantId: restaurant.id } });
  await prisma.qRCode.create({
    data: {
      restaurantId: restaurant.id,
      type: 'TABLE',
      label: 'Table 1',
      tableNumber: '1',
      targetUrl: `http://${SLUG}.localhost:3000/menu?src=qr&t=1`,
    },
  });

  const productCount = await prisma.product.count({ where: { restaurantId: restaurant.id } });

  console.log(`  Menu: 3 categories, ${productCount} products`);
  console.log('');
  console.log('Done. Storefront:  http://bellaburger.localhost:3000');
  console.log('      Dashboard:   http://localhost:3000/dashboard');
  console.log('');
  console.log('NOTE: to manage this restaurant, sign up in the dashboard — the first');
  console.log('      account to create a restaurant becomes its OWNER. This seed has no');
  console.log('      staff user, because staff identities live in Clerk, not here.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
