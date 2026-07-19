import Link from 'next/link';
import { ArrowRight, Clock, MapPin, Phone } from 'lucide-react';
import { WEEKDAYS, aboutParagraphs, isOpenAt, type BusinessHours } from '@dinedirect/shared';
import type { StorefrontRestaurant } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { getDictionary, type Dictionary, type Locale } from '@/lib/i18n/dictionaries';

/**
 * The "our story / hours / find us" band, shown on the main storefront page.
 *
 * This is the old standalone About page folded into the homepage: a restaurant's
 * site should not make someone click away to learn the story, the hours, or the
 * address. It deliberately does NOT repeat what the templates already render (the
 * photo gallery, the hero) — only the parts they lack: the written story, the full
 * weekly hours, and a contact block.
 *
 * Renders nothing at all when there's no story to tell and (by construction) always
 * has hours + address, so it never appears as an empty band.
 *
 * The story is PLAIN TEXT rendered as text nodes — never HTML. A tenant who types a
 * <script> tag gets a paragraph that visibly reads "<script>", which is correct.
 */
export function StoryBand({
  restaurant,
  locale,
  href,
}: {
  restaurant: StorefrontRestaurant;
  locale: Locale;
  href: (path: string) => string;
}) {
  const t = getDictionary(locale);
  const dayLabel = (d: string) => t.about[d as keyof Dictionary['about']];

  const headline =
    (locale === 'fr' && restaurant.aboutHeadlineFr?.trim()) || restaurant.aboutHeadline?.trim();
  const bodyText =
    locale === 'fr' && restaurant.aboutBodyFr?.trim() ? restaurant.aboutBodyFr : restaurant.aboutBody;
  const story = aboutParagraphs(bodyText);

  const hours = restaurant.businessHours as BusinessHours;
  const today = WEEKDAYS[new Date().getDay()];

  return (
    <section className="border-t border-border bg-muted/20">
      <div className="mx-auto max-w-3xl space-y-16 px-5 py-16 sm:px-8 sm:py-20">
        {/* Their story, in their own words — only when they wrote one. */}
        {story.length > 0 && (
          <div className="space-y-4">
            <h2 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
              {headline || `${t.about.aboutPrefix} ${restaurant.name}`}
            </h2>
            {story.map((paragraph, i) => (
              <p key={i} className="text-lg leading-relaxed text-foreground/90">
                {paragraph}
              </p>
            ))}
          </div>
        )}

        {/* Hours — the single most-asked question, with today highlighted. */}
        <div>
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

          <dl className="mt-6 divide-y rounded-2xl border bg-background">
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
        </div>

        {/* Find us. */}
        <div>
          <h2 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight">
            <MapPin className="h-5 w-5" />
            {t.about.findUs}
          </h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border bg-background p-6">
              <p className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
                {t.about.address}
              </p>
              <address className="mt-2 not-italic leading-relaxed">
                {restaurant.street}
                <br />
                {restaurant.city}, {restaurant.state} {restaurant.postalCode}
              </address>
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

            <div className="rounded-2xl border bg-background p-6">
              <p className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
                {t.about.getInTouch}
              </p>
              <a href={`tel:${restaurant.phone}`} className="mt-3 flex items-center gap-2.5 hover:underline">
                <Phone className="h-4 w-4 text-muted-foreground" />
                {restaurant.phone}
              </a>
              <Button asChild className="mt-5">
                <Link href={href('/menu')}>
                  {t.about.seeMenu}
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
