'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { UserButton } from '@clerk/nextjs';
import {
  BarChart3,
  ExternalLink,
  Globe,
  ChefHat,
  LayoutDashboard,
  Link2,
  QrCode,
  Receipt,
  Rocket,
  Settings,
  UserCog,
  UtensilsCrossed,
  Users,
} from 'lucide-react';
import { useDashboard } from './dashboard-provider';
import { Skeleton, Badge } from '@/components/ui/primitives';
import { Select } from '@/components/ui/input';
import { tenantUrl } from '@/lib/tenant-url';

const NAV = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard, exact: true },
  { href: '/dashboard/setup', label: 'Get set up', icon: Rocket },
  // The screen staff actually live in, on a tablet by the pass. High in the list
  // because during service it is the only one that matters.
  { href: '/dashboard/kitchen', label: 'Kitchen', icon: ChefHat },
  { href: '/dashboard/orders', label: 'Orders', icon: Receipt },
  { href: '/dashboard/menu', label: 'Menu', icon: UtensilsCrossed },
  { href: '/dashboard/customers', label: 'Customers', icon: Users },
  { href: '/dashboard/staff', label: 'Team', icon: UserCog },
  { href: '/dashboard/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/dashboard/qr', label: 'QR codes', icon: QrCode },
  { href: '/dashboard/website', label: 'My website', icon: Globe },
  { href: '/dashboard/domain', label: 'Domain', icon: Link2 },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings },
];

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const { restaurant, restaurants, isLoading, switchRestaurant } = useDashboard();
  const pathname = usePathname();
  const router = useRouter();

  // Signed in but not staff anywhere: they've never created a restaurant. Send
  // them to onboarding rather than showing an empty dashboard.
  useEffect(() => {
    if (!isLoading && restaurants.length === 0) {
      router.replace('/onboarding');
    }
  }, [isLoading, restaurants.length, router]);

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
      <aside className="hidden w-64 shrink-0 flex-col border-r bg-background lg:flex">
        <div className="border-b p-4">
          <Link href="/dashboard" className="text-lg font-bold tracking-tight">
            OrderOS
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
          {NAV.map(({ href, label, icon: Icon, exact }) => {
            const active = exact ? pathname === href : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
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
          <span className="font-bold">OrderOS</span>
          <UserButton />
        </header>
        <nav className="no-scrollbar flex gap-1 overflow-x-auto border-b bg-background p-2 lg:hidden">
          {NAV.map(({ href, label, icon: Icon, exact }) => {
            const active = exact ? pathname === href : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium ${
                  active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
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
