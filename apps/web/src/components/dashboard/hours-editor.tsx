'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy, Plus, Trash2 } from 'lucide-react';
import {
  DEFAULT_BUSINESS_HOURS,
  WEEKDAYS,
  type BusinessHours,
  type Weekday,
} from '@dinedirect/shared';
import { toast } from 'sonner';
import { useApi } from './dashboard-provider';
import { ApiRequestError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/primitives';

/**
 * Opening hours.
 *
 * This is load-bearing, not cosmetic: `isOpenAt()` gates whether the storefront
 * will accept an ASAP order at all. Until this editor existed, every restaurant on
 * the platform was silently stuck on the seeded default of 11:00–22:00, seven days
 * — so a restaurant closed on Mondays would happily take Monday orders it could
 * not cook.
 *
 * Supports split shifts (lunch 11–14, dinner 17–22) because that is how a huge
 * number of real restaurants actually operate, and overnight closes (17:00–02:00)
 * because bars exist.
 */
export function HoursEditor({
  initialHours,
  timezone,
}: {
  initialHours: BusinessHours;
  timezone: string;
}) {
  const api = useApi();
  const queryClient = useQueryClient();

  const [hours, setHours] = useState<BusinessHours>(() => normalise(initialHours));

  const save = useMutation({
    mutationFn: () => api.updateCurrent({ businessHours: hours }),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.success('Opening hours saved');
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not save hours'),
  });

  const setDay = (day: Weekday, patch: Partial<BusinessHours[Weekday]>) =>
    setHours((h) => ({ ...h, [day]: { ...h[day], ...patch } }));

  /** "Same as Monday" — the single most-wanted button on any hours form. */
  const copyToAll = (source: Weekday) => {
    const template = hours[source];
    setHours(
      WEEKDAYS.reduce(
        (acc, day) => ({
          ...acc,
          [day]: { closed: template.closed, windows: template.windows.map((w) => ({ ...w })) },
        }),
        {} as BusinessHours,
      ),
    );
    toast.success(`Copied ${source} to every day`);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Opening hours</CardTitle>
        <CardDescription>
          Customers can&apos;t place an ASAP order when you&apos;re closed. Times are in{' '}
          <strong>{timezone.replace(/_/g, ' ')}</strong>, your local time.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {WEEKDAYS.map((day) => {
          const dayHours = hours[day];

          return (
            <div key={day} className="rounded-lg border p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <Switch
                    checked={!dayHours.closed}
                    onCheckedChange={(open) =>
                      setDay(day, {
                        closed: !open,
                        // Re-opening a closed day with no windows would leave it
                        // open-but-never-open. Give them a sane default back.
                        windows: open && dayHours.windows.length === 0
                          ? [{ open: '11:00', close: '22:00' }]
                          : dayHours.windows,
                      })
                    }
                    aria-label={`${day} open`}
                  />
                  <span className="w-24 text-sm font-medium capitalize">{day}</span>
                </div>

                {dayHours.closed ? (
                  <span className="text-sm text-muted-foreground">Closed</span>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    {dayHours.windows.map((window, i) => (
                      <div key={i} className="flex items-center gap-1.5">
                        <Input
                          type="time"
                          value={window.open}
                          onChange={(e) => {
                            const windows = [...dayHours.windows];
                            windows[i] = { ...windows[i], open: e.target.value };
                            setDay(day, { windows });
                          }}
                          className="h-9 w-28"
                          aria-label={`${day} opening time`}
                        />
                        <span className="text-muted-foreground">–</span>
                        <Input
                          type="time"
                          value={window.close}
                          onChange={(e) => {
                            const windows = [...dayHours.windows];
                            windows[i] = { ...windows[i], close: e.target.value };
                            setDay(day, { windows });
                          }}
                          className="h-9 w-28"
                          aria-label={`${day} closing time`}
                        />

                        {dayHours.windows.length > 1 && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-destructive"
                            onClick={() =>
                              setDay(day, {
                                windows: dayHours.windows.filter((_, idx) => idx !== i),
                              })
                            }
                            aria-label="Remove this shift"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    ))}

                    {/* Split shifts: lunch and dinner with a gap. Capped at 3 by
                        the shared schema, which the API validates too. */}
                    {dayHours.windows.length < 3 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 text-xs"
                        onClick={() =>
                          setDay(day, {
                            windows: [...dayHours.windows, { open: '17:00', close: '22:00' }],
                          })
                        }
                      >
                        <Plus className="h-3 w-3" />
                        Split shift
                      </Button>
                    )}

                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground"
                      onClick={() => copyToAll(day)}
                      title={`Copy ${day} to every day`}
                      aria-label={`Copy ${day} to every day`}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </div>

              {/* Overnight windows are legal and common (a bar closing at 2am), but
                  they look like a typo. Say out loud that we understood. */}
              {!dayHours.closed &&
                dayHours.windows.some((w) => w.close <= w.open) && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Closes after midnight — orders stay open into the next morning.
                  </p>
                )}
            </div>
          );
        })}

        <div className="flex items-center gap-2">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save hours'}
          </Button>
          <Button
            variant="ghost"
            onClick={() => setHours(DEFAULT_BUSINESS_HOURS)}
            disabled={save.isPending}
          >
            Reset
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * A restaurant created before this editor existed may have hours JSON that is
 * missing days entirely. Fill the gaps rather than crashing on `hours[day].closed`.
 */
function normalise(input: BusinessHours | null | undefined): BusinessHours {
  if (!input) return DEFAULT_BUSINESS_HOURS;

  return WEEKDAYS.reduce((acc, day) => {
    const existing = input[day];
    acc[day] =
      existing && Array.isArray(existing.windows)
        ? existing
        : { closed: false, windows: [{ open: '11:00', close: '22:00' }] };
    return acc;
  }, {} as BusinessHours);
}
