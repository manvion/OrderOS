import { ArrowRight } from 'lucide-react';
import { WEEKDAYS, isOpenAt, type BusinessHours } from '@dinedirect/shared';
import type { StorefrontRestaurant } from '@/lib/api';
import { SocialIcon } from '@/components/shared/social-icons';
import { getDictionary, type Dictionary, type Locale } from '@/lib/i18n/dictionaries';

/**
 * The storefront footer — the site's standing "info panel".
 *
 * Address, hours, phone and socials live HERE rather than in a big mid-page band,
 * because they're reference facts a customer wants from any page, not just the
 * homepage: a footer is exactly where people look for "when are you open / where
 * are you". The homepage keeps only the written story above this.
 */
export function SiteFooter({
  restaurant,
  locale,
}: {
  restaurant: StorefrontRestaurant;
  locale: Locale;
}) {
  const t = getDictionary(locale);
  const dayLabel = (d: string) => t.about[d as keyof Dictionary['about']];
  const hours = restaurant.businessHours as BusinessHours;
  const today = WEEKDAYS[new Date().getDay()];
  const open = isOpenAt(hours, restaurant.timezone);

  return (
    <footer className="border-t bg-muted/20">
      <div className="container grid gap-10 py-12 sm:grid-cols-2 lg:grid-cols-[1.2fr_1fr]">
        {/* Who + where + how to reach them. */}
        <div className="space-y-3 text-sm text-muted-foreground">
          <p className="font-display text-lg font-semibold text-foreground">{restaurant.name}</p>
          <address className="not-italic leading-relaxed">
            {restaurant.street}
            <br />
            {restaurant.city}, {restaurant.state} {restaurant.postalCode}
          </address>
          <p>
            <a href={`tel:${restaurant.phone}`} className="hover:underline">
              {restaurant.phone}
            </a>
          </p>
          <a
            href={`https://maps.google.com/?q=${encodeURIComponent(
              `${restaurant.name}, ${restaurant.street}, ${restaurant.city}`,
            )}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 font-medium text-brand hover:underline"
          >
            {t.about.getDirections}
            <ArrowRight className="h-3.5 w-3.5" />
          </a>

          {restaurant.socialLinks && restaurant.socialLinks.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 pt-2">
              {restaurant.socialLinks.map((link) => (
                <a
                  key={link.platform}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  aria-label={link.platform}
                  className="text-muted-foreground transition-colors hover:text-brand"
                >
                  <SocialIcon platform={link.platform} className="h-5 w-5" />
                </a>
              ))}
            </div>
          )}

          {!restaurant.removeBranding && (
            <p className="pt-3 text-xs">
              Powered by <span className="font-medium text-foreground">DineDirect</span> by Manvion
              <br />
              <a
                href="https://dinedirect.manvion.ca"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:underline"
              >
                dinedirect.manvion.ca
              </a>
            </p>
          )}
        </div>

        {/* Opening hours — today highlighted, because "what are your hours" almost
            always means "are you open right now". */}
        <div className="text-sm">
          <p className="flex items-center gap-2 font-semibold">
            {t.about.openingHours}
            <span
              className={`inline-flex items-center gap-1.5 text-xs font-medium ${
                open ? 'text-emerald-600' : 'text-muted-foreground'
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${open ? 'bg-emerald-600' : 'bg-muted-foreground/50'}`}
              />
              {open ? t.about.openNow : t.about.closedNow}
            </span>
          </p>
          <dl className="mt-3 space-y-1.5">
            {WEEKDAYS.map((day) => {
              const dayHours = hours?.[day];
              const isToday = day === today;
              return (
                <div
                  key={day}
                  className={`flex items-center justify-between gap-4 ${
                    isToday ? 'font-medium text-foreground' : 'text-muted-foreground'
                  }`}
                >
                  <dt>{dayLabel(day)}</dt>
                  <dd className="tabular-nums">
                    {!dayHours || dayHours.closed || dayHours.windows.length === 0
                      ? t.about.closed
                      : dayHours.windows.map((w) => `${w.open} – ${w.close}`).join(', ')}
                  </dd>
                </div>
              );
            })}
          </dl>
        </div>
      </div>
    </footer>
  );
}
