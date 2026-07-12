# OrderOS roadmap

What a mature version of this company builds, in the order it should build it.

The organising principle: **a restaurant platform is a trust business.** Every
feature below is ranked by how much trust it creates or destroys, not by how good
it looks in a demo. A missing loyalty programme costs you a little growth. A lost
order costs you the customer forever.

---

## Shipped (this pass)

- **Notification engine** — every status, to *both* the customer and the restaurant,
  over SMS and email. Delivery thank-you, restaurant "order complete" receipt,
  printable kitchen ticket. STOP/START handling. Every message logged (sent,
  failed, or deliberately skipped) so "they say they never got the text" is
  answerable.
- **Live courier map** — Leaflet + OpenStreetMap, no API key, no per-view billing.
  Courier breadcrumb trail so the pin glides along a route rather than teleporting.
- **Payment reconciliation sweeper** — catches orders where the customer paid but
  the webhook never arrived. This was the worst failure mode in the system: we took
  the money and silently didn't make the food.
- **Redis-backed rate limiting** — the in-memory default was per-process, so three
  replicas meant 3× the limit.
- **Staff invitations** — previously a restaurant could never add a second person.
- **Business hours editor** — previously every restaurant was stuck on 11:00–22:00.
- **Refunds in the dashboard** — the endpoint existed; there was no button.

---

## Tier 1 — Before you take a paying customer

Not features. Table stakes. The product is dishonest without them.

| | Why |
|---|---|
| **Real integration tests** (testcontainers + Stripe test fixtures) | 48 unit tests cover pure functions. Nothing proves the tenant guard actually blocks a cross-tenant read, or that the Stripe webhook is genuinely idempotent. Those *are* the security model. |
| **Dispute / chargeback handling** | Stripe sends `charge.dispute.created`. We ignore it. A restaurant finding out about a chargeback from their bank statement is a lost customer. |
| **Error tracking + structured logs** (Sentry, OpenTelemetry) | Right now a 500 in production is invisible. You will not find out; the restaurant will tell you, angrily. |
| **Address geocoding** | `deliveryRadiusMeters` is currently decorative — it's stored, validated, and enforced nowhere. Delivery range is "whatever Uber agrees to". |
| **CI pipeline** | Nothing stops a broken build reaching main. |
| **Backups + restore drill** | A backup you have never restored is not a backup. |
| **Privacy policy, terms, GDPR delete path** | We store names, phones, emails and addresses of people who never signed up for anything. |

---

## Tier 2 — What makes restaurants stay

The stuff that turns "I tried it" into "I'd switch back to DoorDash over my dead body".

**Kitchen Display System (KDS).** A dedicated, always-on kitchen screen: big type,
colour-coded ticket ages, audible new-order alarm, bump-to-complete. The dashboard
is for owners; the KDS is for the line. This is the single feature restaurants ask
for first and it's the one that gets you left on the wall.

**Printer integration** (Star, Epson ESC/POS via CloudPRNT). Kitchens run on paper.
A platform that can't drive a thermal printer is a platform the head chef refuses to
use.

**Menu scheduling.** Breakfast until 11, lunch until 4, a different Sunday menu. The
schema is one `availabilitySchedule` JSON field away and it is asked for constantly.

**Item-level tax categories.** One flat `taxRateBps` per restaurant is wrong in most
US jurisdictions — prepared food, packaged food and alcohol are taxed differently. A
restaurant that under-collects tax finds out at audit, and blames us.

**Order throttling / pacing.** At peak, a kitchen physically cannot cook 40 orders in
10 minutes. Auto-extend quoted prep time as the queue grows, and pause ordering when
the kitchen is drowning. Without this, the busiest night of the year is the night
your product ruins.

**Modifier inventory (86ing that cascades).** Right now you can mark a product sold
out. You cannot mark *bacon* sold out — so every burger stays orderable with bacon
that doesn't exist.

**Multi-location.** A restaurant group with five sites currently needs five accounts.
Needs a Location model under Restaurant, shared menus with per-site overrides, and a
group-level dashboard.

---

## Tier 3 — What makes customers come back

Where the money is, once the machine works.

**Customer accounts + saved cards.** Repeat ordering in two taps. Stripe Customer +
saved payment methods. Guest checkout stays — forcing signup kills conversion — but
returning customers should never retype an address.

**Loyalty.** Points, or a stamp card, or "every 10th coffee free". The single most
effective retention tool in food, and the one thing marketplaces cannot replicate,
because *they* own the customer and the restaurant doesn't.

**Promotions and coupons.** `discountCents` is already threaded through the pricing
engine and the schema, and nothing sets it. Percentage-off, first-order, free
delivery over £X, happy hour.

**Reorder.** "Order that again" from the thank-you email. Trivial to build, enormous
conversion.

**Reviews + ratings** — collected by the restaurant, owned by the restaurant. On a
marketplace a bad review is public forever; here it's a private signal the owner can
act on and a public one they can choose to publish.

**Email/SMS marketing** to the customer list the restaurant now owns. This is the
whole pitch of direct ordering: *these are your customers, not Uber's*. Requires
proper consent handling (the `marketingOptIn` field already exists).

**Scheduled order improvements** — a proper time-slot picker with capacity limits,
rather than a free-text datetime.

---

## Tier 4 — Platform maturity

**Self-serve delivery zones** drawn on a map, with per-zone fees. Combined with
geocoding, this replaces the decorative radius.

**Own-driver dispatch.** Many restaurants have their own driver and want Uber only as
overflow. Model a Driver, give them a phone view, fall back to Uber automatically.

**Third-party menu sync.** Push the menu to Google Business Profile / Apple Maps
"Order" buttons. Free demand.

**Analytics that give advice, not numbers.** "Your delivery fee is losing you $1.40
per order." "Tuesdays are dead — try a promotion." The delivery-economics panel
already does one of these; it's a template for the rest.

**White-label mobile apps** (React Native) for restaurants that want an app icon on
the home screen.

**Public API + webhooks** so a restaurant's POS can sync.

**POS integration** (Square, Toast, Lightspeed). The single biggest enterprise
blocker: a restaurant will not run two systems.

---

## Tier 5 — Scale

- **Read replicas + connection pooling** (PgBouncer). The `orders` table is the hot
  path and every dashboard poll hits it.
- **Order archival.** Orders are immutable after completion; partition or archive
  them and the live table stays small forever.
- **Webhook queue** (BullMQ). Stripe and Uber webhooks currently process inline; at
  volume they should be enqueued and acked instantly.
- **Multi-region.** Restaurants are hyper-local; the database doesn't need to be
  global, but the API and CDN do.
- **SOC 2**, if you ever want to sell to a chain.

---

## The one thing I would not build

**A consumer marketplace.** The moment OrderOS has a "browse restaurants near you"
page, it is competing with its own customers for the customer relationship — which
is the exact thing they left DoorDash to escape. The entire value proposition is
*these are your customers, not ours*. Breaking that would be the most tempting and
most fatal thing this company could do.
