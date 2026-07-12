/**
 * Smoke test. Run it after EVERY deploy, local or production.
 *
 * It asserts on CONTENT, never on a status code. That distinction is not
 * pedantry — during this project a `curl :8080 -> 200` was reported as "the demo
 * is up" when the 200 came from an unrelated app on that port, and a Next build
 * "succeeded" while emitting zero storefront routes. A 200 tells you something
 * answered. It does not tell you it was yours, or that it was right.
 *
 *   node scripts/smoke.mjs                              # against localhost
 *   API_URL=https://api.orderos.ai WEB_URL=https://orderos.ai node scripts/smoke.mjs
 *
 * Exits non-zero on the first failure, so it can gate a deploy in CI.
 */
const API = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const WEB = (process.env.WEB_URL ?? 'http://localhost:3000').replace(/\/$/, '');
/** The slug prisma/seed.ts creates. Override for a production restaurant. */
const SLUG = process.env.SMOKE_SLUG ?? 'bellaburger';

let failures = 0;

function pass(name, detail = '') {
  console.log(`  \x1b[32mPASS\x1b[0m  ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
}

function fail(name, why) {
  failures++;
  console.log(`  \x1b[31mFAIL\x1b[0m  ${name}\n        ${why}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    pass(name, detail);
  } catch (err) {
    fail(name, err.message);
  }
}

/** Fetch and parse, with the body in the error so a failure is diagnosable. */
async function json(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${url} returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`${url} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return body;
}

console.log(`\n  API  ${API}\n  WEB  ${WEB}\n  slug ${SLUG}\n`);

// --- The API is ours, and it can reach its database and Redis ---------------

await check('API health', async () => {
  const body = await json(`${API}/health`);
  if (body.status !== 'ok') throw new Error(`status was "${body.status}", not "ok"`);
  return 'status=ok';
});

await check('API readiness (database + Redis)', async () => {
  // This is the one that catches "deployed fine, cannot reach Postgres".
  const body = await json(`${API}/health/ready`);
  if (body.status !== 'ok') {
    throw new Error(`not ready: ${JSON.stringify(body)}`);
  }
  return 'db + redis reachable';
});

// --- The seeded restaurant exists and its menu is priced --------------------

let menu;

await check('Storefront restaurant resolves by slug', async () => {
  const r = await json(`${API}/api/storefront/restaurant`, {
    headers: { 'X-Restaurant-Slug': SLUG },
  });
  if (r.slug !== SLUG) throw new Error(`got slug "${r.slug}", expected "${SLUG}"`);
  if (!r.name) throw new Error('restaurant has no name — is the row real?');
  return `${r.name} · ${r.currency} · ${r.orderingMode}`;
});

await check('Menu has priced products', async () => {
  menu = await json(`${API}/api/storefront/menu`, { headers: { 'X-Restaurant-Slug': SLUG } });
  if (!Array.isArray(menu) || menu.length === 0) throw new Error('menu is empty');

  const products = menu.flatMap((c) => c.products ?? []);
  if (products.length === 0) throw new Error('categories exist but contain no products');

  const unpriced = products.filter((p) => typeof p.priceCents !== 'number' || p.priceCents <= 0);
  if (unpriced.length) throw new Error(`${unpriced.length} product(s) have no price`);

  return `${menu.length} categories, ${products.length} products`;
});

// --- Tenant isolation: the single most important property in the system -----

await check('An unknown slug 404s rather than leaking a default tenant', async () => {
  const res = await fetch(`${API}/api/storefront/restaurant`, {
    headers: { 'X-Restaurant-Slug': 'definitely-not-a-real-restaurant-xyz' },
  });
  if (res.status !== 404) {
    throw new Error(
      `expected 404, got ${res.status}. If this returned a restaurant, tenant resolution is falling back to a default — stop and fix it before anyone signs up.`,
    );
  }
  return '404';
});

await check('The dashboard refuses an unauthenticated caller', async () => {
  const res = await fetch(`${API}/api/restaurants/current`);
  if (res.status !== 401 && res.status !== 403) {
    throw new Error(`expected 401/403, got ${res.status} — the dashboard is not gated`);
  }
  return String(res.status);
});

// --- The web app serves the tenant, not the marketing site ------------------

await check('Storefront page renders the restaurant (not the marketing site)', async () => {
  // Path routing works everywhere, including Windows, where *.localhost does not
  // resolve. On production this is also what a custom domain rewrites to.
  const res = await fetch(`${WEB}/s/${SLUG}/menu`, { redirect: 'follow' });
  const html = await res.text();

  if (!res.ok) throw new Error(`${res.status} from ${WEB}/s/${SLUG}/menu`);

  // Asserting on CONTENT. A 200 here could still be the platform homepage.
  if (!html.includes('__NEXT_DATA__') && !html.includes('_next')) {
    throw new Error('response is not a Next.js page — is something else on this port?');
  }
  if (!/Powered by OrderOS/i.test(html)) {
    throw new Error('page rendered, but it is not the storefront layout');
  }
  return `${html.length} bytes`;
});

await check('widget.js is served and is not the 404 page', async () => {
  const res = await fetch(`${WEB}/widget.js`);
  const body = await res.text();
  if (!res.ok) throw new Error(`${res.status}`);
  if (body.includes('<!DOCTYPE') || body.includes('<html')) {
    throw new Error('widget.js returned HTML — the middleware is rewriting it (it must be excluded)');
  }
  if (!body.includes('orderos') && !body.includes('OrderOS')) {
    throw new Error('served a JS file, but it does not look like our widget');
  }
  return `${body.length} bytes of JS`;
});

// ---------------------------------------------------------------------------

console.log('');
if (failures) {
  console.log(`  \x1b[31m${failures} check(s) failed.\x1b[0m Do not send customers here.\n`);
  process.exit(1);
}
console.log('  \x1b[32mAll checks passed.\x1b[0m\n');
console.log('  NOT covered by this script, and still needing a human once:');
console.log('    - place a real order and pay it with a Stripe test card');
console.log('    - confirm the Stripe webhook arrives and moves the order to PAID');
console.log('    - confirm the SMS and email actually land\n');
