# Demo

```bash
npm run demo
```

Runs the real product against a **mock API** — no database, no Redis, no Stripe
account needed.

## Two very different pages. Don't confuse them.

### 1. The product → **http://localhost:3005/s/bellaburger**

**This is OrderOS.** The hosted storefront a restaurant gets at
`theirname.orderos.ai`. Warm neutral palette, layered shadows, tabular figures on
every price, the whole design system.

Walk it:

1. **Home** → the restaurant, its hours, what it offers.
2. **Menu** → tap *The Classic*. It has a required **Size** and optional **Extras** —
   the modifier engine, with live pricing.
3. **Checkout** → pick **Delivery**, fill it in, pay.
4. **Payment opens in a new tab** (a stand-in for Stripe, which refuses to be
   framed). Click Pay.
5. **Tracking** → the tab you left flips to live tracking. Wait ~20 seconds: a
   courier appears and **moves across a real map**, drawing his route behind him.
   Then: delivered, and a thank-you.
6. **My orders** → the way back in after closing the tab. Signed-out? Look it up by
   order number + phone.

### 2. The widget host → **http://localhost:8090**

**This is NOT our design.** It is a deliberately hideous fake restaurant website
from 2014 — Georgia serif, red Comic Sans buttons, a sticky header in a z-index
war. Its CSS is hostile *on purpose*.

The only OrderOS thing on that page is the floating **Order Now** button and the
panel it opens. That is the entire point: our widget has to survive a page we don't
control, so it lives in a Shadow DOM (their CSS cannot reach it) and an iframe
(their CSS cannot touch our checkout). Notice the site's *own* buttons are red and
dashed. Ours isn't.

If you want to judge how OrderOS looks, judge **:3005**. The ugly page is the test,
not the product.

## What's real, what's a prop

**Real** — the shipped code, unmodified: the storefront, the widget loader, the
embed app, the cart, the shared pricing engine (the browser sends product *ids*, the
server prices them), the new-tab payment hop, the tracking poll, and the courier map.

**A prop** — `scripts/demo/mock-api.mjs`: the database is an in-memory object,
Stripe is a stub page, the kitchen advances on a timer, the courier walks a straight
line, and **the widget's domain allowlist is not enforced** (the real
`WidgetTenantGuard` refuses any unregistered Origin — that's covered by tests, not
by this demo).

The **dashboard** is not in the demo: it needs Clerk, and Clerk needs real keys.

Do not deploy the mock.
