'use client';

import { createContext, useContext, useMemo, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { createDashboardApi, type DashboardApi, type RestaurantWithRole } from '@/lib/api';
import { ROLE_RANK, type StaffRole } from '@dinedirect/shared';

interface DashboardContextValue {
  api: DashboardApi;
  restaurant: RestaurantWithRole | null;
  restaurants: RestaurantWithRole[];
  isLoading: boolean;
  switchRestaurant: (id: string) => void;
  /** Hierarchical: can(MANAGER) is true for an OWNER. */
  can: (role: StaffRole) => boolean;
}

const DashboardContext = createContext<DashboardContextValue | null>(null);

export function useDashboard(): DashboardContextValue {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error('useDashboard must be used inside DashboardProvider');
  return ctx;
}

/** Convenience: the api client already bound to the active restaurant. */
export function useApi(): DashboardApi {
  return useDashboard().api;
}

function DashboardInner({ children }: { children: React.ReactNode }) {
  const { getToken } = useAuth();
  const [activeId, setActiveId] = useState<string | null>(null);

  // Unbound client: used only to discover which restaurants this user works at.
  const bootstrapApi = useMemo(() => createDashboardApi(getToken), [getToken]);

  const { data: restaurants = [], isLoading } = useQuery({
    queryKey: ['restaurants', 'mine'],
    queryFn: () => bootstrapApi.listMine(),
  });

  // Default to the first membership. A user at one restaurant — almost everyone —
  // never sees a switcher at all.
  const restaurant = restaurants.find((r) => r.id === activeId) ?? restaurants[0] ?? null;

  // Rebuilt when the active tenant changes, so every subsequent call carries the
  // right X-Restaurant-Id. The server still verifies membership — this header is
  // a selection, not an authorization.
  const api = useMemo(
    () => createDashboardApi(getToken, restaurant?.id),
    [getToken, restaurant?.id],
  );

  const value: DashboardContextValue = {
    api,
    restaurant,
    restaurants,
    isLoading,
    switchRestaurant: setActiveId,
    can: (role) => (restaurant ? ROLE_RANK[restaurant.role] >= ROLE_RANK[role] : false),
  };

  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
}

export function DashboardProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            // Refetching on focus is exactly right for a kitchen tablet that gets
            // picked up every few minutes — the board is current the moment a
            // human looks at it.
            refetchOnWindowFocus: true,
            retry: 1,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <DashboardInner>{children}</DashboardInner>
    </QueryClientProvider>
  );
}
