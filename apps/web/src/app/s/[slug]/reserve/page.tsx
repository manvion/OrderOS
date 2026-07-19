'use client';

import { useQuery } from '@tanstack/react-query';
import { storefrontApi } from '@/lib/api';
import { useTenant, useTenantHref } from '@/components/storefront/tenant-provider';
import { ReserveForm } from '@/components/storefront/reserve-form';
import { Button } from '@/components/ui/button';

export default function StorefrontReservePage() {
  const restaurant = useTenant();
  const href = useTenantHref();

  const { data: settings, isLoading } = useQuery({
    queryKey: ['reservation-settings', restaurant.slug],
    queryFn: () => storefrontApi.getReservationSettings(restaurant.slug),
    enabled: restaurant.reservationsEnabled,
  });

  if (!restaurant.reservationsEnabled || (settings && !settings.enabled)) {
    return (
      <div className="mx-auto max-w-lg px-4 py-24 text-center">
        <p className="text-lg font-semibold">Reservations aren&apos;t available here</p>
        <Button asChild variant="outline" className="mt-4">
          <a href={href('/menu')}>Back to the menu</a>
        </Button>
      </div>
    );
  }

  if (isLoading || !settings) {
    return <div className="mx-auto max-w-2xl px-5 py-24 text-center text-muted-foreground">Loading…</div>;
  }

  return <ReserveForm settings={settings} />;
}
