import Link from 'next/link';
import Image from 'next/image';
import { cookies, headers } from 'next/headers';
import { ArrowRight, Clock, MapPin, Phone, ShoppingBag, Truck, UtensilsCrossed } from 'lucide-react';
import { WEEKDAYS, aboutParagraphs, isOpenAt, type BusinessHours } from '@dinedirect/shared';
import { storefrontApi } from '@/lib/api';
import { previewTokenFor } from '@/lib/preview-token';
import { Button } from '@/components/ui/button';
import {
  getDictionary,
  LOCALE_COOKIE,
  toLocale,
  type Dictionary,
  type Locale,
} from '@/lib/i18n/dictionaries';

export const revalidate = 300;

/**
 * About / contact / hours.
 *
 * Every restaurant website has this page, and every restaurant is asked these
 * questions on the phone all day: when are you open, where are you, do you
 * deliver. Answering them here is not decoration — it is the page that stops the
 * kitchen's phone ringing during service.
 *
 * The facts — hours, address, how they serve — are generated from data the
 * restaurant has already entered, which is the only reason they will still be
 * accurate a year from now. Nobody maintains a page they have to remember to update.
 *
 * On top of that, and entirely optional, sits what only they can write: a headline,
 * their story, and their photos. That part is PLAIN TEXT rendered as text nodes —
 * see packages/shared/src/about.ts for why it is not, and must never become, HTML.
 */
export default async function AboutPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const restaurant = await storefrontApi.getRestaurant(slug, await previewTokenFor(slug));

  const headerList = await headers();
  const basePath = headerList.get('x-restaurant-slug') ? '' : `/s/${slug}`;
  const href = (path: string) => `${basePath}${path}`;

  // Locale, server-side: FR-only pins French, BOTH reads the cookie, else English.
  const canToggle = restaurant.menuLanguage === 'BOTH';
  const cookieLocale = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale: Locale =
    restaurant.menuLanguage === 'FR' ? 'fr' : canToggle ? toLocale(cookieLocale) : 'en';
  const t = getDictionary(locale);
  const dayLabel = (d: string) => t.about[d as keyof Dictionary['about']];

  const hours = restaurant.businessHours as BusinessHours;
  const today = WEEKDAYS[new Date().getDay()];

  /** Their words and their photos — in the customer's language, falling back. */
  const headline =
    (locale === 'fr' && restaurant.aboutHeadlineFr?.trim()) || restaurant.aboutHeadline?.trim();
  const bodyText =
    locale === 'fr' && restaurant.aboutBodyFr?.trim() ? restaurant.aboutBodyFr : restaurant.aboutBody;
  const story = aboutParagraphs(bodyText);
  const gallery = restaurant.galleryImages ?? [];

  const options = [
    restaurant.pickupEnabled && { icon: ShoppingBag, title: t.about.pickup, body: t.about.pickupBody },
    restaurant.deliveryEnabled && { icon: Truck, title: t.about.delivery, body: t.about.deliveryBody },
    restaurant.dineInEnabled && { icon: UtensilsCrossed, title: t.about.dineIn, body: t.about.dineInBody },
  ].filter(Boolean) as Array<{ icon: typeof Truck; title: string; body: string }>;

  return (
    <div className="animate-rise">
      {/* Header */}
      <section className="border-b bg-muted/30">
        <div className="mx-auto max-w-3xl px-5 py-16 sm:px-8 sm:py-20">
          <h1 className="font-display text-4xl font-semibold tracking-tight sm:text-5xl">
            {headline || `${t.about.aboutPrefix} ${restaurant.name}`}
          </h1>
          {restaurant.description && (
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted-foreground">
              {restaurant.description}
            </p>
          )}
        </div>
      </section>

      <div className="mx-auto max-w-3xl space-y-16 px-5 py-16 sm:px-8">
        {/*
          Their story, in their own words.

          Rendered as TEXT NODES. `aboutParagraphs` returns strings and this maps them
          into <p> children — there is no dangerouslySetInnerHTML here and there must
          never be one. A tenant who types a <script> tag gets a paragraph that
          visibly reads "<script>", which is exactly right.
        */}
        {story.length > 0 && (
          <section className="space-y-4">
            {story.map((paragraph, i) => (
              <p key={i} className="text-lg leading-relaxed text-foreground/90">
                {paragraph}
              </p>
            ))}
          </section>
        )}

        {/* Their photos. */}
        {gallery.length > 0 && (
          <section>
            <div className="grid gap-3 sm:grid-cols-2">
              {gallery.map((image) => (
                <figure key={image.id} className="overflow-hidden rounded-2xl border">
                  <Image
                    src={image.url}
                    alt={image.caption ?? ''}
                    width={600}
                    height={400}
                    className="h-56 w-full object-cover"
                  />
                  {image.caption && (
                    <figcaption className="px-4 py-3 text-sm text-muted-foreground">
                      {image.caption}
                    </figcaption>
                  )}
                </figure>
              ))}
            </div>
          </section>
        )}

        {/* Hours. The single most-asked question, answered first, with today
            highlighted — because "what are your hours" almost always means
            "are you open right now". */}
        <section>
          <h2 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight">
            <Clock className="h-5 w-5" />
            {t.about.openingHours}
          </h2>

          <p className="mt-2 text-sm text-muted-foreground">
            {isOpenAt(hours, restaurant.timezone) ? (
              <span className="inline-flex items-center gap-1.5 font-medium text-emerald-600">
                <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-emerald-600" />
                {t.about.openNow}
              </span>
            ) : (
              t.about.closedNow
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
                  <dt>
                    {dayLabel(day)}
                    {isToday && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        {t.about.today}
                      </span>
                    )}
                  </dt>
                  <dd className="tabular-nums text-muted-foreground">
                    {!dayHours || dayHours.closed || dayHours.windows.length === 0
                      ? t.about.closed
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
            <h2 className="text-2xl font-bold tracking-tight">{t.about.howToOrder}</h2>

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
            {t.about.findUs}
          </h2>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border p-6">
              <p className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
                {t.about.address}
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
                {t.about.getDirections}
                <ArrowRight className="h-3.5 w-3.5" />
              </a>
            </div>

            <div className="rounded-2xl border p-6">
              <p className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
                {t.about.getInTouch}
              </p>

              <a
                href={`tel:${restaurant.phone}`}
                className="mt-3 flex items-center gap-2.5 hover:underline"
              >
                <Phone className="h-4 w-4 text-muted-foreground" />
                {restaurant.phone}
              </a>

              <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
                {t.about.contactPitch}
              </p>
            </div>
          </div>
        </section>

        {/* The pitch, again. It belongs on the About page more than anywhere else:
            this is where someone lands when they're deciding whether to trust a
            restaurant's own site over the app they already have installed. */}
        <section className="rounded-2xl bg-muted/50 p-8 text-center sm:p-10">
          <p className="mx-auto max-w-lg text-lg font-medium leading-relaxed">
            {t.about.moneyPitch1}
          </p>
          <p className="mx-auto mt-2.5 max-w-md text-sm leading-relaxed text-muted-foreground">
            {t.about.moneyPitch2}
          </p>

          <Button asChild variant="brand" size="lg" className="mt-7 rounded-xl px-8">
            <Link href={href('/menu')}>
              {t.about.seeMenu}
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </section>
      </div>
    </div>
  );
}
