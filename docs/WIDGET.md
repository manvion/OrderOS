# The OrderOS Widget

Add online ordering to a website you already have. No rebuild, no migration, no
moving your domain. Customers order and pay **without ever leaving your site**.

---

## For restaurant owners: install it

### 1. Register your website

In your OrderOS dashboard → **My website** → *Add a website*.

Enter your domain (`joesburgers.com`). This is a security boundary, not a
formality: the widget will only run on domains you register here, so if your code
snippet is copied onto someone else's site, it does nothing.

You'll get a snippet that looks like this:

```html
<script src="https://cdn.orderos.ai/widget.js" data-orderos-key="wk_9f3a…" defer></script>
```

### 2. Paste it into your website

Put it just before the closing `</body>` tag. Instructions per platform below.

### 3. Load your homepage once

The dashboard badge flips from **Not detected yet** to **Installed ✓** the moment
we see the widget running on your real site. If it doesn't flip, jump to
[Troubleshooting](#troubleshooting).

That's the whole install. Everything else — button colour, text, position, whether
the menu is inline or a popup — is changed in the dashboard and takes effect on
your live site within minutes, without you editing your website again.

---

## Platform guides

### WordPress

**The plugin (recommended).** Install `orderos.zip`, go to **Settings → OrderOS**,
paste your widget key, save. Done — you never touch a theme file.

The plugin also gives you two shortcodes:

| Shortcode | What it does |
|---|---|
| `[orderos_menu]` | Embeds your live menu in the page. Set the widget to *Menu embedded in the page* in your dashboard first. |
| `[orderos_button text="Order Now"]` | A button, styled by your theme, that opens the ordering window. |

**Without the plugin.** Appearance → Theme File Editor → `footer.php`, paste the
snippet before `</body>`. Note that a theme update can overwrite this — the plugin
exists precisely so it doesn't.

### Wix

Settings → **Custom Code** → *Add Custom Code*. Paste the snippet, set *Place code
in* to **Body – end**, and apply to **All pages**.

⚠️ Register your **published** domain, not the `*.wixsite.com` editor preview — the
Origin differs between the two, and the widget will correctly refuse to run on a
domain you haven't registered. If you want it working on both, add both.

### Squarespace

Settings → **Advanced** → *Code Injection* → **Footer**. Paste and save.

Squarespace's editor preview runs on a different origin than your live site; the
widget will show up on the live site.

### Plain HTML

Paste the snippet before `</body>` on every page you want ordering on. If you have
an includes/partial for the footer, put it there once.

```html
  <!-- … your page … -->
  <script src="https://cdn.orderos.ai/widget.js" data-orderos-key="wk_…" defer></script>
</body>
</html>
```

### Shopify / Webflow / anything else

Anywhere you can paste a `<script>` tag into the page footer, this works. There is
nothing platform-specific about it.

---

## Display modes

Set these in **My website → Customise appearance**.

**Floating button** (default) — a button in the corner of every page. Works
everywhere, needs no changes to your site.

**Menu embedded in the page** — your menu renders inline, in the page flow, wherever
you put this container:

```html
<div id="orderos-menu"></div>
```

It sizes itself to its content (no scrollbar-inside-a-scrollbar). Checkout still
opens as a popup on top, because a checkout form that scrolls away mid-page is a
checkout people abandon.

**My own button** — no UI from us. Wire up your existing button:

```html
<button onclick="OrderOS.open()">Order Now</button>

<!-- or, without touching your markup: -->
<script>OrderOS.attach('#my-existing-order-button');</script>
```

### The JavaScript API

```js
OrderOS.open();        // open the ordering window
OrderOS.close();       // close it
OrderOS.cartCount();   // items currently in the cart
OrderOS.attach(sel);   // make any element(s) open the widget on click
```

---

## How payment works (and why a new tab opens)

Stripe does not permit its checkout page to be displayed inside an iframe — it sets
`frame-ancestors` and would render as a blank box. That is Stripe protecting
customers from a real attack (a fake site framing a real payment form), and it is
not something we can or should work around.

So when the customer pays:

1. Stripe Checkout opens **in a new tab**.
2. The tab on *your* website stays exactly where it is, showing "finish paying in
   the new tab".
3. The moment the payment lands, your tab flips to live order tracking.

The customer never navigates away from your website. If their browser blocks the
popup, the widget shows a button to open payment manually — a click is a user
gesture, which every popup blocker allows.

---

## Security

**The widget key is public.** It's in your page source; anyone can read it. It is
an identifier, not a password, and you don't need to protect it.

**What protects you is the domain allowlist.** Every widget request carries the
browser's `Origin` header, which a web page cannot forge. If someone copies your
snippet onto their own site, their Origin isn't on your allowlist and the request is
refused — at the CORS layer and again at the API. Their copy of your widget is inert.

Concretely, we enforce:

- **Domain validation** — only registered domains. `www.` is handled for you;
  other subdomains are *not* implied (see below).
- **CORS** — the API only returns responses to registered origins.
- **Rate limiting** — per-IP, tighter on order creation than on menu reads.
- **Server-side pricing** — the widget sends product *ids*, never prices. Every
  price is re-read from the database and the total recomputed server-side, so a
  tampered widget on a site we don't control cannot buy a discounted burger.

**Subdomains are not implied.** Registering `joesburgers.com` does *not* authorise
`anything.joesburgers.com`. This matters on shared hosts — on `wixsite.com` or
`wordpress.com`, a sibling subdomain belongs to a different business entirely, and
implying it would let any Wix user run any other Wix restaurant's widget. If you
genuinely serve from `order.joesburgers.com`, add it explicitly.

**Rotating the key.** *My website → Rotate key* issues a new one and kills the old
one immediately. Your live site stops taking orders until you paste the new snippet
in. That's what makes it a rotation — only do it if the key ended up somewhere it
shouldn't have (and remember: it was never a secret, so that's rarely necessary).

---

## Analytics

**My website** shows the funnel per site:

```
Saw the button → Opened → Added to cart → Started checkout → Paid
```

Plus revenue, orders, and conversion rate — for *each* website, so a restaurant with
a main site and a landing page can see which one actually earns.

Two things worth knowing about these numbers:

- **Revenue is real money**, read from paid orders net of refunds — never from the
  event stream. An order that was created but never paid for is not revenue.
- **Events are deduplicated per visit.** A customer who opens the widget five times
  is one "open". Otherwise your conversion rate would fall the more engaged your
  customers were, which is precisely backwards.

We set no cookies and no cross-site identifiers. A random id in `sessionStorage`,
which dies with the tab, is all we need to compute a funnel — this is not a tracker.

---

## Troubleshooting

**The button doesn't appear.**

1. Open your browser's console (F12). We log the exact reason there, and never show
   an error to your customers.
2. `not authorised for this domain` → the domain isn't registered. Add it in
   **My website**. Check whether you're on `www.` or a preview/staging domain.
3. Nothing in the console at all → the snippet isn't on the page. View source and
   search for `orderos`. On WordPress, a caching plugin may be serving an old page:
   clear the cache.
4. `This restaurant is not currently accepting orders` → your ordering page isn't
   published. **Settings → Publish**.

**The button appears but the menu is empty.** Your menu has no available items, or
your restaurant is closed and you have "hide when closed" off. Check **Menu**.

**Everything works but no orders arrive.** Stripe isn't fully connected —
**Settings → Payments**. The widget will happily create an order and then fail at
payment, which shows up as a high "abandoned checkouts" count on the analytics
panel. That is the signal to check Stripe.

---

## For developers

### Local testing

```bash
npm run dev                      # api :4000, web :3000

# Serve the test page from a DIFFERENT origin than the app, so the widget is
# genuinely cross-origin — exactly as it will be on a real restaurant's site.
npx serve integrations/test -l 8090
```

Then:

1. Dashboard → **My website** → add a website with the domain `localhost`.
2. Copy the widget key into `integrations/test/plain-html.html`.
3. Open `http://localhost:8090/plain-html.html`.

That page is deliberately hostile — a global CSS reset, `button { background: red
!important }`, a sticky header at `z-index: 9999`. It is what a real restaurant
website looks like. The widget renders correctly on it because it lives in a Shadow
DOM (host CSS can't reach in, our CSS can't leak out) and the ordering UI is an
iframe.

### Testing on mobile

The widget always goes full-screen below 560px — a 380px-wide modal on a phone is
unusable. To test on a real device against a local server, expose it:

```bash
npx localtunnel --port 8090     # or ngrok, or a LAN IP
```

then register that hostname as an allowed domain. (This is the same reason it will
"mysteriously" not work from a phone if you skip that step: different origin.)

### Architecture

```
Restaurant's website (any platform)
│
├── widget.js                     Shadow DOM. Button + modal. No dependencies.
│   │                             Survives hostile host CSS.
│   └── <iframe src="/embed/:widgetKey">
│           │
│           └── Next.js embed app     Menu → Cart → Checkout → Tracking
│                   │                 Reuses the storefront's ProductDialog, so
│                   │                 modifier rules can't drift between the two.
│                   ↓
│              POST /api/widget/orders
│                   ↓
│              WidgetTenantGuard      (widgetKey + Origin) → restaurantId
│                   ↓
│              OrdersService          Prices from the DB. Ignores client prices.
│                   ↓
│              Stripe Checkout ──────► opens in a NEW TAB (cannot be framed)
│                                       │
└───────────────────────────────────────┘
    Widget polls the order; flips to tracking when the webhook marks it paid.
    The customer's tab never leaves the restaurant's website.
```

### Deploying the widget

`widget.js` is a static file served from the web app at `/widget.js`, with
`Access-Control-Allow-Origin: *` and a **5-minute** cache.

The short cache is deliberate. This file runs on hundreds of websites we don't
control and can't ask to update — if we cache it for a year and ship a bug, we
cannot recall it. Five minutes means a fix reaches every restaurant the same day.
It's ~9KB after gzip; the bandwidth is irrelevant next to that.

For production, point a CDN at the web app and set:

```bash
WIDGET_CDN_URL=https://cdn.orderos.ai/widget.js
```

This is baked into the snippet the dashboard generates, so **it is permanent once a
single restaurant has installed it** — a change here will not reach sites already
carrying the old URL. Choose the hostname before you onboard anyone, and keep it
serving forever.
