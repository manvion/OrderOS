import Link from 'next/link';
import Image from 'next/image';
import { headers } from 'next/headers';
import { ArrowRight, Clock, Mail, MapPin, Phone, ShoppingBag, Truck, UtensilsCrossed } from 'lucide-react';
import { WEEKDAYS, isOpenAt, type BusinessHours } from '@orderos/shared';
import { storefrontApi } from '@/lib/api';
import { Button } from '@/components/ui/button';

export const revalidate = 300;

/**
 * About / contact / hours.
 *
 * Every restaurant website has this page, and every restaurant is asked these
 * questions on the phone all day: when are you open, where are you, do you
 * deliver. Answering them here is not decoration — it is the page that stops the
 * kitchen's phone ringing during service.
 *
 * Entirely generated from data the restaurant has already entered. There is
 * nothing extra for them to fill in, which is the only reason it will actually be
 * accurate a year from now.
 */
export default async function AboutPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const restaurant = await storefrontApi.getRestaurant(slug);

  const basePath = (await headers()).get('x-restaurant-slug') ? '' : `/s/${slug}`;
  const href = (path: string) => `${basePath}${path}`;

  const hours = restaurant.businessHours as BusinessHours;
  const today = WEEKDAYS[new Date().getDay()];

  const options = [
    restaurant.pickupEnabled && {
      icon: ShoppingBag,
      title: 'Pickup',
      body: `Order ahead and collect. Usually ready in about ${restaurant.prepTimeMinutes} minutes.`,
    },
    restaurant.deliveryEnabled && {
      icon: Truck,
      title: 'Delivery',
      body: 'We bring it to you. You can follow your driver on a live map the whole way.',
    },
    restaurant.dineInEnabled && {
      icon: UtensilsCrossed,
      title: 'Dine in',
      body: 'Scan the code on your table and order from your phone. No waiting to catch an eye.',
    },
  ].filter(Boolean) as Array<{ icon: typeof Truck; title: string; body: string }>;

  return (
    <div className="animate-rise">
      {/* Header */}
      <section className="border-b bg-muted/30">
        <div className="mx-auto max-w-3xl px-5 py-16 sm:px-8 sm:py-20">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            About {restaurant.name}
          </h1>
          {restaurant.description && (
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted-foreground">
              {restaurant.description}
            </p>
          )}
        </div>
      </section>

      <div className="mx-auto max-w-3xl space-y-16 px-5 py-16 sm:px-8">
        {/* Hours. The single most-asked question, answered first, with today
            highlighted — because "what are your hours" almost always means
            "are you open right now". */}
        <section>
          <h2 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight">
            <Clock className="h-5 w-5" />
            Opening hours
          </h2>

          <p className="mt-2 text-sm text-muted-foreground">
            {isOpenAt(hours, restaurant.timezone) ? (
              <span className="inline-flex items-center gap-1.5 font-medium text-emerald-600">
                <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-emerald-600" />
                Open right now
              </span>
            ) : (
              'Closed right now'
            )}
          </p>

          <dl className="mt-6 divide-y rounded-2xl border">
            {WEEKDAYS.map((day) => {
              const dayHours = hours?.[day];
              const isToday = day === today;

              return (
                <div
                  key={day}
                  className={`flex items-center justify-between px-5 py-3.5 ${
                    isToday ? 'bg-brand-subtle font-medium' : ''
                  }`}
                >
                  <dt className="capitalize">
                    {day}
                    {isToday && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">today</span>
                    )}
                  </dt>
                  <dd className="tabular-nums text-muted-foreground">
                    {!dayHours || dayHours.closed || dayHours.windows.length === 0
                      ? 'Closed'
                      : dayHours.windows.map((w) => `${w.open} – ${w.close}`).join(', ')}
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>

        {/* How to order */}
        {options.length > 0 && (
          <section>
            <h2 className="text-2xl font-bold tracking-tight">How to order</h2>

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              {options.map(({ icon: Icon, title, body }, i) => (
                <div
                  key={title}
                  className="rounded-2xl border p-6"
                  // Stagger the entrance so the cards arrive in sequence rather
                  // than all at once. It reads as considered; a simultaneous fade
                  // reads as a page finishing loading.
                  style={{ animationDelay: `${i * 70}ms` }}
                >
                  <Icon className="h-5 w-5 text-brand" />
                  <h3 className="mt-3 font-semibold">{title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{body}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Find us */}
        <section>
          <h2 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight">
            <MapPin className="h-5 w-5" />
            Find us
          </h2>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border p-6">
              <p className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
                Address
              </p>
              <address className="mt-2 not-italic leading-relaxed">
                {restaurant.street}
                <br />
                {restaurant.city}, {restaurant.state} {restaurant.postalCode}
              </address>

              {/* Straight into their maps app. On a phone this is the only thing
                  anyone actually wants from an address. */}
              <a
                href={`https://maps.google.com/?q=${encodeURIComponent(
                  `${restaurant.name}, ${restaurant.street}, ${restaurant.city}`,
                )}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-brand hover:underline"
              >
                Get directions
                <ArrowRight className="h-3.5 w-3.5" />
              </a>
            </div>

            <div className="rounded-2xl border p-6">
              <p className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
                Get in touch
              </p>

              <a
                href={`tel:${restaurant.phone}`}
                className="mt-3 flex items-center gap-2.5 hover:underline"
              >
                <Phone className="h-4 w-4 text-muted-foreground" />
                {restaurant.phone}
              </a>

              <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
                Something wrong with an order? Call us — we&apos;d much rather fix it than have you
                leave unhappy.
              </p>
            </div>
          </div>
        </section>

        {/* The pitch, again. It belongs on the About page more than anywhere else:
            this is where someone lands when they're deciding whether to trust a
            restaurant's own site over the app they already have installed. */}
        <section className="rounded-2xl bg-muted/50 p-8 text-center sm:p-10">
          <p className="mx-auto max-w-lg text-lg font-medium leading-relaxed">
            When you order here, your money goes to this kitchen.
          </p>
          <p className="mx-auto mt-2.5 max-w-md text-sm leading-relaxed text-muted-foreground">
            Delivery apps take up to 30% of every order. Ordering direct means the people who
            cooked your food keep what you paid for it.
          </p>

          <Button asChild variant="brand" size="lg" className="mt-7 rounded-xl px-8">
            <Link href={href('/menu')}>
              See the menu
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </section>
      </div>
    </div>
  );
}
