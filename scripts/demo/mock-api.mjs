/**
 * DEMO ONLY — a mock of the OrderOS widget API.
 *
 * This exists so the widget can be demonstrated on a machine with no Postgres,
 * no Redis and no Stripe account. It implements the same HTTP contract as the
 * real NestJS API (apps/api/src/modules/widget/widget-public.controller.ts) with
 * the seed menu held in memory.
 *
 * WHAT IS REAL in this demo: widget.js, the Shadow DOM, the iframe, the embed
 * app, the cart, the pricing engine, the postMessage protocol, the new-tab
 * payment hop, and the tracking poll.
 *
 * WHAT IS FAKE: the database (in-memory), Stripe (a stub page), the domain
 * allowlist (this mock accepts any origin — the real guard does not), and the
 * order state machine (it advances on a timer instead of a kitchen tablet).
 *
 * Do not deploy this. It is a demo prop.
 */
import { createServer } from 'node:http';

const PORT = 4000;

// The same restaurant prisma/seed.ts creates.
const RESTAURANT = {
  id: 'demo-restaurant',
  slug: 'bellaburger',
  name: 'Bella Burger',
  description: 'Smash burgers, hand-cut fries, and milkshakes worth the calories.',
  phone: '+14155550123',
  street: '535 Mission St',
  city: 'San Francisco',
  state: 'CA',
  postalCode: '94105',
  // The map's origin pin, and the courier's starting point. Without these the
  // courier interpolates from `undefined` and every position comes out NaN — which
  // serialises to null and silently produces a map with no driver on it.
  latitude: 37.788,
  longitude: -122.397,
  logoUrl: null,
  coverImageUrl: null,
  brandPrimaryColor: '#EA580C',
  brandAccentColor: '#0F172A',
  currency: 'USD',
  timezone: 'America/Los_Angeles',
  isOpen: true,
  acceptingOrders: true,
  pickupEnabled: true,
  deliveryEnabled: true,
  dineInEnabled: true,
  scheduledOrdersEnabled: true,
  deliveryFeeCents: 499,
  minOrderCents: 1000,
  serviceFeeCents: 100,
  taxRateBps: 875,
  prepTimeMinutes: 20,
  businessHours: {},
};

const SETTINGS = {
  mode: 'FLOATING_BUTTON',
  position: 'BOTTOM_RIGHT',
  buttonText: 'Order Now',
  primaryColor: '#EA580C',
  textColor: '#FFFFFF',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  borderRadius: 12,
  showLogo: true,
  fullPage: false,
  hideWhenClosed: false,
};

const MENU = [
  {
    id: 'cat_burgers',
    name: 'Burgers',
    description: 'Griddled to order on a brioche bun',
    products: [
      {
        id: 'prod_classic',
        name: 'The Classic',
        description: 'Two smashed patties, American cheese, pickles, house sauce.',
        priceCents: 1200,
        imageUrl: null,
        modifierGroups: [
          {
            id: 'grp_size',
            name: 'Size',
            selectionType: 'SINGLE',
            required: true,
            minSelections: 1,
            maxSelections: 1,
            modifiers: [
              { id: 'mod_sm', name: 'Small', priceCents: 0 },
              { id: 'mod_md', name: 'Medium', priceCents: 200 },
              { id: 'mod_lg', name: 'Large', priceCents: 400 },
            ],
          },
          {
            id: 'grp_extras',
            name: 'Extras',
            selectionType: 'MULTIPLE',
            required: false,
            minSelections: 0,
            maxSelections: 5,
            modifiers: [
              { id: 'mod_cheese', name: 'Extra cheese', priceCents: 150 },
              { id: 'mod_bacon', name: 'Bacon', priceCents: 250 },
              { id: 'mod_egg', name: 'Fried egg', priceCents: 200 },
              { id: 'mod_jal', name: 'Jalapeños', priceCents: 100 },
            ],
          },
        ],
      },
      {
        id: 'prod_mushroom',
        name: 'Mushroom Swiss',
        description: 'Caramelised onions, Swiss, garlic aioli.',
        priceCents: 1400,
        imageUrl: null,
        modifierGroups: [
          {
            id: 'grp_size2',
            name: 'Size',
            selectionType: 'SINGLE',
            required: true,
            minSelections: 1,
            maxSelections: 1,
            modifiers: [
              { id: 'mod_single', name: 'Single', priceCents: 0 },
              { id: 'mod_double', name: 'Double', priceCents: 350 },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'cat_sides',
    name: 'Sides',
    description: null,
    products: [
      {
        id: 'prod_fries',
        name: 'Hand-cut Fries',
        description: 'Twice-fried, rosemary salt.',
        priceCents: 500,
        imageUrl: null,
        modifierGroups: [
          {
            id: 'grp_loaded',
            name: 'Make it loaded',
            selectionType: 'MULTIPLE',
            required: false,
            minSelections: 0,
            maxSelections: 3,
            modifiers: [
              { id: 'mod_sauce', name: 'Cheese sauce', priceCents: 200 },
              { id: 'mod_bits', name: 'Bacon bits', priceCents: 250 },
              { id: 'mod_truffle', name: 'Truffle oil', priceCents: 300 },
            ],
          },
        ],
      },
      {
        id: 'prod_rings',
        name: 'Onion Rings',
        description: null,
        priceCents: 600,
        imageUrl: null,
        modifierGroups: [],
      },
    ],
  },
  {
    id: 'cat_drinks',
    name: 'Drinks',
    description: null,
    products: [
      {
        id: 'prod_shake',
        name: 'Milkshake',
        description: 'Thick enough to hold a straw upright.',
        priceCents: 700,
        imageUrl: null,
        modifierGroups: [
          {
            id: 'grp_flavour',
            name: 'Flavour',
            selectionType: 'SINGLE',
            required: true,
            minSelections: 1,
            maxSelections: 1,
            modifiers: [
              { id: 'mod_van', name: 'Vanilla', priceCents: 0 },
              { id: 'mod_choc', name: 'Chocolate', priceCents: 0 },
              { id: 'mod_caramel', name: 'Salted caramel', priceCents: 100 },
            ],
          },
        ],
      },
    ],
  },
];

// Flatten the menu so we can price an order from IDS ONLY — exactly as the real
// API does. The client never sends a price, here or in production.
const PRODUCTS = new Map();
const MODIFIERS = new Map();
for (const category of MENU) {
  for (const product of category.products) {
    PRODUCTS.set(product.id, product);
    for (const group of product.modifierGroups) {
      for (const modifier of group.modifiers) MODIFIERS.set(modifier.id, modifier);
    }
  }
}

/** In-memory order store, keyed by tracking token. */
const orders = new Map();
/** Funnel events, so the demo can print the same numbers the dashboard shows. */
const events = [];

let orderCounter = 0;

function priceOrder(items, fulfillment, tipCents) {
  let subtotalCents = 0;
  const lines = [];

  for (const item of items) {
    const product = PRODUCTS.get(item.productId);
    if (!product) throw new Error(`Unknown product ${item.productId}`);

    const mods = (item.modifierIds ?? []).map((id) => {
      const modifier = MODIFIERS.get(id);
      if (!modifier) throw new Error(`Unknown modifier ${id}`);
      return modifier;
    });

    // Server-side pricing. The burger costs what the menu says it costs.
    const unit = product.priceCents + mods.reduce((s, m) => s + m.priceCents, 0);
    const total = unit * item.quantity;
    subtotalCents += total;

    lines.push({
      name: product.name,
      quantity: item.quantity,
      totalCents: total,
      modifiers: mods.map((m) => ({ name: m.name, priceCents: m.priceCents })),
    });
  }

  const serviceFeeCents = RESTAURANT.serviceFeeCents;
  const deliveryFeeCents = fulfillment === 'DELIVERY' ? RESTAURANT.deliveryFeeCents : 0;
  const taxCents = Math.round(((subtotalCents + serviceFeeCents) * RESTAURANT.taxRateBps) / 10_000);
  const tip = tipCents ?? 0;

  return {
    lines,
    subtotalCents,
    serviceFeeCents,
    deliveryFeeCents,
    taxCents,
    tipCents: tip,
    totalCents: subtotalCents + serviceFeeCents + deliveryFeeCents + taxCents + tip,
  };
}

function send(res, status, body, origin) {
  // The real API allows only registered origins. This mock allows all of them,
  // because there is no database to hold an allowlist. That difference is the
  // single most important thing NOT being demonstrated here.
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Widget-Key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, {}, origin);

  // --- The fake Stripe Checkout page ---------------------------------------
  // The real flow sends the customer to checkout.stripe.com in a new tab. This
  // stands in for it, so the new-tab hop and the tracking poll can be seen working.
  if (path === '/fake-stripe') {
    const token = url.searchParams.get('token');
    const order = orders.get(token);

    if (url.searchParams.get('pay') === '1' && order) {
      order.payment = { status: 'PAID' };
      order.status = 'ACCEPTED';
      order.events.push({ status: 'ACCEPTED', createdAt: new Date().toISOString(), note: null });

      // The kitchen, on a timer. In production these come from staff tapping the
      // order board, and from Uber's webhooks.
      setTimeout(() => {
        order.status = 'PREPARING';
        order.events.push({ status: 'PREPARING', createdAt: new Date().toISOString(), note: null });
      }, 6000);

      setTimeout(() => {
        order.status = 'READY';
        order.events.push({ status: 'READY', createdAt: new Date().toISOString(), note: null });
      }, 14000);

      // Delivery orders get a courier who actually moves, so the live map has
      // something to show. In production these coordinates come from Uber's
      // webhooks; here they walk a straight line from the restaurant to the
      // customer, which is enough to see the pin glide and the trail draw.
      if (order.fulfillment === 'DELIVERY') {
        setTimeout(() => {
          order.status = 'DRIVER_ASSIGNED';
          order.delivery = {
            id: 'dlv_demo',
            status: 'PICKUP_ENROUTE',
            provider: 'UBER',
            trackingUrl: null,
            courierName: 'Marcus',
            courierVehicle: 'Bicycle',
            courierLatitude: RESTAURANT.latitude,
            courierLongitude: RESTAURANT.longitude,
            dropoffEta: new Date(Date.now() + 14 * 60_000).toISOString(),
            pings: [],
          };
          order.events.push({
            status: 'DRIVER_ASSIGNED',
            createdAt: new Date().toISOString(),
            note: null,
          });
          startCourier(order);
        }, 20000);
      }
    }

    const paid = order?.payment?.status === 'PAID';
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>${paid ? 'Payment complete' : 'Checkout'}</title>
<style>
 body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#f6f9fc}
 .card{background:#fff;padding:40px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.08);max-width:400px;text-align:center}
 .badge{display:inline-block;background:#635bff;color:#fff;padding:4px 10px;border-radius:4px;font-size:12px;font-weight:600;margin-bottom:20px}
 h1{font-size:20px;margin:0 0 8px}
 p{color:#697386;font-size:14px;line-height:1.5}
 button{background:#635bff;color:#fff;border:0;padding:14px 28px;border-radius:6px;font-size:15px;font-weight:600;cursor:pointer;width:100%;margin-top:20px}
 .note{margin-top:24px;font-size:12px;color:#8792a2;border-top:1px solid #e6ebf1;padding-top:16px}
</style></head>
<body><div class="card">
  <div class="badge">DEMO — stands in for Stripe Checkout</div>
  ${
    paid
      ? `<h1>Payment complete</h1>
         <p>Your order is confirmed. Track it live — a driver will appear on the map shortly.</p>
         <a href="http://localhost:3005/s/bellaburger/track/${token}"
            style="display:block;background:#EA580C;color:#fff;text-decoration:none;padding:14px 28px;
                   border-radius:6px;font-size:15px;font-weight:600;margin-top:20px;">
           Track my order
         </a>
         <p style="margin-top:14px;font-size:13px;">
           (In the WIDGET, you never do this — the tab on the restaurant's own site
           flips to tracking by itself. This button exists because the storefront
           checkout genuinely leaves the site for Stripe, exactly as the real one does.)
         </p>`
      : `<h1>Bella Burger</h1>
         <p>Pay <strong>$${((order?.totalCents ?? 0) / 100).toFixed(2)}</strong> for order #${order?.orderNumber ?? '?'}</p>
         <form method="GET"><input type="hidden" name="token" value="${token}"><input type="hidden" name="pay" value="1">
           <button type="submit">Pay $${((order?.totalCents ?? 0) / 100).toFixed(2)}</button>
         </form>`
  }
  <p class="note">The real integration sends you to checkout.stripe.com here. Stripe refuses to be
     framed, which is exactly why this opened in a new tab instead of inside the widget.</p>
</div></body></html>`);
  }

  // --- Storefront API --------------------------------------------------------
  //
  // The hosted ordering site at <slug>.orderos.ai. This is the REAL OrderOS
  // product UI — the widget is only one of its two front doors — and serving these
  // endpoints is what lets the demo show it without a database.

  if (path === '/api/storefront/restaurant') {
    return send(res, 200, RESTAURANT, origin);
  }

  if (path === '/api/storefront/menu') {
    return send(res, 200, MENU, origin);
  }

  if (path === '/api/storefront/delivery-quote') {
    return send(
      res,
      200,
      { deliverable: true, customerFeeCents: 499, uberFeeCents: 712, selfDelivery: false },
      origin,
    );
  }

  // A guest. The storefront treats 401 here as "not signed in" and carries on —
  // which is the whole point of guest checkout.
  if (path === '/api/storefront/me') {
    return send(res, 401, { statusCode: 401, message: 'Not signed in' }, origin);
  }

  if (path === '/api/storefront/orders' && req.method === 'POST') {
    const body = await readBody(req);
    return createOrder(res, body, origin);
  }

  const storefrontTrack = path.match(/^\/api\/storefront\/track\/(.+)$/);
  if (storefrontTrack) {
    const order = orders.get(storefrontTrack[1]);
    if (!order) return send(res, 404, { statusCode: 404, message: 'Order not found' }, origin);
    return send(res, 200, order, origin);
  }

  // "I closed the tab — where's my food?" Order number + the phone that placed it.
  if (path === '/api/storefront/lookup' && req.method === 'POST') {
    const body = await readBody(req);
    const digits = String(body.phone ?? '').replace(/\D/g, '');

    const found = [...orders.values()].find(
      (o) =>
        o.orderNumber === String(body.orderNumber ?? '').trim() &&
        digits.length > 0 &&
        o.customerPhone?.replace(/\D/g, '').endsWith(digits.slice(-7)),
    );

    if (!found) {
      return send(
        res,
        404,
        {
          statusCode: 404,
          message: "We couldn't find that order. Check the order number and phone number.",
        },
        origin,
      );
    }
    return send(res, 200, found, origin);
  }

  // --- Widget API ------------------------------------------------------------

  if (path === '/api/widget/config') {
    return send(res, 200, { settings: SETTINGS, restaurant: RESTAURANT }, origin);
  }

  if (path === '/api/widget/menu') {
    return send(res, 200, MENU, origin);
  }

  if (path === '/api/widget/delivery-quote') {
    return send(
      res,
      200,
      { deliverable: true, customerFeeCents: 499, uberFeeCents: 712, selfDelivery: false },
      origin,
    );
  }

  if (path === '/api/widget/events' && req.method === 'POST') {
    const body = await readBody(req);
    // Deduplicated per session, exactly as the real unique index does.
    const key = `${body.sessionId}:${body.type}`;
    if (!events.some((e) => `${e.sessionId}:${e.type}` === key)) {
      events.push({ ...body, at: new Date() });
      console.log(`  [funnel] ${body.type.padEnd(15)} session=${body.sessionId.slice(0, 12)}…`);
    }
    return send(res, 204, {}, origin);
  }

  if (path === '/api/widget/orders' && req.method === 'POST') {
    const body = await readBody(req);
    return createOrder(res, body, origin);
  }

  const trackMatch = path.match(/^\/api\/widget\/orders\/(.+)$/);
  if (trackMatch) {
    const order = orders.get(trackMatch[1]);
    if (!order) return send(res, 404, { statusCode: 404, message: 'Order not found' }, origin);
    return send(res, 200, order, origin);
  }

  send(res, 404, { statusCode: 404, message: 'Not found' }, origin);
});

/**
 * Walk the courier from the restaurant to the customer, one step every 3 seconds,
 * breadcrumbing as they go.
 *
 * Uber's webhooks do this in production. Here it exists so the live map has an
 * actual moving pin — a tracking map with a stationary dot looks broken, and you
 * cannot judge whether the map works without watching it move.
 */
function startCourier(order) {
  const from = { lat: RESTAURANT.latitude, lng: RESTAURANT.longitude };
  const to = { lat: order.deliveryLatitude, lng: order.deliveryLongitude };

  const STEPS = 14;
  let step = 0;

  const timer = setInterval(() => {
    step++;

    const t = step / STEPS;
    const lat = from.lat + (to.lat - from.lat) * t;
    const lng = from.lng + (to.lng - from.lng) * t;

    order.delivery.courierLatitude = lat;
    order.delivery.courierLongitude = lng;
    order.delivery.pings.push({ latitude: lat, longitude: lng });

    // Picked the food up and is now heading to the customer.
    if (step === 3) {
      order.status = 'OUT_FOR_DELIVERY';
      order.delivery.status = 'DROPOFF_ENROUTE';
      order.events.push({
        status: 'OUT_FOR_DELIVERY',
        createdAt: new Date().toISOString(),
        note: null,
      });
    }

    if (step >= STEPS) {
      clearInterval(timer);
      order.status = 'DELIVERED';
      order.delivery.status = 'DELIVERED';
      order.events.push({
        status: 'DELIVERED',
        createdAt: new Date().toISOString(),
        note: null,
      });
      console.log(`  [courier] order ${order.orderNumber} DELIVERED`);
    }
  }, 3000);
}

/**
 * Create an order. Shared by the storefront and the widget, exactly as the real
 * API shares OrdersService between them — the two front doors must produce
 * identical orders, or the kitchen sees two different products.
 */
function createOrder(res, body, origin) {
  let pricing;
  try {
    pricing = priceOrder(body.items, body.fulfillment, body.tipCents);
  } catch (err) {
    return send(res, 400, { statusCode: 400, error: 'BadRequest', message: err.message }, origin);
  }

  const token = `trk_${Math.random().toString(36).slice(2, 12)}`;
  const orderNumber = `0712-${String(++orderCounter).padStart(3, '0')}`;
  const now = new Date().toISOString();

  const order = {
    trackingToken: token,
    orderNumber,
    status: 'PENDING',
    fulfillment: body.fulfillment,
    currency: 'USD',
    subtotalCents: pricing.subtotalCents,
    taxCents: pricing.taxCents,
    tipCents: pricing.tipCents,
    deliveryFeeCents: pricing.deliveryFeeCents,
    serviceFeeCents: pricing.serviceFeeCents,
    totalCents: pricing.totalCents,
    createdAt: now,
    scheduledFor: null,
    items: pricing.lines,
    payment: { status: 'PENDING' },
    // Kept so the "find my order" lookup can verify the phone, like the real API.
    customerPhone: body.customer?.phone ?? '',
    deliveryLatitude: body.fulfillment === 'DELIVERY' ? 37.79 : null,
    deliveryLongitude: body.fulfillment === 'DELIVERY' ? -122.402 : null,
    delivery: null,
    restaurant: {
      name: RESTAURANT.name,
      slug: RESTAURANT.slug,
      phone: RESTAURANT.phone,
      logoUrl: null,
      brandPrimaryColor: RESTAURANT.brandPrimaryColor,
      street: RESTAURANT.street,
      city: RESTAURANT.city,
      latitude: RESTAURANT.latitude,
      longitude: RESTAURANT.longitude,
      prepTimeMinutes: RESTAURANT.prepTimeMinutes,
    },
    events: [{ status: 'PENDING', createdAt: now, note: 'Order placed' }],
  };

  orders.set(token, order);
  events.push({ type: 'ORDER_CREATED', sessionId: body.sessionId, at: new Date() });

  console.log(
    `  [order]  ${orderNumber} — ${pricing.lines.length} line(s), total $${(pricing.totalCents / 100).toFixed(2)} ` +
      `(priced server-side from ids; the browser sent no prices)`,
  );

  return send(
    res,
    200,
    {
      orderId: token,
      orderNumber,
      trackingToken: token,
      totalCents: pricing.totalCents,
      currency: 'USD',
      checkoutUrl: `http://localhost:${PORT}/fake-stripe?token=${token}`,
    },
    origin,
  );
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

server.listen(PORT, () => {
  console.log('');
  console.log('  MOCK OrderOS widget API on http://localhost:4000');
  console.log('  (demo prop — no database, no Stripe, no domain allowlist)');
  console.log('');
});
