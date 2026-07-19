import { aboutParagraphs } from '@dinedirect/shared';
import type { StorefrontRestaurant } from '@/lib/api';
import { type Locale } from '@/lib/i18n/dictionaries';

/**
 * The restaurant's written story, shown on the homepage.
 *
 * This is the one part of the old About page that no template renders and the footer
 * has no room for: the headline and the paragraphs only the owner can write. Hours,
 * address and contact now live in the site footer instead.
 *
 * Renders NOTHING when there's no story — a restaurant that never wrote one gets the
 * template and the footer, with no empty band between them.
 *
 * PLAIN TEXT, rendered as text nodes — never HTML. A tenant who types a <script> tag
 * gets a paragraph that visibly reads "<script>", which is exactly right.
 */
export function StoryBand({
  restaurant,
  locale,
}: {
  restaurant: StorefrontRestaurant;
  locale: Locale;
}) {
  const headline =
    (locale === 'fr' && restaurant.aboutHeadlineFr?.trim()) || restaurant.aboutHeadline?.trim();
  const bodyText =
    locale === 'fr' && restaurant.aboutBodyFr?.trim() ? restaurant.aboutBodyFr : restaurant.aboutBody;
  const story = aboutParagraphs(bodyText);

  if (story.length === 0) return null;

  return (
    <section className="border-t border-border bg-muted/20">
      <div className="mx-auto max-w-3xl space-y-4 px-5 py-16 sm:px-8 sm:py-20">
        {headline && (
          <h2 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            {headline}
          </h2>
        )}
        {story.map((paragraph, i) => (
          <p key={i} className="text-lg leading-relaxed text-foreground/90">
            {paragraph}
          </p>
        ))}
      </div>
    </section>
  );
}
