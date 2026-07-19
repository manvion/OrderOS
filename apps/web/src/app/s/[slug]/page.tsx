import Link from 'next/link';
import Image from 'next/image';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  ArrowRight,
  Clock,
  Flame,
  MapPin,
  Phone,
  ShoppingBag,
  Sparkles,
  Star,
  Truck,
  UtensilsCrossed,
} from 'lucide-react';
import { storefrontApi, type StorefrontRestaurant } from '@/lib/api';
import { previewTokenFor } from '@/lib/preview-token';
import { Button } from '@/components/ui/button';
import { Reveal } from '@/components/shared/reveal';
import { StoryBand } from '@/components/storefront/story-band';
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
      case 'BOLD':
        return <BoldHome restaurant={restaurant} href={href} />;
      case 'MINIMAL':
        return <MinimalHome restaurant={restaurant} href={href} />;
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
      <StoryBand restaurant={restaurant} locale={locale} href={href} />
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
  const options = fulfillmentOptions(restaurant);

  return (
    <div className="animate-rise">
      <section className="relative isolate overflow-hidden">
        {restaurant.coverImageUrl ? (
          <>
            <Image
              src={restaurant.coverImageUrl}
              alt=""
              fill
              priority
              sizes="100vw"
              className="kenburns -z-10 object-cover"
            />
            <div className="absolute inset-0 -z-10 bg-gradient-to-t from-black/85 via-black/55 to-black/30" />
          </>
        ) : (
          // No photo? Don't show a grey box. Wash the hero in the restaurant's own
          // colours — it reads as deliberate rather than as a missing asset, which
          // matters because most restaurants will never upload a cover image.
          <div
            className="absolute inset-0 -z-10"
            style={{
              background: `linear-gradient(140deg, ${restaurant.brandPrimaryColor} 0%, ${restaurant.brandAccentColor} 100%)`,
            }}
          />
        )}

        <div className="mx-auto max-w-5xl px-5 py-24 sm:px-8 sm:py-32">
          {/* Open/closed as a LIVE dot rather than a static badge. It says "right
              now", which is the only tense a hungry person cares about. */}
          <div className="rise-1 inline-flex items-center gap-2 rounded-full bg-white/10 px-3.5 py-1.5 text-xs font-medium text-white/95 ring-1 ring-white/20 backdrop-blur-sm">
            <span
              className={`pulse-dot h-1.5 w-1.5 rounded-full ${
                restaurant.isOpen ? 'bg-emerald-400 text-emerald-400' : 'bg-white/60'
              }`}
            />
            {restaurant.isOpen ? 'Open now' : 'Closed'}
            {restaurant.isOpen && (
              <>
                <span className="text-white/40">·</span>
                ready in ~{restaurant.prepTimeMinutes} min
              </>
            )}
          </div>

          <h1 className="rise-2 mt-6 max-w-2xl font-display text-5xl font-semibold leading-[1.02] tracking-tight text-white sm:text-7xl">
            {restaurant.name}
          </h1>

          {restaurant.description && (
            <p className="rise-3 mt-5 max-w-lg text-lg leading-relaxed text-white/80">
              {restaurant.description}
            </p>
          )}

          <div className="rise-4 mt-9 flex flex-wrap items-center gap-3">
            <Button
              asChild
              size="lg"
              className="rounded-xl bg-white px-8 text-base font-semibold text-black shadow-floating hover:bg-white/90"
            >
              <Link href={href('/menu')} className="group">
                {restaurant.isOpen ? 'Order now' : 'View the menu'}
                <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
              </Link>
            </Button>

            {options.map(({ icon: Icon, label }) => (
              <span
                key={label}
                className="inline-flex items-center gap-1.5 rounded-xl bg-white/10 px-3.5 py-2.5 text-sm font-medium text-white/90 ring-1 ring-white/20 backdrop-blur-sm"
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </span>
            ))}
          </div>

          {!restaurant.isOpen && restaurant.scheduledOrdersEnabled && (
            <p className="mt-5 text-sm text-white/70">
              We&apos;re closed right now — but you can schedule an order for later.
            </p>
          )}
        </div>
      </section>

      {/* The food, before the facts. Photos the owner uploaded in Settings ->
          Gallery become the homepage's centrepiece -- an empty gallery renders
          nothing at all, so the page never shows placeholder grey. */}
      {restaurant.galleryImages.length > 0 && (
        <section className="mx-auto max-w-6xl px-5 pt-14 sm:px-8">
          <Reveal>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
              {restaurant.galleryImages.slice(0, 6).map((image, i) => (
                <div
                  key={image.id}
                  className={`img-zoom relative rounded-2xl ${
                    i === 0 ? 'col-span-2 row-span-2 aspect-[4/3] sm:col-span-2' : 'aspect-square'
                  }`}
                >
                  <Image
                    src={image.url}
                    alt={image.caption ?? ''}
                    fill
                    sizes="(max-width: 640px) 50vw, 33vw"
                    className="rounded-2xl object-cover"
                  />
                  {image.caption && (
                    <span className="absolute bottom-2 left-2 rounded-lg bg-black/55 px-2.5 py-1 text-xs font-medium text-white backdrop-blur-sm">
                      {image.caption}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </Reveal>
        </section>
      )}

      <FactsRow restaurant={restaurant} />
      <ClosingPitch restaurant={restaurant} href={href} />
    </div>
  );
}

/**
 * BOLD. No photo dependency at all -- a solid brand-colour hero, big confident
 * type, menu-forward. Built for a QR scan that should land on "order now" in
 * under a second, not a magazine spread. Skips the gallery entirely, even if
 * one exists: this template's whole identity is "fast", not "photo-forward".
 */
function BoldHome({ restaurant, href }: TemplateProps) {
  const options = fulfillmentOptions(restaurant);

  return (
    <div className="animate-rise">
      <section
        className="relative isolate overflow-hidden"
        style={{ background: restaurant.brandPrimaryColor }}
      >
        <div
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{
            background: `radial-gradient(ellipse 800px 500px at 85% -10%, ${restaurant.brandAccentColor}, transparent 60%)`,
          }}
        />

        <div className="relative mx-auto max-w-4xl px-5 py-20 text-center sm:px-8 sm:py-28">
          <div className="rise-1 inline-flex items-center gap-2 rounded-full bg-white/15 px-3.5 py-1.5 text-xs font-semibold text-white ring-1 ring-white/25">
            <span
              className={`pulse-dot h-1.5 w-1.5 rounded-full ${
                restaurant.isOpen ? 'bg-emerald-300 text-emerald-300' : 'bg-white/70'
              }`}
            />
            {restaurant.isOpen ? 'Open now' : 'Closed'}
            {restaurant.isOpen && (
              <>
                <span className="text-white/50">·</span>
                ready in ~{restaurant.prepTimeMinutes} min
              </>
            )}
          </div>

          <h1 className="rise-2 mt-6 text-5xl font-black uppercase leading-[0.95] tracking-tight text-white sm:text-7xl">
            {restaurant.name}
          </h1>

          {restaurant.description && (
            <p className="rise-3 mx-auto mt-5 max-w-lg text-lg text-white/85">
              {restaurant.description}
            </p>
          )}

          <div className="rise-4 mt-9 flex flex-col items-center gap-4">
            <Button
              asChild
              size="lg"
              className="w-full max-w-xs rounded-xl bg-white px-8 text-base font-bold text-black shadow-floating hover:bg-white/90 sm:w-auto"
            >
              <Link href={href('/menu')} className="group">
                {restaurant.isOpen ? 'Order now' : 'View the menu'}
                <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
              </Link>
            </Button>

            {options.length > 0 && (
              <div className="flex flex-wrap items-center justify-center gap-2">
                {options.map(({ icon: Icon, label }) => (
                  <span
                    key={label}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-white/10 px-3 py-2 text-xs font-medium text-white/90 ring-1 ring-white/20"
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </span>
                ))}
              </div>
            )}
          </div>

          {!restaurant.isOpen && restaurant.scheduledOrdersEnabled && (
            <p className="mt-5 text-sm text-white/75">
              We&apos;re closed right now — but you can schedule an order for later.
            </p>
          )}
        </div>
      </section>

      <FactsRow restaurant={restaurant} />
      <ClosingPitch restaurant={restaurant} href={href} />
    </div>
  );
}

/**
 * MINIMAL. No photography anywhere -- the deliberate choice for a restaurant
 * with none yet, rather than CLASSIC's gradient-wash standing in for a photo it
 * doesn't have. Centered, generous whitespace, plain text facts. Quiet on
 * purpose: the menu button is the only thing asking for attention.
 */
function MinimalHome({ restaurant, href }: TemplateProps) {
  const options = fulfillmentOptions(restaurant);

  return (
    <div className="animate-rise">
      <section className="mx-auto max-w-2xl px-5 py-24 text-center sm:px-8 sm:py-32">
        <div className="rise-1 inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-medium text-muted-foreground">
          <span
            className={`h-1.5 w-1.5 rounded-full ${restaurant.isOpen ? 'bg-emerald-500' : 'bg-muted-foreground/50'}`}
          />
          {restaurant.isOpen ? 'Open now' : 'Closed'}
          {restaurant.isOpen && <>· ready in ~{restaurant.prepTimeMinutes} min</>}
        </div>

        <h1 className="rise-2 mt-6 font-display text-4xl font-semibold tracking-tight sm:text-5xl">
          {restaurant.name}
        </h1>

        {restaurant.description && (
          <p className="rise-3 mx-auto mt-4 max-w-md text-muted-foreground">
            {restaurant.description}
          </p>
        )}

        <div className="rise-4 mt-8 flex flex-col items-center gap-3">
          <Button asChild variant="brand" size="lg" className="rounded-xl px-8">
            <Link href={href('/menu')}>
              {restaurant.isOpen ? 'Order now' : 'View the menu'}
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>

          {options.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {options.map((o) => o.label).join(' · ')}
            </p>
          )}

          {!restaurant.isOpen && restaurant.scheduledOrdersEnabled && (
            <p className="text-sm text-muted-foreground">
              Closed right now — but you can schedule an order for later.
            </p>
          )}
        </div>
      </section>

      {/* Plain text, no icons, no cards -- the quietest version of the same facts
          every template shows. */}
      <section className="border-t">
        <div className="mx-auto max-w-2xl px-5 py-14 text-center text-sm text-muted-foreground sm:px-8">
          <p>
            {restaurant.street}, {restaurant.city}, {restaurant.state} {restaurant.postalCode}
          </p>
          <p className="mt-1.5">
            <a href={`tel:${restaurant.phone}`} className="hover:underline">
              {restaurant.phone}
            </a>
          </p>
          <p className="mt-1.5">
            About {restaurant.prepTimeMinutes} minutes
            {restaurant.deliveryEnabled && <> · delivery adds ~15</>}
          </p>
        </div>
      </section>
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
  const cardBg = tone(mode, '#241a10', '#f3e6cc');
  const cardText = tone(mode, '#ffffff', '#241a10');
  const cardTextMuted = tone(mode, 'rgba(255,255,255,0.7)', 'rgba(36,26,16,0.7)');
  const cardChipBg = tone(mode, 'rgba(255,255,255,0.1)', 'rgba(36,26,16,0.1)');
  const bodyText = tone(mode, '#241a10', '#f3e6cc');
  const bodyTextMuted = tone(mode, 'rgba(36,26,16,0.65)', 'rgba(243,230,204,0.65)');
  const dashBorder = tone(mode, 'rgba(36,26,16,0.2)', 'rgba(243,230,204,0.22)');
  const dashCardBg = tone(mode, 'rgba(255,255,255,0.6)', 'rgba(255,255,255,0.07)');
  const labelColor = tone(mode, '#8a6f4d', '#c9a876');

  return (
    <div className="animate-rise" style={{ background: page }}>
      <section className="mx-auto max-w-6xl px-5 pt-10 sm:px-8 sm:pt-14">
        <div
          className="grid gap-6 overflow-hidden rounded-[2rem] lg:grid-cols-2"
          style={{ background: cardBg }}
        >
          <div className="p-8 sm:p-12">
            <div
              className="rise-1 inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-medium"
              style={{ background: cardChipBg, color: cardText }}
            >
              <span
                className={`pulse-dot h-1.5 w-1.5 rounded-full ${restaurant.isOpen ? 'bg-emerald-400 text-emerald-400' : ''}`}
                style={!restaurant.isOpen ? { background: cardTextMuted } : undefined}
              />
              {restaurant.isOpen ? 'Open now' : 'Closed'}
            </div>

            <h1
              className="rise-2 mt-6 font-display text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl"
              style={{ color: cardText }}
            >
              {restaurant.name}
            </h1>

            {restaurant.description && (
              <p className="rise-3 mt-4 max-w-md" style={{ color: cardTextMuted }}>
                {restaurant.description}
              </p>
            )}

            <div className="rise-4 mt-8 flex flex-wrap items-center gap-3">
              <Button
                asChild
                size="lg"
                className="rounded-full px-7 shadow-floating"
                style={{ background: restaurant.brandPrimaryColor, color: '#fff' }}
              >
                <Link href={href('/menu')}>
                  {restaurant.isOpen ? 'Order online' : 'View the menu'}
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
              <a
                href={`tel:${restaurant.phone}`}
                className="inline-flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium"
                style={{ background: cardChipBg, color: cardText }}
              >
                <Phone className="h-3.5 w-3.5" />
                {restaurant.phone}
              </a>
            </div>

            <div className="mt-8 flex items-center gap-5 text-sm" style={{ color: cardTextMuted }}>
              <span className="inline-flex items-center gap-1.5">
                <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
                Fresh, made to order
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Flame className="h-4 w-4 text-orange-400" />
                Ready in ~{restaurant.prepTimeMinutes} min
              </span>
            </div>
          </div>

          <div className="relative min-h-[16rem]">
            {restaurant.coverImageUrl ? (
              <Image
                src={restaurant.coverImageUrl}
                alt=""
                fill
                sizes="(max-width: 1024px) 100vw, 50vw"
                className="object-cover"
              />
            ) : (
              <div
                className="absolute inset-0"
                style={{
                  background: `radial-gradient(120% 100% at 100% 0%, ${restaurant.brandAccentColor}, ${restaurant.brandPrimaryColor})`,
                }}
              />
            )}
          </div>
        </div>
      </section>

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

      {/* Real photos, when there are any -- a template built around "hand-made"
          rings hollow without evidence, and an empty gallery renders nothing. */}
      {restaurant.galleryImages.length > 0 && (
        <section className="mx-auto max-w-6xl px-5 pb-4 sm:px-8">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {restaurant.galleryImages.slice(0, 4).map((image) => (
              <div key={image.id} className="img-zoom relative aspect-square rounded-2xl">
                <Image
                  src={image.url}
                  alt={image.caption ?? ''}
                  fill
                  sizes="(max-width: 640px) 50vw, 25vw"
                  className="rounded-2xl object-cover"
                />
              </div>
            ))}
          </div>
        </section>
      )}

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
  const options = fulfillmentOptions(restaurant);

  return (
    <div className="animate-rise bg-background">
      <section className="mx-auto max-w-6xl px-5 pt-14 sm:px-8 sm:pt-20">
        <div className="grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-start">
          <div>
            <p className="rise-1 text-sm font-semibold text-muted-foreground">{restaurant.name}</p>
            <h1 className="rise-2 mt-2 font-display text-5xl font-black leading-[0.95] tracking-tight text-foreground sm:text-6xl">
              What are you craving today?
            </h1>

            {restaurant.description && (
              <p className="rise-3 mt-5 max-w-md text-lg text-muted-foreground">
                {restaurant.description}
              </p>
            )}

            <div className="rise-4 mt-8 flex flex-wrap items-center gap-3">
              {options.map(({ icon: Icon, label }) => (
                <span
                  key={label}
                  className="inline-flex items-center gap-1.5 rounded-full border-2 border-foreground/10 px-4 py-2 text-sm font-semibold"
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </span>
              ))}
            </div>

            <div className="rise-4 mt-8">
              <Button
                asChild
                size="lg"
                className="rounded-full px-8 text-base font-bold shadow-floating"
                style={{ background: restaurant.brandPrimaryColor, color: '#fff' }}
              >
                <Link href={href('/menu')} className="group">
                  {restaurant.isOpen ? 'Start your order' : 'View the menu'}
                  <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
                </Link>
              </Button>
            </div>
          </div>

          {/* The floating status card -- the configurator-panel energy of the
              reference, repurposed: instead of toppings, it shows the facts
              that actually matter before ordering. A cover photo, when there
              is one, sits right above it -- this template doesn't NEED a
              photo, but it shouldn't hide one either. */}
          <div className="rise-3 space-y-4">
            {restaurant.coverImageUrl && (
              <div className="relative aspect-[16/10] overflow-hidden rounded-3xl shadow-floating">
                <Image
                  src={restaurant.coverImageUrl}
                  alt=""
                  fill
                  sizes="(max-width: 1024px) 100vw, 40vw"
                  className="object-cover"
                />
              </div>
            )}
            <div className="rounded-3xl border bg-card p-6 shadow-floating">
              <div className="flex items-center justify-between">
                <p className="font-display text-lg font-semibold">Right now</p>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-bold ${
                    restaurant.isOpen ? 'bg-emerald-500/15 text-emerald-600' : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {restaurant.isOpen ? 'Open' : 'Closed'}
                </span>
              </div>
              <div className="mt-5 space-y-3 text-sm">
                <div className="flex items-center justify-between border-b pb-3">
                  <span className="text-muted-foreground">Ready in</span>
                  <span className="font-semibold tabular-nums">~{restaurant.prepTimeMinutes} min</span>
                </div>
                <div className="flex items-center justify-between border-b pb-3">
                  <span className="text-muted-foreground">Location</span>
                  <span className="font-medium">{restaurant.city}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Call</span>
                  <a href={`tel:${restaurant.phone}`} className="font-medium hover:underline">
                    {restaurant.phone}
                  </a>
                </div>
              </div>
              {!restaurant.isOpen && restaurant.scheduledOrdersEnabled && (
                <p className="mt-4 text-xs text-muted-foreground">
                  Closed now, but you can schedule an order for later.
                </p>
              )}
            </div>
          </div>
        </div>
      </section>

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
  const options = fulfillmentOptions(restaurant);
  const mode = restaurant.themeMode;
  const page = tone(mode, '#faf6ec', '#141210');

  return (
    <div className="animate-rise" style={{ background: page }}>
      <section className="mx-auto max-w-6xl px-5 pt-10 sm:px-8 sm:pt-14">
        <div className="grid gap-5 lg:grid-cols-3">
          <div
            className="relative overflow-hidden rounded-[2rem] p-8 sm:p-10 lg:col-span-2"
            style={{ background: restaurant.brandPrimaryColor }}
          >
            {/* A real photo, when there's one, reads better than a flat colour
                block -- a dark wash keeps the white type legible over it. */}
            {restaurant.coverImageUrl && (
              <>
                <Image
                  src={restaurant.coverImageUrl}
                  alt=""
                  fill
                  sizes="(max-width: 1024px) 100vw, 66vw"
                  className="object-cover"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/30 to-black/10" />
              </>
            )}
            <div
              className="pointer-events-none absolute inset-0 opacity-30"
              style={{
                background: `radial-gradient(ellipse 600px 400px at 90% 100%, ${restaurant.brandAccentColor}, transparent 70%)`,
              }}
            />
            <div className="relative">
              <div className="rise-1 inline-flex items-center gap-1.5 rounded-full bg-white/20 px-3 py-1 text-xs font-bold text-white">
                <Sparkles className="h-3 w-3" />
                {restaurant.isOpen ? 'Open now' : 'Closed'}
              </div>
              <h1 className="rise-2 mt-5 font-display text-5xl font-black uppercase leading-[0.9] tracking-tight text-white sm:text-6xl">
                {restaurant.name}
              </h1>
              {restaurant.description && (
                <p className="rise-3 mt-4 max-w-md text-white/85">{restaurant.description}</p>
              )}
              <Button
                asChild
                size="lg"
                className="rise-4 mt-7 rounded-full bg-white px-7 font-bold text-black hover:bg-white/90"
              >
                <Link href={href('/menu')}>
                  {restaurant.isOpen ? 'Order now' : 'View the menu'}
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>

          <div className="grid gap-5">
            <div className="rounded-[2rem] bg-[#1c1c1c] p-6 text-white">
              <p className="font-display text-2xl font-black uppercase tracking-tight">Ready in</p>
              <p className="mt-1 text-3xl font-black tabular-nums">~{restaurant.prepTimeMinutes}m</p>
            </div>
            <div
              className="rounded-[2rem] p-6 text-white"
              style={{ background: restaurant.brandAccentColor }}
            >
              <p className="font-display text-xl font-black uppercase tracking-tight">
                {options.map((o) => o.label).join(' + ') || 'Order direct'}
              </p>
              <p className="mt-1 text-sm text-white/85">No marketplace commission</p>
            </div>
          </div>
        </div>
      </section>

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
  const headlineMuted = tone(mode, 'rgba(42,33,24,0.7)', 'rgba(242,234,217,0.65)');
  const band = tone(mode, '#161310', FOREST);

  return (
    <div className="animate-rise" style={{ background: page }}>
      <section className="mx-auto max-w-4xl px-5 pt-16 text-center sm:px-8 sm:pt-24">
        <p className="rise-1 text-sm font-semibold uppercase tracking-[0.2em]" style={{ color: FOREST }}>
          {restaurant.isOpen ? 'Open now' : 'Currently closed'}
        </p>
        <h1
          className="rise-2 mt-4 font-display text-4xl font-medium italic leading-tight tracking-tight sm:text-6xl"
          style={{ color: headline }}
        >
          {restaurant.name}
        </h1>
        {restaurant.description && (
          <p className="rise-3 mx-auto mt-5 max-w-lg" style={{ color: headlineMuted }}>
            {restaurant.description}
          </p>
        )}
        <div className="rise-4 mt-8">
          <Button
            asChild
            size="lg"
            className="rounded-full px-8"
            style={{ background: FOREST, color: '#fff' }}
          >
            <Link href={href('/menu')}>
              {restaurant.isOpen ? 'Explore the menu' : 'View the menu'}
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </section>

      <section className="relative mx-auto mt-14 max-w-5xl px-5 sm:px-8">
        {/* The signature move: a dark band bleeding to both edges, the photo
            floating on top of it -- the paint-smear device from the reference,
            approximated without needing real illustration assets. */}
        <div
          className="absolute inset-x-0 top-1/2 h-2/3 -translate-y-1/2"
          style={{ background: band }}
          aria-hidden
        />
        <div className="relative aspect-[16/9] overflow-hidden rounded-[2rem] shadow-dramatic">
          {restaurant.coverImageUrl ? (
            <Image
              src={restaurant.coverImageUrl}
              alt=""
              fill
              sizes="(max-width: 1024px) 100vw, 1024px"
              className="object-cover"
            />
          ) : (
            <div
              className="absolute inset-0"
              style={{
                background: `linear-gradient(140deg, ${restaurant.brandPrimaryColor}, ${FOREST})`,
              }}
            />
          )}
        </div>
      </section>

      {/* A gallery, when there is one -- an upscale menu with real photography
          and no evidence of it is a missed pitch. */}
      {restaurant.galleryImages.length > 0 && (
        <section className="mx-auto max-w-5xl px-5 pt-14 sm:px-8">
          <div className="grid grid-cols-3 gap-4">
            {restaurant.galleryImages.slice(0, 3).map((image) => (
              <div key={image.id} className="img-zoom relative aspect-[4/5] rounded-2xl">
                <Image
                  src={image.url}
                  alt={image.caption ?? ''}
                  fill
                  sizes="(max-width: 640px) 33vw, 300px"
                  className="rounded-2xl object-cover"
                />
              </div>
            ))}
          </div>
        </section>
      )}

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
      <section className="relative isolate overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            background: `radial-gradient(ellipse 900px 500px at 50% 0%, ${restaurant.brandPrimaryColor}33, transparent 70%)`,
          }}
        />

        <div className="relative mx-auto max-w-2xl px-5 pt-16 text-center sm:px-8 sm:pt-20">
          <div
            className="rise-1 inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-bold uppercase tracking-wide"
            style={{ background: `${restaurant.brandPrimaryColor}22`, color: restaurant.brandPrimaryColor }}
          >
            {restaurant.city} · {options.map((o) => o.label).join(' & ') || 'Order direct'}
          </div>

          <h1 className="rise-2 mt-6 font-display text-4xl font-black leading-[1.05] tracking-tight text-foreground sm:text-6xl">
            {restaurant.name}
          </h1>

          {restaurant.description && (
            <p className="rise-3 mx-auto mt-5 max-w-lg text-muted-foreground">{restaurant.description}</p>
          )}

          <div className="rise-4 mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button
              asChild
              size="lg"
              className="rounded-full px-8 font-bold shadow-floating"
              style={{ background: restaurant.brandPrimaryColor, color: '#111' }}
            >
              <Link href={href('/menu')}>
                {restaurant.isOpen ? 'Start an order' : 'View the menu'}
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="rounded-full px-8">
              <Link href={href('/menu')}>View full menu</Link>
            </Button>
          </div>

          <div className="rise-4 mt-8 flex flex-wrap items-center justify-center gap-2.5">
            <PunchyPill accent={restaurant.brandPrimaryColor} label={restaurant.isOpen ? 'Open now' : 'Closed'}>
              {restaurant.isOpen ? `ready in ~${restaurant.prepTimeMinutes}m` : 'schedule ahead'}
            </PunchyPill>
            <PunchyPill accent={restaurant.brandPrimaryColor} label="Fresh">
              made to order
            </PunchyPill>
            <PunchyPill accent={restaurant.brandPrimaryColor} label="Direct">
              no marketplace cut
            </PunchyPill>
          </div>
        </div>

        {/* The phone-framed product shot -- the reference's signature move. A
            plain rectangle bezel reads as "device" without needing a real
            phone-mockup asset. 4:5 (not a literal 9:16 phone ratio) crops a
            normal landscape food photo far more gracefully -- a true phone
            ratio sliced most real photos in half. */}
        <div className="relative mx-auto mt-10 w-full max-w-[300px] px-5 pb-16 sm:px-8">
          {restaurant.coverImageUrl && (
            <span
              className="absolute -top-3 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-full px-3 py-1 text-xs font-bold text-[#111]"
              style={{ background: restaurant.brandPrimaryColor }}
            >
              Hot, fresh &amp; ready
            </span>
          )}
          <div className="rounded-[2rem] border-[10px] border-[#0c0b0a] bg-[#0c0b0a] shadow-dramatic">
            <div className="relative aspect-[4/5] overflow-hidden rounded-[1.4rem]">
              {restaurant.coverImageUrl ? (
                <Image
                  src={restaurant.coverImageUrl}
                  alt=""
                  fill
                  sizes="300px"
                  className="object-cover"
                />
              ) : (
                <div
                  className="absolute inset-0"
                  style={{
                    background: `linear-gradient(160deg, ${restaurant.brandPrimaryColor}, ${restaurant.brandAccentColor})`,
                  }}
                />
              )}
            </div>
          </div>
        </div>
      </section>

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
