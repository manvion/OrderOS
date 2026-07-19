'use client';

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, Phone, Users } from 'lucide-react';
import { toast } from 'sonner';
import { useApi, useDashboard, useRequireRole } from '@/components/dashboard/dashboard-provider';
import { type Reservation, type ReservationStatus } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge, Skeleton } from '@/components/ui/primitives';

const STATUS_LABEL: Record<ReservationStatus, string> = {
  CONFIRMED: 'Confirmed',
  SEATED: 'Seated',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'No-show',
};

const STATUS_VARIANT: Record<ReservationStatus, 'secondary' | 'info' | 'destructive'> = {
  CONFIRMED: 'info',
  SEATED: 'info',
  COMPLETED: 'secondary',
  CANCELLED: 'destructive',
  NO_SHOW: 'destructive',
};

export default function ReservationsPage() {
  useRequireRole('STAFF', '/dashboard');
  const api = useApi();
  const { restaurant } = useDashboard();
  const queryClient = useQueryClient();
  const tz = restaurant?.timezone;

  const { data: reservations, isLoading } = useQuery({
    queryKey: ['reservations', restaurant?.id],
    queryFn: () => api.listReservations(),
    enabled: Boolean(restaurant),
    refetchInterval: 60_000,
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: ReservationStatus }) =>
      api.setReservationStatus(id, status),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['reservations'] });
    },
    onError: () => toast.error('Could not update the reservation'),
  });

  // Group by calendar day, in the restaurant's timezone.
  const groups = useMemo(() => {
    const byDay = new Map<string, Reservation[]>();
    for (const r of reservations ?? []) {
      const day = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      }).format(new Date(r.reservedAt));
      const list = byDay.get(day) ?? [];
      list.push(r);
      byDay.set(day, list);
    }
    return [...byDay.entries()];
  }, [reservations, tz]);

  const time = (iso: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(iso));

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Reservations</h1>
        <p className="text-sm text-muted-foreground">
          Upcoming table bookings. Turn reservations on and set your capacity in Settings.
        </p>
      </div>

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : groups.length === 0 ? (
        <div className="rounded-2xl border border-dashed p-12 text-center">
          <CalendarCheck className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-3 font-medium">No upcoming reservations</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Bookings from your storefront will appear here.
          </p>
        </div>
      ) : (
        groups.map(([day, list]) => (
          <section key={day}>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-widest text-muted-foreground">
              {day}
            </h2>
            <div className="space-y-2">
              {list.map((r) => {
                const dimmed = r.status === 'CANCELLED' || r.status === 'NO_SHOW';
                return (
                  <div
                    key={r.id}
                    className={`rounded-xl border p-4 ${dimmed ? 'opacity-60' : ''}`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-lg font-semibold tabular-nums">
                            {time(r.reservedAt)}
                          </span>
                          <Badge variant={STATUS_VARIANT[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                          <span className="flex items-center gap-1.5">
                            <Users className="h-3.5 w-3.5" />
                            {r.partySize}
                          </span>
                          <span className="font-medium text-foreground">{r.customerName}</span>
                          <a href={`tel:${r.customerPhone}`} className="flex items-center gap-1.5 hover:underline">
                            <Phone className="h-3.5 w-3.5" />
                            {r.customerPhone}
                          </a>
                        </div>
                        {r.notes && (
                          <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">
                            {r.notes}
                          </p>
                        )}
                      </div>

                      <div className="flex shrink-0 flex-wrap gap-2">
                        {r.status === 'CONFIRMED' && (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={setStatus.isPending}
                              onClick={() => setStatus.mutate({ id: r.id, status: 'SEATED' })}
                            >
                              Seated
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={setStatus.isPending}
                              onClick={() => setStatus.mutate({ id: r.id, status: 'NO_SHOW' })}
                            >
                              No-show
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={setStatus.isPending}
                              onClick={() => setStatus.mutate({ id: r.id, status: 'CANCELLED' })}
                            >
                              Cancel
                            </Button>
                          </>
                        )}
                        {r.status === 'SEATED' && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={setStatus.isPending}
                            onClick={() => setStatus.mutate({ id: r.id, status: 'COMPLETED' })}
                          >
                            Done
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
