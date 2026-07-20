'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Apple, Smartphone, ArrowRight } from 'lucide-react';
import { storefrontApi, type StorefrontRestaurant } from '@/lib/api';

/**
 * The staff-app install page — where a per-restaurant QR lands.
 *
 * A manager prints their restaurant's "payment app" QR (see StaffAccessQrs); staff scan
 * it and land here. We detect the phone and hand them the right install:
 *   - Android → download/install the app directly (or Play Store) from our cloud
 *   - iPhone  → the App Store (Apple gives no other route for a Tap-to-Pay app)
 *
 * The `?r=<slug>` param scopes it to a restaurant, purely for branding + a reminder of
 * which account to sign into — the app itself scopes by the signed-in staff member's
 * membership, so this link grants nothing on its own and is safe to print.
 */
const ANDROID_URL = process.env.NEXT_PUBLIC_STAFF_ANDROID_URL ?? '';
const IOS_URL = process.env.NEXT_PUBLIC_STAFF_IOS_URL ?? '';

type Platform = 'ios' | 'android' | 'other';

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other';
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  return 'other';
}

function GetAppInner() {
  const params = useSearchParams();
  const slug = params.get('r') ?? '';
  const [platform, setPlatform] = useState<Platform>('other');
  const [restaurant, setRestaurant] = useState<StorefrontRestaurant | null>(null);

  useEffect(() => setPlatform(detectPlatform()), []);

  // Branding only — a failure here just drops back to the generic look, never blocks.
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    storefrontApi
      .getRestaurant(slug)
      .then((r) => !cancelled && setRestaurant(r))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const androidReady = !!ANDROID_URL;
  const iosReady = !!IOS_URL;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-6 px-6 py-12 text-center">
      <div className="flex flex-col items-center gap-3">
        {restaurant?.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={restaurant.logoUrl} alt="" className="h-16 w-16 rounded-2xl object-cover" />
        ) : (
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-neutral-900 text-2xl font-bold text-white">
            {(restaurant?.name?.charAt(0) ?? 'D').toUpperCase()}
          </div>
        )}
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Staff payment app</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {restaurant?.name
              ? `Take in-person card payments for ${restaurant.name}.`
              : 'Take in-person card payments — Tap to Pay, no reader needed.'}
          </p>
        </div>
      </div>

      {/* Primary CTA for the detected device, with the other available underneath. */}
      <div className="w-full space-y-3">
        <PlatformButton
          platform="ios"
          highlighted={platform === 'ios'}
          url={IOS_URL}
          ready={iosReady}
        />
        <PlatformButton
          platform="android"
          highlighted={platform === 'android'}
          url={ANDROID_URL}
          ready={androidReady}
        />
      </div>

      <ol className="w-full space-y-2 rounded-2xl border p-4 text-left text-sm text-muted-foreground">
        <Step n={1}>Install the app for your phone above.</Step>
        <Step n={2}>Open it and sign in with your DineDirect staff account.</Step>
        <Step n={3}>Pick an unpaid order, and have the customer tap their card.</Step>
      </ol>

      <p className="text-xs text-muted-foreground">
        Signing in only works for staff of {restaurant?.name ?? 'this restaurant'}. Nothing here
        works without a staff login.
      </p>
    </main>
  );
}

function PlatformButton({
  platform,
  highlighted,
  url,
  ready,
}: {
  platform: 'ios' | 'android';
  highlighted: boolean;
  url: string;
  ready: boolean;
}) {
  const Icon = platform === 'ios' ? Apple : Smartphone;
  const label = platform === 'ios' ? 'Install for iPhone' : 'Install for Android';
  const sub = platform === 'ios' ? 'via the App Store' : 'direct download';

  const base =
    'flex w-full items-center gap-3 rounded-2xl border p-4 text-left transition';
  const cls = highlighted
    ? `${base} border-brand bg-brand text-brand-foreground shadow-soft`
    : `${base} hover:border-brand/40`;

  if (!ready) {
    return (
      <div className={`${base} cursor-not-allowed opacity-60`}>
        <Icon className="h-6 w-6 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{label}</p>
          <p className="text-xs opacity-80">Coming soon — ask your manager</p>
        </div>
      </div>
    );
  }

  return (
    <a href={url} className={cls}>
      <Icon className="h-6 w-6 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{label}</p>
        <p className="text-xs opacity-80">{sub}</p>
      </div>
      <ArrowRight className="h-5 w-5 shrink-0" />
    </a>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand text-[11px] font-bold text-brand-foreground">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}

export default function GetAppPage() {
  return (
    <Suspense fallback={null}>
      <GetAppInner />
    </Suspense>
  );
}
