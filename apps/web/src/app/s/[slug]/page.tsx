import Link from 'next/link';
import Image from 'next/image';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ArrowRight, Clock, MapPin, Phone, ShoppingBag, Truck, UtensilsCrossed } from 'lucide-react';
import { storefrontApi, type StorefrontRestaurant } from '@/lib/api';
import { previewTokenFor } from '@/lib/preview-token';
import { Button } from '@/components/ui/button';
import { Reveal } from '@/components/shared/reveal';

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

  switch (restaurant.websiteTemplate) {
    case 'BOLD':
      return <BoldHome restaurant={restaurant} href={href} />;
    case 'MINIMAL':
      return <MinimalHome restaurant={restaurant} href={href} />;
    case 'CLASSIC':
    default:
      return <ClassicHome restaurant={restaurant} href={href} />;
  }
}

type TemplateProps = { restaurant: StorefrontRestaurant; href: (path: string) => string };

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
 * The closing argument. Shared by CLASSIC and BOLD.
 *
 * This is the entire pitch of direct ordering, and it belongs in front of the
 * CUSTOMER, not just the restaurant. They are choosing to buy here instead of
 * on an app, and they deserve to know why that's worth doing.
 */
function ClosingPitch({ href }: TemplateProps) {
  return (
    <section className="border-t bg-muted/40">
      <div className="mx-auto max-w-5xl px-5 py-14 text-center sm:px-8">
        <p className="mx-auto max-w-lg text-lg font-medium leading-relaxed">
          Ordering here sends your money to the kitchen, not to a marketplace.
        </p>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          No 30% commission. Same food, same people — more of what you pay stays with them.
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
