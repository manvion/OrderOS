import Link from 'next/link';
import { SignedIn, SignedOut } from '@clerk/nextjs';
import { ArrowRight, Bike, ChefHat, QrCode, Truck } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col overflow-x-hidden bg-background">
      <header className="border-b bg-background/80 backdrop-blur-sm">
        <div className="container flex h-16 items-center justify-between">
          <span className="text-lg font-bold tracking-tight">DineDirect</span>
          <div className="flex items-center gap-2">
            <SignedOut>
              <Button asChild variant="ghost" size="sm">
                <Link href="/sign-in">Sign in</Link>
              </Button>
              <Button asChild size="sm">
                <Link href="/sign-up">Get started</Link>
              </Button>
            </SignedOut>
            <SignedIn>
              <Button asChild size="sm">
                <Link href="/dashboard">Dashboard</Link>
              </Button>
            </SignedIn>
          </div>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero: brand, one headline, one line, one CTA, one visual anchor. Left-aligned
            on purpose -- centered-everything is the fastest way to look like a template. */}
        <section className="relative">
          <div
            className="pointer-events-none absolute inset-0 -z-10"
            style={{
              background:
                'radial-gradient(ellipse 900px 500px at 15% -10%, color-mix(in srgb, var(--brand) 12%, transparent), transparent)',
            }}
          />

          <div className="container grid gap-12 py-20 lg:grid-cols-[1.1fr_1fr] lg:items-center lg:py-28">
            <div>
              <span className="rise-1 inline-flex items-center gap-1.5 rounded-full border border-brand-subtle bg-brand-subtle px-3 py-1 text-xs font-semibold text-brand">
                No marketplace commission, ever
              </span>

              <h1 className="rise-2 mt-5 max-w-xl text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl">
                Your restaurant.
                <br />
                Your website.
                <br />
                <span className="text-brand">Your margin.</span>
              </h1>

              <p className="rise-3 mt-6 max-w-md text-lg text-muted-foreground">
                Take orders straight from your own site — pickup, delivery, dine-in. Stripe handles
                the money, Uber handles the driving. You keep what a 30% marketplace cut used to
                take.
              </p>

              <div className="rise-4 mt-9 flex flex-wrap items-center gap-4">
                <Button asChild size="lg" variant="brand">
                  <Link href="/sign-up">
                    Start free
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </Button>
                <p className="text-sm text-muted-foreground">Live in an afternoon. No card required.</p>
              </div>
            </div>

            {/* The visual anchor. Not stock art -- the product's own kitchen ticket, the
                thing an owner will stare at fifty times a shift once they're live. */}
            <div className="rise-4 relative mx-auto w-full max-w-sm lg:mx-0 lg:ml-auto">
              <div
                className="absolute -inset-6 -z-10 rounded-[2rem] opacity-60 blur-2xl"
                style={{
                  background:
                    'linear-gradient(135deg, color-mix(in srgb, var(--brand) 25%, transparent), transparent 60%)',
                }}
              />
              <div className="card-interactive overflow-hidden rounded-3xl p-5">
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

        {/* Features: alternating rows, not a symmetric icon grid. Each one earns its own
            weight instead of being flattened into an identical box next to the others.
            .animate-rise, not <Reveal> -- Reveal needs a real scroll past an
            IntersectionObserver with no SSR fallback in its current implementation,
            which is the wrong trade for copy that has to be readable unconditionally. */}
        <section className="container space-y-20 py-20 lg:py-28">
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
              title="Mark it ready. Uber takes it from there."
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
      </main>

      <footer className="border-t bg-muted/30 py-10">
        <div className="container flex flex-col items-center justify-between gap-4 sm:flex-row">
          <span className="text-sm font-semibold">DineDirect</span>
          <p className="text-sm text-muted-foreground">
            Built for restaurants that would rather keep their customers than rent them back.
          </p>
        </div>
      </footer>
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
