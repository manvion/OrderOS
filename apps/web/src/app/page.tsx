import Link from 'next/link';
import { headers } from 'next/headers';
import { SignedIn, SignedOut } from '@clerk/nextjs';
import { currencyForCountry } from '@dinedirect/shared';
import {
  ArrowRight,
  BarChart3,
  Bike,
  Boxes,
  CalendarDays,
  ChefHat,
  Code2,
  CreditCard,
  Gift,
  Globe,
  Landmark,
  Percent,
  QrCode,
  Rocket,
  Smartphone,
  Truck,
  UtensilsCrossed,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Reveal } from '@/components/shared/reveal';
import { PricingSection } from '@/components/marketing/pricing-section';

/**
 * Every service the product offers, tagged with the tier it starts on — so the page
 * both SHOWS the surface area and answers "what do I actually get for each plan"
 * without a separate matrix. The tiers here mirror packages/shared/src/plans.ts.
 */
const SERVICES: Array<{
  icon: typeof QrCode;
  title: string;
  body: string;
  tier: 'Starter' | 'Growth' | 'Pro';
}> = [
  { icon: QrCode, title: 'QR ordering', body: 'Table, counter and kitchen codes. Guests order from their own phone — no app to download.', tier: 'Starter' },
  { icon: ChefHat, title: 'Kitchen board', body: 'Live tickets by the pass, colour-coded by wait, with a one-tap "ready".', tier: 'Starter' },
  { icon: CreditCard, title: 'Card, Apple & Google Pay', body: 'Secure, encrypted checkout on every plan. Money lands straight in your account.', tier: 'Starter' },
  { icon: Globe, title: 'Your ordering website', body: 'A branded storefront at your own address, live the same afternoon you sign up.', tier: 'Growth' },
  { icon: Truck, title: 'Automatic delivery', body: 'Mark it ready; a courier is dispatched and your customer watches a live map.', tier: 'Growth' },
  { icon: Percent, title: 'Promotions & discounts', body: 'Codes, happy-hour deals and limited offers that price themselves at checkout.', tier: 'Growth' },
  { icon: Gift, title: 'Loyalty program', body: 'Points on every order that quietly turn first-timers into regulars.', tier: 'Growth' },
  { icon: Code2, title: 'Embeddable widget', body: 'Drop ordering into a website you already have with one line of script.', tier: 'Growth' },
  { icon: BarChart3, title: 'Analytics & history', body: 'Revenue, top items and every past order, searchable — not just today at a glance.', tier: 'Growth' },
  { icon: Boxes, title: 'Inventory', body: 'Track stock per item and auto-86 what runs out before it oversells.', tier: 'Pro' },
  { icon: CalendarDays, title: 'Staff scheduling', body: 'Shifts, an activity log and roles, so the right people see the right screens.', tier: 'Pro' },
  { icon: Landmark, title: 'Multi-jurisdiction tax', body: 'Correct, separately-named tax lines and reports your accountant will actually accept.', tier: 'Pro' },
];

const TIER_PILL: Record<'Starter' | 'Growth' | 'Pro', string> = {
  Starter: 'bg-muted text-muted-foreground',
  Growth: 'bg-brand/15 text-brand',
  Pro: 'bg-foreground text-background',
};

const TICKER_ITEMS = [
  'The lowest per-order fee around',
  'Secure, encrypted checkout',
  'Delivery dispatched automatically',
  'QR ordering for every table',
  'Live the same day you sign up',
];

export default async function LandingPage() {
  /**
   * Price the marketing page in the visitor's OWN currency, resolved from geo-IP.
   *
   * Vercel (and most CDNs) stamp the request with the caller's country; we map that
   * to a currency server-side so the first paint already shows the right money — no
   * flash of dollars before a client-side guess corrects it. Falls back to a browser
   * -locale guess inside PricingSection when the header is absent (local dev, or a
   * host that doesn't set it).
   */
  const headerList = await headers();
  const geoCountry =
    headerList.get('x-vercel-ip-country') ??
    headerList.get('x-country') ??
    headerList.get('cf-ipcountry');
  const initialCurrency = geoCountry ? currencyForCountry(geoCountry) : undefined;

  return (
    <div className="flex min-h-screen flex-col overflow-x-hidden bg-background">
      {/* Dark, permanently -- this header only ever lives on THIS page, and the
          section right under it is always the dark hero. A light header here
          was a leftover from before the hero went dark: a hard white-to-black
          seam at the very first thing anyone sees. */}
      <header className="border-b border-white/10 bg-foreground/95 text-background backdrop-blur-sm">
        <div className="container flex h-16 items-center justify-between gap-6">
          <span className="shrink-0 text-lg font-bold tracking-tight">DineDirect</span>

          <nav className="hidden items-center gap-1 md:flex">
            <a
              href="#why-direct"
              className="rounded-lg px-3 py-2 text-sm font-medium text-background/70 transition-colors hover:bg-white/10 hover:text-background"
            >
              Why direct
            </a>
            <a
              href="#features"
              className="rounded-lg px-3 py-2 text-sm font-medium text-background/70 transition-colors hover:bg-white/10 hover:text-background"
            >
              Features
            </a>
            <a
              href="#how-it-works"
              className="rounded-lg px-3 py-2 text-sm font-medium text-background/70 transition-colors hover:bg-white/10 hover:text-background"
            >
              How it works
            </a>
            <a
              href="#pricing"
              className="rounded-lg px-3 py-2 text-sm font-medium text-background/70 transition-colors hover:bg-white/10 hover:text-background"
            >
              Pricing
            </a>
          </nav>

          <div className="flex items-center gap-2">
            <SignedOut>
              <Button asChild variant="ghost" size="sm" className="text-background hover:bg-white/10 hover:text-background">
                <Link href="/sign-in">Sign in</Link>
              </Button>
              <Button asChild variant="brand" size="sm">
                <Link href="/sign-up">Get started</Link>
              </Button>
            </SignedOut>
            <SignedIn>
              <Button asChild variant="brand" size="sm">
                <Link href="/dashboard">Dashboard</Link>
              </Button>
            </SignedIn>
          </div>
        </div>
      </header>

      <main className="flex-1">
        {/*
          HERO -- dark, on purpose. Section RHYTHM (dark/light/dark/light) is what
          separates a page that feels composed from a page that's one long cream
          scroll with headings dropped in. A flat-background hero next to a
          flat-background everything-else is the actual "looks like a template"
          tell, more than any one section's content.
        */}
        <section className="relative overflow-hidden bg-foreground text-background">
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                'radial-gradient(ellipse 1000px 600px at 20% 0%, color-mix(in srgb, var(--brand) 35%, transparent), transparent 60%)',
            }}
          />

          <div className="container relative grid gap-12 py-20 lg:grid-cols-[1.1fr_1fr] lg:items-center lg:py-28">
            <div>
              <span className="rise-1 inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs font-semibold backdrop-blur-sm">
                Flat plans · 0% commission on Pro
              </span>

              <h1 className="rise-2 mt-5 max-w-xl text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl">
                Your restaurant.
                <br />
                Your website.
                <br />
                <span className="text-brand">Your margin.</span>
              </h1>

              <p className="rise-3 mt-6 max-w-md text-lg text-background/70">
                Take orders straight from your own site — pickup, delivery, dine-in. A flat monthly
                plan and a per-order fee a fraction of a marketplace's, so you keep what their 30%
                cut used to take.
              </p>

              <div className="rise-4 mt-9 flex flex-wrap items-center gap-4">
                <Button asChild size="lg" variant="brand">
                  <Link href="/sign-up">
                    Start free
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </Button>
                <p className="text-sm text-background/60">Live in an afternoon. No card required.</p>
              </div>
            </div>

            {/* The visual anchor. Not stock art -- the product's own kitchen ticket, the
                thing an owner will stare at fifty times a shift once they're live. */}
            <div className="rise-4 relative mx-auto w-full max-w-sm lg:mx-0 lg:ml-auto">
              <div
                className="absolute -inset-6 -z-10 rounded-[2rem] opacity-70 blur-2xl"
                style={{
                  background:
                    'linear-gradient(135deg, color-mix(in srgb, var(--brand) 45%, transparent), transparent 60%)',
                }}
              />
              <div className="card-interactive overflow-hidden rounded-3xl p-5 text-foreground">
                <div className="flex items-center justify-between border-b pb-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                      Order 0714-003
                    </p>
                    <p className="mt-0.5 font-mono text-2xl font-black tracking-tight">VXKY</p>
                  </div>
                  <span className="pulse-dot inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500 text-emerald-500" />
                </div>

                <ul className="mt-3 space-y-2 text-sm">
                  <li className="flex justify-between">
                    <span>2× Smash burger, no onion</span>
                    <span className="tabular-nums text-muted-foreground">24.00</span>
                  </li>
                  <li className="flex justify-between">
                    <span>1× Truffle fries</span>
                    <span className="tabular-nums text-muted-foreground">7.50</span>
                  </li>
                </ul>

                <div className="mt-4 flex items-center gap-2 rounded-xl bg-emerald-50 p-3 text-sm font-medium text-emerald-900">
                  <Truck className="h-4 w-4 shrink-0" />
                  Driver assigned — 8 min out
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Ticker. A thin band of motion between two big static sections -- the
            page needs ONE thing that's alive at a glance, not zero. */}
        <div className="overflow-hidden border-b bg-brand py-2.5 text-brand-foreground">
          <div className="marquee-track flex w-max gap-10 whitespace-nowrap text-sm font-semibold">
            {[...TICKER_ITEMS, ...TICKER_ITEMS].map((item, i) => (
              <span key={i} className="flex items-center gap-10">
                {item}
                <span aria-hidden className="opacity-50">
                  ·
                </span>
              </span>
            ))}
          </div>
        </div>

        {/*
          THE PROBLEM. A case, built with real, well-known industry figures --
          not invented stats about a product with no customers yet.
        */}
        <section id="why-direct" className="border-b bg-foreground py-20 text-background lg:py-24">
          <div className="container">
            <p className="text-sm font-semibold uppercase tracking-widest text-brand">
              The problem
            </p>
            <h2 className="mt-2 max-w-lg text-3xl font-bold tracking-tight sm:text-4xl">
              Marketplace apps are renting you your own customers back.
            </h2>

            <div className="mt-10 grid gap-6 sm:grid-cols-3">
              <Stat
                value="Up to 30%"
                label="The cut a delivery marketplace takes out of every single order"
              />
              <Stat
                value="3 apps"
                label="Separate tablets and logins to juggle through a dinner rush"
              />
              <Stat
                value="0"
                label="Customer emails or phone numbers a marketplace ever hands back to you"
              />
            </div>
          </div>
        </section>

        {/* Features: alternating rows, not a symmetric icon grid. Each one earns its own
            weight instead of being flattened into an identical box next to the others.
            .animate-rise, not <Reveal> -- Reveal needs a real scroll past an
            IntersectionObserver with no SSR fallback in its current implementation,
            which is the wrong trade for copy that has to be readable unconditionally. */}
        <section id="features" className="container space-y-20 py-20 lg:py-28">
          <div className="animate-rise">
            <FeatureRow
              icon={ChefHat}
              eyebrow="Your ordering page"
              title="A site that's unmistakably yours"
              body="A branded storefront at yourname.dinedirect.manvion.ca, live the same day you sign up. Pickup, delivery and dine-in, all from one menu you control."
            />
          </div>
          <div className="animate-rise">
            <FeatureRow
              icon={Bike}
              eyebrow="Delivery, without a fleet"
              title="Mark it ready. A courier takes it from there."
              body="One tap dispatches a courier automatically — no phone calls, no separate app. Your customer gets a live map and a real ETA, watching their own order move."
            />
          </div>
          <div className="animate-rise">
            <FeatureRow
              icon={QrCode}
              eyebrow="On the table, in the kitchen"
              title="Print a code. Skip the app store."
              body="Table QR for dine-in, counter QR for pickup, a kitchen QR for staff. Guests order from a phone they already have — nobody downloads anything to eat dinner."
            />
          </div>
        </section>

        {/* How it works -- dark again, keeping the rhythm going. Three real steps
            from the actual onboarding flow, not a generic "1-2-3, magic" beat. */}
        <section id="how-it-works" className="border-y bg-foreground py-20 text-background lg:py-24">
          <div className="container">
            <p className="text-sm font-semibold uppercase tracking-widest text-brand">
              Go live in three steps
            </p>
            <h2 className="mt-2 max-w-lg text-3xl font-bold tracking-tight sm:text-4xl">
              No sales call required.
            </h2>

            <div className="mt-10 grid gap-8 sm:grid-cols-3">
              <Step
                number={1}
                icon={UtensilsCrossed}
                title="Build your menu"
                body="Categories, prices, modifiers — or photograph your paper menu and let it read the items in for you."
              />
              <Step
                number={2}
                icon={CreditCard}
                title="Connect payment methods"
                body="A few minutes of secure onboarding. Once it's done, you can take a card."
              />
              <Step
                number={3}
                icon={Rocket}
                title="Publish"
                body="Your ordering page goes live at your own address. Print the QR codes and open for business."
              />
            </div>
          </div>
        </section>

        {/* Services showcase -- the full surface area, each tile tagged with the
            plan it starts on, revealing on scroll. This is the "what do I actually
            get" section, and the tier pills double as a plain-language plan matrix. */}
        <section className="container py-20 lg:py-28">
          <Reveal className="mx-auto max-w-2xl text-center">
            <p className="text-sm font-semibold uppercase tracking-widest text-brand">
              Everything in one place
            </p>
            <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
              One login runs the whole restaurant.
            </h2>
            <p className="mt-4 text-muted-foreground">
              Not three apps stitched together — ordering, kitchen, delivery, marketing and the
              back office, in a single place. Each tile shows the plan it starts on.
            </p>
          </Reveal>

          <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {SERVICES.map((s, i) => (
              <Reveal key={s.title} delay={(i % 3) * 80} className="h-full">
                <div className="card-interactive group h-full p-6">
                  <div className="flex items-center justify-between">
                    <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-subtle text-brand transition-transform duration-200 group-hover:scale-110">
                      <s.icon className="h-5 w-5" />
                    </div>
                    <span
                      className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${TIER_PILL[s.tier]}`}
                    >
                      {s.tier}
                    </span>
                  </div>
                  <h3 className="mt-4 text-lg font-bold">{s.title}</h3>
                  <p className="mt-1.5 text-sm text-muted-foreground">{s.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        {/* Pricing -- computed from the same table the API bills from, so the number
            here is the number a restaurant is charged. Currency comes from the
            visitor's geo-IP, resolved server-side above. */}
        <PricingSection initialCurrency={initialCurrency} />

        {/* Final CTA -- solid brand colour, the one place on the page that should
            feel loud. Everything before this earned the right to ask. */}
        <section className="bg-brand py-20 text-brand-foreground">
          <div className="container flex flex-col items-center gap-6 text-center">
            <h2 className="max-w-xl text-3xl font-bold tracking-tight sm:text-4xl">
              Stop paying a marketplace 30% on food you already cooked.
            </h2>
            <Button
              asChild
              size="lg"
              className="rounded-xl bg-white px-8 text-base font-semibold text-black shadow-floating hover:bg-white/90"
            >
              <Link href="/sign-up">
                Start free
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </section>
      </main>

      <footer className="bg-foreground py-10 text-background/70">
        <div className="container flex flex-col items-center justify-between gap-4 sm:flex-row">
          <span className="text-sm font-semibold text-background">DineDirect</span>
          <p className="text-sm">
            Built for restaurants that would rather keep their customers than rent them back.
          </p>
        </div>
      </footer>
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
      <p className="text-4xl font-black tabular-nums text-brand">{value}</p>
      <p className="mt-2 text-sm text-background/70">{label}</p>
    </div>
  );
}

function Step({
  number,
  icon: Icon,
  title,
  body,
}: {
  number: number;
  icon: typeof UtensilsCrossed;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
      <div className="flex items-center gap-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-sm font-bold text-brand-foreground">
          {number}
        </span>
        <Icon className="h-5 w-5 text-brand" />
      </div>
      <h3 className="mt-4 text-lg font-bold">{title}</h3>
      <p className="mt-2 text-sm text-background/70">{body}</p>
    </div>
  );
}

function FeatureRow({
  icon: Icon,
  eyebrow,
  title,
  body,
}: {
  icon: typeof ChefHat;
  eyebrow: string;
  title: string;
  body: string;
}) {
  return (
    <div className="flex items-start gap-6">
      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-brand-subtle text-brand">
        <Icon className="h-6 w-6" />
      </div>
      <div>
        <p className="text-sm font-semibold uppercase tracking-widest text-brand">{eyebrow}</p>
        <h2 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">{title}</h2>
        <p className="mt-3 max-w-xl text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}
