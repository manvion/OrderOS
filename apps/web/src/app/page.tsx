import Link from 'next/link';
import { SignedIn, SignedOut } from '@clerk/nextjs';
import { ArrowRight, QrCode, Store, Truck } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b">
        <div className="container flex h-16 items-center justify-between">
          <span className="text-lg font-bold tracking-tight">OrderOS</span>
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
        <section className="container py-24 text-center">
          <h1 className="mx-auto max-w-3xl text-4xl font-bold tracking-tight sm:text-6xl">
            Take orders on your own website.
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-lg text-muted-foreground">
            Your customers, your margins, your brand. Delivery powered by Uber, payments by Stripe —
            and no marketplace taking 30% of every order.
          </p>

          <div className="mt-10 flex flex-wrap justify-center gap-3">
            <Button asChild size="lg">
              <Link href="/sign-up">
                Start free
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </section>

        <section className="container grid gap-8 pb-24 sm:grid-cols-3">
          <Feature
            icon={Store}
            title="Your own ordering page"
            body="A branded site at yourname.orderos.ai, live in an afternoon. Pickup, delivery and dine-in."
          />
          <Feature
            icon={Truck}
            title="Delivery without a fleet"
            body="Mark an order ready and an Uber courier is dispatched automatically. Your customer gets a live map."
          />
          <Feature
            icon={QrCode}
            title="QR ordering"
            body="Print a code for every table. Guests order from their phone — no app, no waiting for a server."
          />
        </section>
      </main>

      <footer className="border-t py-8">
        <div className="container text-sm text-muted-foreground">OrderOS</div>
      </footer>
    </div>
  );
}

function Feature({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof Store;
  title: string;
  body: string;
}) {
  return (
    <div>
      <Icon className="h-6 w-6" />
      <h2 className="mt-4 font-semibold">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
