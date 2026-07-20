import Link from 'next/link';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ArrowRight, Clock, MapPin, Phone, ShoppingBag, Truck, UtensilsCrossed } from 'lucide-react';
import { storefrontApi, type StorefrontRestaurant } from '@/lib/api';
import { previewTokenFor } from '@/lib/preview-token';
import { Button } from '@/components/ui/button';
import { StoryBand } from '@/components/storefront/story-band';
import { MediaHero } from '@/components/storefront/media-hero';
import { LogoMark } from '@/components/storefront/logo-mark';
import { LOCALE_COOKIE, toLocale, type Locale } from '@/lib/i18n/dictionaries';

export const revalidate = 60;

/**
 * The restaurant's homepage.
 *
 * One job: get the customer to the menu. Everything here serves that — the hero is
 * big, the open/closed status is honest, and "Order now" is the ONLY primary action
 * on the page. A homepage that makes someone hunt for how to order is a homepage
 * that sends them back to the marketplace app they came from.
 *
 * Three genuinely different LAYOUTS live below (Classic/Bold/Minimal, chosen in
 * Settings -> Branding), not one template with swapped colours. Fetching and the
 * QR-only redirect happen once here; each template only renders.
 */
export default async function StorefrontHome({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const restaurant = await storefrontApi.getRestaurant(slug, await previewTokenFor(slug));

  /**
   * A QR-only restaurant has no website, on purpose — they never wanted one. The
   * customer is standing at a table holding a phone that just scanned a code, and a
   * hero image with an "Order now" button is one pointless tap between them and the
   * menu. Send them straight there.
   *
   * This is a redirect rather than a hidden page because the homepage would still
   * exist and still be linkable otherwise, which is precisely the half-finished site
   * they were promised they wouldn't get.
   */
  if (restaurant.orderingMode === 'QR_ONLY') {
    const base = (await headers()).get('x-restaurant-slug') ? '' : `/s/${slug}`;
    redirect(`${base}/menu`);
  }

  /**
   * Same rule as the layout: on a real subdomain the storefront IS the site root,
   * so links are plain `/menu`. Under `/s/<slug>` — the only form that works on
   * Windows — every link needs the prefix, or it lands on the platform root and
   * 404s. Which is exactly what happened to "Order now".
   *
   * `x-restaurant-slug` is set by the middleware only on a subdomain rewrite, which
   * makes it an exact signal for which of the two we're in.
   */
  const basePath = (await headers()).get('x-restaurant-slug') ? '' : `/s/${slug}`;
  const href = (path: string) => `${basePath}${path}`;

  // Locale, server-side: FR-only pins French, BOTH reads the cookie, else English.
  const canToggle = restaurant.menuLanguage === 'BOTH';
  const cookieLocale = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale: Locale =
    restaurant.menuLanguage === 'FR' ? 'fr' : canToggle ? toLocale(cookieLocale) : 'en';

  const template = (() => {
    switch (restaurant.websiteTemplate) {
      case 'RUSTIC':
        return <RusticHome restaurant={restaurant} href={href} />;
      case 'BUILDER':
        return <BuilderHome restaurant={restaurant} href={href} />;
      case 'BENTO':
        return <BentoHome restaurant={restaurant} href={href} />;
      case 'ELEGANT':
        return <ElegantHome restaurant={restaurant} href={href} />;
      case 'PUNCHY':
        return <PunchyHome restaurant={restaurant} href={href} />;
      // BOLD, MINIMAL and SIGNATURE were retired — with the shared media hero they
      // were indistinguishable from CLASSIC, so any restaurant still on them renders
      // CLASSIC rather than a missing template.
      case 'CLASSIC':
      default:
        return <ClassicHome restaurant={restaurant} href={href} />;
    }
  })();

  // The old standalone About page, folded into every template's homepage: the story,
  // the full weekly hours, and how to find them — the parts no template renders on
  // its own. See components/storefront/story-band.tsx.
  return (
    <>
      {template}
      <StoryBand restaurant={restaurant} locale={locale} />
    </>
  );
}

type TemplateProps = { restaurant: StorefrontRestaurant; href: (path: string) => string };

/**
 * Pick between a template's light and dark literal, based on the owner's
 * theme choice (Settings -> Branding), never the customer's system preference.
 * Only for templates that hardcode their own palette (Rustic, Bento, Elegant) --
 * everything else reads the shared bg-background/text-foreground tokens, which
 * flip automatically via the `.storefront-dark` class in globals.css.
 */
function tone<T>(mode: StorefrontRestaurant['themeMode'], light: T, dark: T): T {
  return mode === 'DARK' ? dark : light;
}

function fulfillmentOptions(restaurant: StorefrontRestaurant) {
  return [
    restaurant.pickupEnabled && { icon: ShoppingBag, label: 'Pickup' },
    restaurant.deliveryEnabled && { icon: Truck, label: 'Delivery' },
    restaurant.dineInEnabled && { icon: UtensilsCrossed, label: 'Dine in' },
  ].filter(Boolean) as Array<{ icon: typeof ShoppingBag; label: string }>;
}

/**
 * CLASSIC. Full-bleed cover photo hero, a gallery, a facts row, a closing pitch.
 * Editorial and photo-forward — the original, and still the right default for a
 * restaurant with (or planning to get) real photography.
 */
function ClassicHome({ restaurant, href }: TemplateProps) {
  return (
    <div className="animate-rise">
      {/* The hero already plays the gallery photos (as a video/slideshow), so there's
          no separate photo grid here — it would just show the same images twice. */}
      <MediaHero restaurant={restaurant} href={href} />
      <FactsRow restaurant={restaurant} />
      <ClosingPitch restaurant={restaurant} href={href} />
    </div>
  );
}

/**
 * RUSTIC. Warm cream palette, dark rounded "coupon card" hero, dashed borders
 * throughout. Artisanal and hand-made-feeling rather than corporate -- the
 * opposite instinct from BOLD's flat brand-colour confidence.
 */
function RusticHome({ restaurant, href }: TemplateProps) {
  const options = fulfillmentOptions(restaurant);
  const mode = restaurant.themeMode;
  const page = tone(mode, '#f6ecd9', '#1a140d');
  const bodyText = tone(mode, '#241a10', '#f3e6cc');
  const bodyTextMuted = tone(mode, 'rgba(36,26,16,0.65)', 'rgba(243,230,204,0.65)');
  const dashBorder = tone(mode, 'rgba(36,26,16,0.2)', 'rgba(243,230,204,0.22)');
  const dashCardBg = tone(mode, 'rgba(255,255,255,0.6)', 'rgba(255,255,255,0.07)');
  const labelColor = tone(mode, '#8a6f4d', '#c9a876');

  return (
    <div className="animate-rise" style={{ background: page }}>
      <MediaHero restaurant={restaurant} href={href} />

      <section className="mx-auto max-w-6xl px-5 py-14 sm:px-8">
        <div className="grid gap-5 sm:grid-cols-3">
          <RusticCard icon={MapPin} label="Find us" text={bodyText} label2={labelColor} border={dashBorder} bg={dashCardBg}>
            {restaurant.street}, {restaurant.city}
          </RusticCard>
          <RusticCard icon={Phone} label="Call us" text={bodyText} label2={labelColor} border={dashBorder} bg={dashCardBg}>
            <a href={`tel:${restaurant.phone}`} className="hover:underline">
              {restaurant.phone}
            </a>
          </RusticCard>
          <RusticCard icon={Clock} label="How long" text={bodyText} label2={labelColor} border={dashBorder} bg={dashCardBg}>
            About {restaurant.prepTimeMinutes} min
            {restaurant.deliveryEnabled && <> · delivery adds ~15</>}
          </RusticCard>
        </div>
      </section>

      <section className="px-5 py-16 sm:px-8">
        <div
          className="mx-auto max-w-4xl rounded-[2rem] border-2 border-dashed px-8 py-12 text-center"
          style={{ borderColor: dashBorder, background: dashCardBg }}
        >
          <p className="mx-auto max-w-lg font-display text-2xl font-semibold" style={{ color: bodyText }}>
            Hungry?
          </p>
          <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: bodyTextMuted }}>
            Order straight from {restaurant.name}.
          </p>
          <Button
            asChild
            size="lg"
            className="mt-7 rounded-full px-8"
            style={{ background: restaurant.brandPrimaryColor, color: '#fff' }}
          >
            <Link href={href('/menu')}>
              See the menu
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          {options.length > 0 && (
            <p className="mt-4 text-xs" style={{ color: bodyTextMuted }}>
              {options.map((o) => o.label).join(' · ')}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

function RusticCard({
  icon: Icon,
  label,
  text,
  label2,
  border,
  bg,
  children,
}: {
  icon: typeof MapPin;
  label: string;
  text: string;
  label2: string;
  border: string;
  bg: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border-2 border-dashed p-5" style={{ borderColor: border, background: bg }}>
      <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest" style={{ color: label2 }}>
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <p className="mt-2 text-sm font-medium" style={{ color: text }}>
        {children}
      </p>
    </div>
  );
}

/**
 * BUILDER. Bold black display type, a bright accent CTA with a prep-time
 * badge, and a floating status card -- the app-like, configurator-flavoured
 * choice. No photo dependency: the personality is in the type, not the plate.
 */
function BuilderHome({ restaurant, href }: TemplateProps) {
  return (
    <div className="animate-rise bg-background">
      <MediaHero restaurant={restaurant} href={href} />

      <FactsRow restaurant={restaurant} />
      <ClosingPitch restaurant={restaurant} href={href} />
    </div>
  );
}

/**
 * BENTO. Chunky rounded display type, bright colour-blocked cards in a bento
 * grid. Playful and confident -- built for a brand that wants energy, not
 * restraint.
 */
function BentoHome({ restaurant, href }: TemplateProps) {
  const mode = restaurant.themeMode;
  const page = tone(mode, '#faf6ec', '#141210');

  return (
    <div className="animate-rise" style={{ background: page }}>
      <MediaHero restaurant={restaurant} href={href} />

      <section className="mx-auto max-w-6xl px-5 py-14 sm:px-8">
        <div className="grid gap-5 sm:grid-cols-3">
          <BentoCard icon={MapPin} label="Find us" color={restaurant.brandPrimaryColor}>
            {restaurant.street}, {restaurant.city}
          </BentoCard>
          <BentoCard icon={Phone} label="Call us" color={restaurant.brandAccentColor}>
            <a href={`tel:${restaurant.phone}`} className="hover:underline">
              {restaurant.phone}
            </a>
          </BentoCard>
          <BentoCard icon={Clock} label="How long" color="#1c1c1c">
            About {restaurant.prepTimeMinutes} min
            {restaurant.deliveryEnabled && <> · delivery adds ~15</>}
          </BentoCard>
        </div>
      </section>

      <section className="px-5 pb-16 sm:px-8">
        <div
          className="mx-auto max-w-6xl rounded-[2rem] p-8 text-center sm:p-14"
          style={{ background: restaurant.brandAccentColor }}
        >
          <p className="mx-auto max-w-lg font-display text-2xl font-black uppercase leading-tight tracking-tight text-white">
            Hungry?
          </p>
          <p className="mx-auto mt-3 max-w-md text-sm text-white/80">
            Order straight from {restaurant.name}.
          </p>
          <Button
            asChild
            size="lg"
            className="mt-7 rounded-full bg-white px-8 font-bold text-black hover:bg-white/90"
          >
            <Link href={href('/menu')}>
              See the menu
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </section>
    </div>
  );
}

function BentoCard({
  icon: Icon,
  label,
  color,
  children,
}: {
  icon: typeof MapPin;
  label: string;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-3xl p-6 text-white" style={{ background: color }}>
      <div className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-white/70">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <p className="mt-2 text-base font-bold">{children}</p>
    </div>
  );
}

/**
 * ELEGANT. Cream-and-forest-green, serif display type, a dark angled band
 * behind the hero photo. Upscale and editorial -- the fine-dining choice.
 */
function ElegantHome({ restaurant, href }: TemplateProps) {
  const FOREST = '#1f3d2b';
  const mode = restaurant.themeMode;
  const page = tone(mode, '#f7f2e7', '#151310');
  const headline = tone(mode, '#2a2118', '#f2ead9');

  return (
    <div className="animate-rise" style={{ background: page }}>
      <MediaHero restaurant={restaurant} href={href} />

      <section className="mx-auto max-w-4xl px-5 py-16 sm:px-8">
        <dl className="grid gap-8 text-center sm:grid-cols-3">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-widest" style={{ color: FOREST }}>
              Find us
            </dt>
            <dd className="mt-2 font-display text-lg" style={{ color: headline }}>
              {restaurant.street}, {restaurant.city}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-widest" style={{ color: FOREST }}>
              Call us
            </dt>
            <dd className="mt-2 font-display text-lg" style={{ color: headline }}>
              <a href={`tel:${restaurant.phone}`} className="hover:underline">
                {restaurant.phone}
              </a>
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-widest" style={{ color: FOREST }}>
              How long
            </dt>
            <dd className="mt-2 font-display text-lg" style={{ color: headline }}>
              ~{restaurant.prepTimeMinutes} min
              {restaurant.deliveryEnabled && <> · +15 delivery</>}
            </dd>
          </div>
        </dl>
      </section>

      <section className="px-5 pb-20 sm:px-8">
        <div
          className="mx-auto max-w-4xl rounded-[2rem] border border-dotted border-white/25 px-8 py-14 text-center"
          style={{ background: FOREST }}
        >
          <p className="mx-auto max-w-lg font-display text-2xl italic text-white">
            Craving something delicious? Reserve your order and savor the experience.
          </p>
          <Button asChild size="lg" className="mt-7 rounded-full bg-white px-8 text-[#1f3d2b] hover:bg-white/90">
            <Link href={href('/menu')}>
              Explore the menu
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </section>
    </div>
  );
}

/**
 * PUNCHY. Dark charcoal + one bright accent colour, centered chunky
 * headline, a phone-framed product photo, pill-shaped stat badges and CTAs
 * everywhere. Confident comfort-food energy -- built for a place that wants
 * to feel like a favourite, not a fine-dining reservation.
 */
function PunchyHome({ restaurant, href }: TemplateProps) {
  const options = fulfillmentOptions(restaurant);

  return (
    <div className="animate-rise bg-background">
      <MediaHero restaurant={restaurant} href={href} />

      <section className="border-t px-5 py-16 sm:px-8">
        <div className="mx-auto max-w-3xl">
          <p
            className="text-xs font-bold uppercase tracking-widest"
            style={{ color: restaurant.brandPrimaryColor }}
          >
            Why order here
          </p>
          <h2 className="mt-2 font-display text-2xl font-bold text-foreground sm:text-3xl">
            Same food, same kitchen — none of it goes to a marketplace.
          </h2>

          <div className="mt-7 grid gap-3 sm:grid-cols-3">
            <PunchyFeature title="Freshly prepared">
              Every order made when you place it, not reheated from a warmer.
            </PunchyFeature>
            <PunchyFeature title="No commission">
              No 30% cut to an app — more of what you pay reaches the kitchen.
            </PunchyFeature>
            <PunchyFeature title={options.map((o) => o.label).join(' or ') || 'Order direct'}>
              About {restaurant.prepTimeMinutes} minutes
              {restaurant.deliveryEnabled && <>, delivery adds ~15</>}.
            </PunchyFeature>
          </div>
        </div>
      </section>

      <section className="px-5 pb-16 sm:px-8">
        <div
          className="mx-auto max-w-3xl rounded-[2rem] p-8 sm:p-12"
          style={{ background: restaurant.brandPrimaryColor }}
        >
          <p className="text-xs font-bold uppercase tracking-widest text-[#111]/60">Ready to eat?</p>
          <h2 className="mt-2 font-display text-3xl font-black leading-tight text-[#111] sm:text-4xl">
            Order while it&apos;s fresh and hot.
          </h2>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Button asChild size="lg" className="rounded-full bg-[#111] px-8 text-white hover:bg-[#111]/85">
              <Link href={href('/menu')}>
                Browse menu
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <a
              href={`tel:${restaurant.phone}`}
              className="inline-flex items-center justify-center gap-2 rounded-full border-2 border-[#111]/20 px-8 py-2.5 text-sm font-semibold text-[#111]"
            >
              <Phone className="h-4 w-4" />
              Call {restaurant.name}
            </a>
          </div>
          <p className="mt-4 text-xs text-[#111]/60">
            {restaurant.city} · {restaurant.street}
          </p>
        </div>
      </section>
    </div>
  );
}

function PunchyPill({
  accent,
  label,
  children,
}: {
  accent: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border bg-card px-4 py-2.5 text-left shadow-soft">
      <p className="text-xs font-bold" style={{ color: accent }}>
        {label}
      </p>
      <p className="text-xs text-muted-foreground">{children}</p>
    </div>
  );
}

function PunchyFeature({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border bg-card p-5 shadow-soft">
      <p className="text-sm font-bold text-foreground">{title}</p>
      <p className="mt-1.5 text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

/** Three facts, no chrome. Shared by CLASSIC and BOLD; MINIMAL has its own quieter version. */
function FactsRow({ restaurant }: { restaurant: StorefrontRestaurant }) {
  return (
    <section className="mx-auto max-w-5xl px-5 py-14 sm:px-8">
      <dl className="grid gap-8 sm:grid-cols-3">
        <Detail icon={MapPin} label="Find us">
          {restaurant.street}
          <br />
          {restaurant.city}, {restaurant.state} {restaurant.postalCode}
        </Detail>

        <Detail icon={Phone} label="Call us">
          <a href={`tel:${restaurant.phone}`} className="hover:underline">
            {restaurant.phone}
          </a>
        </Detail>

        <Detail icon={Clock} label="How long">
          About {restaurant.prepTimeMinutes} minutes
          {restaurant.deliveryEnabled && <> · delivery adds ~15</>}
        </Detail>
      </dl>
    </section>
  );
}

/**
 * A plain closing call-to-action. Shared by CLASSIC and BOLD.
 *
 * This is the restaurant's own storefront, so it stays about the restaurant — a
 * simple nudge to the menu, not a pitch for the platform underneath it.
 */
function ClosingPitch({ restaurant, href }: TemplateProps) {
  return (
    <section className="border-t bg-muted/40">
      <div className="mx-auto max-w-5xl px-5 py-14 text-center sm:px-8">
        <p className="mx-auto max-w-lg text-lg font-medium leading-relaxed">
          Ready when you are.
        </p>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          Order straight from {restaurant.name}.
        </p>
        <Button asChild variant="brand" size="lg" className="mt-7 rounded-xl px-8">
          <Link href={href('/menu')}>
            See the menu
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </div>
    </section>
  );
}

function Detail({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof MapPin;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </dt>
      <dd className="mt-2.5 text-sm leading-relaxed">{children}</dd>
    </div>
  );
}
