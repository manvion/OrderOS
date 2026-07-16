'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { UserButton } from '@clerk/nextjs';
import {
  BarChart3,
  CalendarDays,
  CreditCard,
  ExternalLink,
  Globe,
  ChefHat,
  History,
  Landmark,
  LayoutDashboard,
  Link2,
  Lock,
  QrCode,
  Receipt,
  Rocket,
  Settings,
  UserCog,
  UtensilsCrossed,
  Users,
} from 'lucide-react';
import type { PlanCapability } from '@dinedirect/shared';
import { useDashboard } from './dashboard-provider';
import { Skeleton, Badge } from '@/components/ui/primitives';
import { Select } from '@/components/ui/input';
import { tenantUrl } from '@/lib/tenant-url';

/**
 * `minRole` is the same hierarchy the API already enforces on writes --
 * mirrored here so the nav a role SEES matches what it can actually reach.
 * Kitchen, Orders and Schedule are the only screens a plain STAFF login
 * (kitchen, front-desk, order-flow display) ever needs; everything else is
 * business admin that only MANAGER/OWNER should see exists at all.
 */
interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  exact?: boolean;
  minRole: 'STAFF' | 'MANAGER' | 'OWNER';
  /** When set and the plan lacks it, the item shows a lock — it's an upsell, not a hidden door. */
  capability?: PlanCapability;
}

const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard, exact: true, minRole: 'MANAGER' },
  { href: '/dashboard/setup', label: 'Get set up', icon: Rocket, minRole: 'MANAGER' },
  // The screen staff actually live in, on a tablet by the pass. High in the list
  // because during service it is the only one that matters.
  { href: '/dashboard/kitchen', label: 'Kitchen', icon: ChefHat, minRole: 'STAFF' },
  { href: '/dashboard/orders', label: 'Orders', icon: Receipt, minRole: 'STAFF' },
  {
    href: '/dashboard/order-history',
    label: 'Order history',
    icon: History,
    minRole: 'STAFF',
    capability: 'FULL_ANALYTICS',
  },
  // Staff see only their own shifts here; a manager sees and edits everyone's.
  {
    href: '/dashboard/schedule',
    label: 'Schedule',
    icon: CalendarDays,
    minRole: 'STAFF',
    capability: 'SHIFTS',
  },
  { href: '/dashboard/menu', label: 'Menu', icon: UtensilsCrossed, minRole: 'MANAGER' },
  { href: '/dashboard/customers', label: 'Customers', icon: Users, minRole: 'MANAGER' },
  { href: '/dashboard/staff', label: 'Team', icon: UserCog, minRole: 'MANAGER' },
  {
    href: '/dashboard/analytics',
    label: 'Analytics',
    icon: BarChart3,
    minRole: 'MANAGER',
    capability: 'FULL_ANALYTICS',
  },
  {
    href: '/dashboard/tax-reports',
    label: 'Tax reports',
    icon: Landmark,
    minRole: 'MANAGER',
    capability: 'TAX_REPORTS',
  },
  { href: '/dashboard/qr', label: 'QR codes', icon: QrCode, minRole: 'MANAGER' },
  {
    href: '/dashboard/website',
    label: 'My website',
    icon: Globe,
    minRole: 'MANAGER',
    capability: 'WEBSITE_STOREFRONT',
  },
  {
    href: '/dashboard/domain',
    label: 'Domain',
    icon: Link2,
    minRole: 'OWNER',
    capability: 'CUSTOM_DOMAIN',
  },
  { href: '/dashboard/billing', label: 'Billing', icon: CreditCard, minRole: 'OWNER' },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings, minRole: 'OWNER' },
];

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const { restaurant, restaurants, isLoading, loadError, switchRestaurant, can, hasFeature } =
    useDashboard();
  const visibleNav = NAV.filter((n) => can(n.minRole));
  const pathname = usePathname();
  const router = useRouter();

  // Signed in but not staff anywhere: they've never created a restaurant. Send
  // them to onboarding rather than showing an empty dashboard.
  //
  // ONLY on a clean, successful empty result — NOT when the lookup errored. An
  // errored "which restaurants am I staff at?" call used to look identical to "you
  // have none", so a 500 (e.g. an API whose subscription migration isn't applied)
  // teleported an owner — or a platform admin who just opened a support session —
  // straight into the create-a-restaurant wizard. That's the wrong door.
  useEffect(() => {
    if (!isLoading && !loadError && restaurants.length === 0) {
      router.replace('/onboarding');
    }
  }, [isLoading, loadError, restaurants.length, router]);

  if (loadError && !restaurant) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-md space-y-2 text-center">
          <p className="font-semibold">Couldn’t load your restaurants</p>
          <p className="text-sm text-muted-foreground">
            The API returned an error. If this started after a deploy, the database migration for
            subscription plans likely hasn’t been applied yet — run{' '}
            <code className="font-mono">npm run db:deploy</code> (or redeploy the API) and reload.
          </p>
          <button
            onClick={() => router.refresh()}
            className="mt-2 rounded-lg border px-4 py-2 text-sm font-medium hover:bg-accent"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (isLoading || !restaurant) {
    return (
      <div className="flex min-h-screen">
        <aside className="hidden w-64 border-r p-4 lg:block">
          <Skeleton className="h-10 w-full" />
          <div className="mt-6 space-y-2">
            {NAV.map((n) => (
              <Skeleton key={n.href} className="h-9 w-full" />
            ))}
          </div>
        </aside>
        <main className="flex-1 p-8">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="mt-6 h-64 w-full" />
        </main>
      </div>
    );
  }

  // tenantUrl is regime-aware: subdomain when a real apex is configured,
  // <origin>/s/<slug> otherwise — the only form that resolves on a Vercel
  // deployment (and on Windows dev, where *.localhost doesn't resolve at all).
  const storefrontUrl = tenantUrl(restaurant.slug);

  return (
    <div className="flex min-h-screen bg-muted/30">
      <aside className="hidden w-64 shrink-0 flex-col border-r bg-background shadow-soft lg:flex">
        <div className="border-b p-4">
          <Link href="/dashboard" className="text-lg font-bold tracking-tight">
            DineDirect
          </Link>
        </div>

        <div className="space-y-3 border-b p-4">
          {/* Only render the switcher for people who actually work at more than one
              restaurant. For everyone else it's noise. */}
          {restaurants.length > 1 ? (
            <Select
              value={restaurant.id}
              onChange={(e) => switchRestaurant(e.target.value)}
              className="h-9 text-sm"
            >
              {restaurants.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          ) : (
            <p className="truncate text-sm font-medium">{restaurant.name}</p>
          )}

          <div className="flex items-center gap-2">
            <Badge variant={restaurant.isPublished ? 'success' : 'warning'} className="text-[10px]">
              {restaurant.isPublished ? 'Live' : 'Draft'}
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              {restaurant.role.toLowerCase()}
            </Badge>
          </div>

          {restaurant.isPublished && (
            <a
              href={storefrontUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              View storefront
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>

        <nav className="flex-1 space-y-1 p-3">
          {visibleNav.map(({ href, label, icon: Icon, exact, capability }) => {
            const active = exact ? pathname === href : pathname.startsWith(href);
            const locked = capability ? !hasFeature(capability) : false;
            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  active
                    ? 'bg-brand text-brand-foreground shadow-soft'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                }`}
              >
                <Icon className="h-4 w-4" />
                <span className="flex-1">{label}</span>
                {locked && <Lock className="h-3 w-3 opacity-60" aria-label="Upgrade to unlock" />}
              </Link>
            );
          })}
        </nav>

        <div className="border-t p-4">
          <UserButton showName />
        </div>
      </aside>

      <div className="flex-1">
        {/* Mobile nav. Kitchen staff run this on a phone as often as a tablet. */}
        <header className="flex items-center justify-between border-b bg-background p-4 lg:hidden">
          <span className="font-bold">DineDirect</span>
          <UserButton />
        </header>
        <nav className="no-scrollbar flex gap-1 overflow-x-auto border-b bg-background p-2 lg:hidden">
          {visibleNav.map(({ href, label, icon: Icon, exact }) => {
            const active = exact ? pathname === href : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium ${
                  active ? 'bg-brand text-brand-foreground' : 'text-muted-foreground'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </Link>
            );
          })}
        </nav>

        <main className="p-4 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
