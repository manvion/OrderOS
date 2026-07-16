'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useApi, useDashboard } from '@/components/dashboard/dashboard-provider';
import { ApiRequestError, type Shift } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Label } from '@/components/ui/primitives';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function startOfWeek(d: Date): Date {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = date.getDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day; // back up to Monday
  date.setDate(date.getDate() + diff);
  return date;
}

function toTimeInput(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function combine(date: Date, time: string): string {
  const [h, m] = time.split(':').map(Number);
  const combined = new Date(date);
  combined.setHours(h, m, 0, 0);
  return combined.toISOString();
}

export default function SchedulePage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { restaurant, can } = useDashboard();
  const isManager = can('MANAGER');

  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [staffFilter, setStaffFilter] = useState('');
  const [editing, setEditing] = useState<Shift | 'new' | null>(null);

  const weekEnd = useMemo(() => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + 7);
    return d;
  }, [weekStart]);

  const { data: staff } = useQuery({
    queryKey: ['staff', restaurant?.id],
    queryFn: () => api.listStaff(),
    enabled: Boolean(restaurant) && isManager,
  });

  const { data: shifts, isLoading } = useQuery({
    queryKey: ['shifts', restaurant?.id, weekStart.toISOString(), isManager ? staffFilter : 'self'],
    queryFn: () =>
      api.listShifts({
        from: weekStart.toISOString(),
        to: weekEnd.toISOString(),
        userId: isManager ? staffFilter || undefined : undefined,
      }),
    enabled: Boolean(restaurant),
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['shifts'] });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteShift(id),
    onSuccess: () => {
      invalidate();
      toast.success('Shift removed');
      setEditing(null);
    },
    onError: () => toast.error('Could not remove that shift'),
  });

  if (!restaurant) return null;

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  });

  const shiftsByDay = days.map((day) =>
    (shifts ?? []).filter((s) => new Date(s.startsAt).toDateString() === day.toDateString()),
  );

  const name = (s: Shift) => [s.user.firstName, s.user.lastName].filter(Boolean).join(' ') || s.user.email;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Schedule</h1>
          <p className="text-sm text-muted-foreground">
            {isManager ? "Who's working, and when." : 'Your upcoming shifts.'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={() => setWeekStart((d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - 7))}
            aria-label="Previous week"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="w-36 text-center text-sm font-medium">
            {weekStart.toLocaleDateString([], { month: 'short', day: 'numeric' })} –{' '}
            {days[6].toLocaleDateString([], { month: 'short', day: 'numeric' })}
          </span>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setWeekStart((d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7))}
            aria-label="Next week"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>

          {isManager && (
            <>
              <Select
                value={staffFilter}
                onChange={(e) => setStaffFilter(e.target.value)}
                className="h-9 w-40 text-sm"
              >
                <option value="">Everyone</option>
                {staff?.map((m) => (
                  <option key={m.id} value={m.id}>
                    {[m.firstName, m.lastName].filter(Boolean).join(' ') || m.email}
                  </option>
                ))}
              </Select>
              <Button size="sm" onClick={() => setEditing('new')}>
                <Plus className="h-4 w-4" />
                Add shift
              </Button>
            </>
          )}
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          {days.map((day, i) => (
            <div key={day.toISOString()} className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {DAY_LABELS[i]} {day.getDate()}
              </p>
              <div className="space-y-2">
                {shiftsByDay[i].length === 0 ? (
                  <p className="text-xs text-muted-foreground/60">—</p>
                ) : (
                  shiftsByDay[i].map((s) => (
                    <Card
                      key={s.id}
                      className={isManager ? 'cursor-pointer transition hover:border-brand' : ''}
                      onClick={() => isManager && setEditing(s)}
                    >
                      <CardContent className="p-3">
                        {isManager && <p className="truncate text-sm font-medium">{name(s)}</p>}
                        <p className="text-xs text-muted-foreground">
                          {toTimeInput(s.startsAt)}–{toTimeInput(s.endsAt)}
                        </p>
                        {s.note && <p className="mt-1 truncate text-xs text-muted-foreground">{s.note}</p>}
                      </CardContent>
                    </Card>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && staff && (
        <ShiftEditor
          shift={editing === 'new' ? null : editing}
          staff={staff}
          defaultDate={weekStart}
          onClose={() => setEditing(null)}
          onSaved={() => {
            invalidate();
            setEditing(null);
          }}
          onDelete={editing !== 'new' ? () => remove.mutate(editing.id) : undefined}
          deleting={remove.isPending}
        />
      )}
    </div>
  );
}

function ShiftEditor({
  shift,
  staff,
  defaultDate,
  onClose,
  onSaved,
  onDelete,
  deleting,
}: {
  shift: Shift | null;
  staff: Array<{ id: string; firstName: string | null; lastName: string | null; email: string }>;
  defaultDate: Date;
  onClose: () => void;
  onSaved: () => void;
  onDelete?: () => void;
  deleting?: boolean;
}) {
  const api = useApi();
  const isNew = shift === null;

  const [userId, setUserId] = useState(shift?.userId ?? staff[0]?.id ?? '');
  const [date, setDate] = useState(() => {
    const d = shift ? new Date(shift.startsAt) : defaultDate;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [startTime, setStartTime] = useState(shift ? toTimeInput(shift.startsAt) : '09:00');
  const [endTime, setEndTime] = useState(shift ? toTimeInput(shift.endsAt) : '17:00');
  const [note, setNote] = useState(shift?.note ?? '');

  const save = useMutation({
    mutationFn: () => {
      const day = new Date(`${date}T00:00:00`);
      const payload = {
        userId,
        startsAt: combine(day, startTime),
        endsAt: combine(day, endTime),
        note: note.trim() || undefined,
      };
      return isNew ? api.createShift(payload) : api.updateShift(shift.id, payload);
    },
    onSuccess: () => {
      toast.success(isNew ? 'Shift added' : 'Shift updated');
      onSaved();
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not save that shift'),
  });

  const canSave = userId && date && startTime && endTime && endTime > startTime;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isNew ? 'Add a shift' : 'Edit shift'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="s-staff">Staff member</Label>
            <Select id="s-staff" value={userId} onChange={(e) => setUserId(e.target.value)}>
              {staff.map((m) => (
                <option key={m.id} value={m.id}>
                  {[m.firstName, m.lastName].filter(Boolean).join(' ') || m.email}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="s-date">Date</Label>
            <Input id="s-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="s-start">Starts</Label>
              <Input
                id="s-start"
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="s-end">Ends</Label>
              <Input id="s-end" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="s-note">Note (optional)</Label>
            <Input
              id="s-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Opening shift, covers close, etc."
            />
          </div>
        </div>

        <DialogFooter className="flex items-center justify-between sm:justify-between">
          {onDelete ? (
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={onDelete}
              disabled={deleting}
            >
              <Trash2 className="h-4 w-4" />
              {deleting ? 'Removing…' : 'Remove'}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button onClick={() => save.mutate()} disabled={!canSave || save.isPending}>
              {save.isPending ? 'Saving…' : isNew ? 'Add shift' : 'Save changes'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
