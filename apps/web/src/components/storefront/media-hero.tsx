import Image from 'next/image';
import { ShoppingBag, Truck, UtensilsCrossed } from 'lucide-react';
import type { StorefrontRestaurant } from '@/lib/api';
import { nameWordmarkStyle } from '@/lib/name-style';
import { HeroSlideshow } from './hero-slideshow';
import { LogoMark } from './logo-mark';
import { OrderCta } from './order-cta';

/** The hero tagline's inline style. Defaults to translucent white over the media. */
function taglineStyle(r: StorefrontRestaurant): React.CSSProperties {
  const style = nameWordmarkStyle({
    nameFont: r.heroTaglineFont,
    nameColor: r.heroTaglineColor,
    nameTransform: 'NONE',
  });
  if (!r.heroTaglineColor) style.color = 'rgba(255,255,255,0.88)';
  return style;
}

/**
 * The immersive, media-first hero.
 *
 * This is the "modern site" look: a full-bleed background — a looping VIDEO when the
 * restaurant has one, otherwise their cover photo, otherwise a wash of their brand
 * colour — with the logo centered over it and the name, a line of copy and a single
 * clear "Order now" beneath. A dark scrim keeps the text readable over anything.
 *
 * Server-rendered: the <video> autoplays muted+looped with no client JS, so there's
 * no hydration cost and nothing to block the first paint.
 */
export function MediaHero({
  restaurant,
  href,
  /** How tall: 'full' fills the viewport (flagship), 'tall' is a shorter band. */
  height = 'full',
  children,
}: {
  restaurant: StorefrontRestaurant;
  href: (path: string) => string;
  height?: 'full' | 'tall';
  children?: React.ReactNode;
}) {
  const showLogo = restaurant.logoDisplayMode !== 'NAME_ONLY' && restaurant.logoUrl;
  const showName = restaurant.logoDisplayMode !== 'LOGO_ONLY' || !restaurant.logoUrl;
  const heightClass = height === 'full' ? 'min-h-[88vh]' : 'min-h-[68vh]';
  const gallery = restaurant.galleryImages?.map((g) => g.url) ?? [];
  const options = [
    restaurant.pickupEnabled && { icon: ShoppingBag, label: 'Pickup' },
    restaurant.deliveryEnabled && { icon: Truck, label: 'Delivery' },
    restaurant.dineInEnabled && { icon: UtensilsCrossed, label: 'Dine in' },
  ].filter(Boolean) as Array<{ icon: typeof ShoppingBag; label: string }>;

  return (
    <section
      className={`relative isolate flex ${heightClass} items-center justify-center overflow-hidden`}
    >
      {/* Background layer: video → gallery-as-video → cover photo → brand gradient. */}
      {restaurant.heroVideoUrl ? (
        <video
          className="absolute inset-0 h-full w-full object-cover"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          poster={restaurant.coverImageUrl ?? undefined}
        >
          <source src={restaurant.heroVideoUrl} />
        </video>
      ) : gallery.length >= 2 ? (
        // No video, but they have photos — play them as one, cross-fading.
        <HeroSlideshow images={gallery} alt={restaurant.name} />
      ) : restaurant.coverImageUrl || gallery.length === 1 ? (
        <Image
          src={restaurant.coverImageUrl ?? gallery[0]}
          alt={restaurant.name}
          fill
          priority
          className="object-cover"
        />
      ) : (
        <div
          className="absolute inset-0"
          style={{
            background: `radial-gradient(ellipse 100% 100% at 50% 0%, color-mix(in srgb, var(--brand) 55%, transparent), transparent 70%), #16161a`,
          }}
        />
      )}

      {/* Scrim — a top-to-bottom darkening so white type reads over any footage. */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            'linear-gradient(180deg, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0.25) 40%, rgba(0,0,0,0.65) 100%)',
        }}
      />

      {/* Content, centered. */}
      <div className="relative z-10 mx-auto flex max-w-3xl flex-col items-center px-5 py-24 text-center text-white">
        <span className="rise-1 inline-flex items-center gap-2 rounded-full border border-white/25 bg-white/10 px-3.5 py-1.5 text-xs font-semibold backdrop-blur-sm">
          <span
            className={`pulse-dot h-1.5 w-1.5 rounded-full ${
              restaurant.isOpen ? 'bg-emerald-300 text-emerald-300' : 'bg-white/70'
            }`}
          />
          {restaurant.isOpen ? 'Open now' : 'Closed'}
          {restaurant.isOpen && (
            <>
              <span className="text-white/40">·</span>
              ready in ~{restaurant.prepTimeMinutes} min
            </>
          )}
        </span>

        {showLogo && (
          <span className="rise-2 mt-8 inline-flex">
            <LogoMark
              url={restaurant.logoUrl!}
              name={restaurant.name}
              color={restaurant.heroLogoColor}
              maxHeight="160px"
              maxWidth="min(80vw, 460px)"
              className="drop-shadow-2xl"
            />
          </span>
        )}

        {showName && (
          <h1
            className="rise-2 mt-6 font-display text-5xl font-semibold leading-[1.02] tracking-tight drop-shadow-lg sm:text-6xl lg:text-7xl"
            style={nameWordmarkStyle({ ...restaurant, nameColor: null })}
          >
            {restaurant.name}
          </h1>
        )}

        {(restaurant.heroTagline?.trim() || restaurant.description) && (
          <p
            className="rise-3 mt-5 max-w-xl text-lg leading-relaxed drop-shadow"
            style={taglineStyle(restaurant)}
          >
            {restaurant.heroTagline?.trim() || restaurant.description}
          </p>
        )}

        <div className="rise-4 mt-9 flex flex-wrap items-center justify-center gap-3">
          <OrderCta
            label={restaurant.isOpen ? 'Order now' : 'View the menu'}
            className="group inline-flex items-center gap-2 rounded-full bg-white px-8 py-3.5 text-base font-bold text-black shadow-floating transition-colors hover:bg-white/90"
          />
        </div>

        {options.length > 0 && (
          <div className="rise-4 mt-7 flex flex-wrap items-center justify-center gap-2">
            {options.map(({ icon: Icon, label }) => (
              <span
                key={label}
                className="inline-flex items-center gap-1.5 rounded-full border border-white/25 bg-white/10 px-3 py-1.5 text-xs font-medium text-white/90 backdrop-blur-sm"
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </span>
            ))}
          </div>
        )}

        {children}

        {!restaurant.isOpen && restaurant.scheduledOrdersEnabled && (
          <p className="mt-5 text-sm text-white/75 drop-shadow">
            We&apos;re closed right now — but you can schedule an order for later.
          </p>
        )}
      </div>
    </section>
  );
}
