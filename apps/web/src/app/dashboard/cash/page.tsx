'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownCircle, ArrowUpCircle, Banknote, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { formatMoney } from '@dinedirect/shared';
import { useApi, useDashboard, useRequireRole } from '@/components/dashboard/dashboard-provider';
import { ApiRequestError, type CashSession } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label, Skeleton } from '@/components/ui/primitives';

const MOVEMENT_LABEL: Record<CashSession['movements'][number]['type'], string> = {
  SALE: 'Cash sale',
  REFUND: 'Refund',
  PAY_IN: 'Paid in',
  PAY_OUT: 'Paid out',
};

/** Parse a dollar string ("40", "40.50") into integer cents; NaN → null. */
function toCents(v: string): number | null {
  const n = parseFloat(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export default function CashDrawerPage() {
  useRequireRole('STAFF', '/dashboard');
  const api = useApi();
  const { restaurant } = useDashboard();
  const queryClient = useQueryClient();
  const currency = restaurant?.currency ?? 'USD';

  const { data: drawer, isLoading } = useQuery({
    queryKey: ['cash', 'current', restaurant?.id],
    queryFn: () => api.getCashDrawer(),
    enabled: Boolean(restaurant),
    refetchInterval: 30_000,
  });
  const { data: history } = useQuery({
    queryKey: ['cash', 'history', restaurant?.id],
    queryFn: () => api.getCashHistory(20),
    enabled: Boolean(restaurant),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['cash'] });
  };
  const onError = (err: unknown) =>
    toast.error(err instanceof ApiRequestError ? err.body.message : 'Something went wrong');

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Cash drawer</h1>
        <p className="text-sm text-muted-foreground">
          Open a till with a float, and every cash order this shift lands here. Close it by
          counting the drawer — we tell you if it&apos;s over or short.
        </p>
      </div>

      {isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : drawer ? (
        <OpenDrawer drawer={drawer} currency={currency} onDone={invalidate} onError={onError} api={api} />
      ) : (
        <OpenForm currency={currency} onDone={invalidate} onError={onError} api={api} />
      )}

      {/* Z-report history */}
      {history && history.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-widest text-muted-foreground">
            Past shifts
          </h2>
          <div className="space-y-2">
            {history.map((s) => (
              <div key={s.id} className="flex items-center justify-between rounded-xl border p-3 text-sm">
                <div>
                  <p className="font-medium">
                    {new Date(s.openedAt).toLocaleDateString()} ·{' '}
                    {new Date(s.openedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    {s.closedAt
                      ? `–${new Date(s.closedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                      : ''}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatMoney(s.salesCents, currency)} sales · closed by {s.closedByName ?? '—'}
                  </p>
                </div>
                <OverShort cents={s.overShortCents} currency={currency} />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function OverShort({ cents, currency }: { cents: number | null; currency: string }) {
  if (cents == null) return null;
  if (cents === 0) return <span className="text-sm font-semibold text-emerald-600">Balanced</span>;
  const over = cents > 0;
  return (
    <span className={`text-sm font-semibold ${over ? 'text-amber-600' : 'text-destructive'}`}>
      {over ? 'Over ' : 'Short '}
      {formatMoney(Math.abs(cents), currency)}
    </span>
  );
}

function OpenForm({
  currency,
  onDone,
  onError,
  api,
}: {
  currency: string;
  onDone: () => void;
  onError: (e: unknown) => void;
  api: ReturnType<typeof useApi>;
}) {
  const [float, setFloat] = useState('');
  const open = useMutation({
    mutationFn: () => {
      const cents = toCents(float || '0');
      if (cents == null) throw new ApiRequestError(400, { statusCode: 400, error: 'BadRequest', message: 'Enter a valid amount' });
      return api.openCashDrawer(cents);
    },
    onSuccess: () => {
      toast.success('Drawer opened');
      onDone();
    },
    onError,
  });

  return (
    <div className="rounded-2xl border p-6">
      <div className="mb-4 flex items-center gap-2">
        <Banknote className="h-5 w-5 text-muted-foreground" />
        <h2 className="font-semibold">Open the drawer</h2>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="float">Opening float ({currency})</Label>
          <Input
            id="float"
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            placeholder="e.g. 150.00"
            value={float}
            onChange={(e) => setFloat(e.target.value)}
          />
        </div>
        <Button size="lg" disabled={open.isPending} onClick={() => open.mutate()}>
          {open.isPending ? 'Opening…' : 'Open drawer'}
        </Button>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        The starting cash you put in the drawer. Cash tracking is optional — skip it and cash
        orders simply aren&apos;t reconciled here.
      </p>
    </div>
  );
}

function OpenDrawer({
  drawer,
  currency,
  onDone,
  onError,
  api,
}: {
  drawer: CashSession;
  currency: string;
  onDone: () => void;
  onError: (e: unknown) => void;
  api: ReturnType<typeof useApi>;
}) {
  // Never assume the nested relation is present — a drawer serialized without its
  // movements array (or an older/leaner API response) must render as "no movements yet",
  // not crash the whole page reading `.length` of undefined.
  const movements = drawer.movements ?? [];
  const [closing, setClosing] = useState(false);
  const [counted, setCounted] = useState('');
  const [moveType, setMoveType] = useState<'PAY_IN' | 'PAY_OUT' | null>(null);
  const [moveAmount, setMoveAmount] = useState('');
  const [moveReason, setMoveReason] = useState('');

  const movement = useMutation({
    mutationFn: () => {
      const cents = toCents(moveAmount);
      if (!cents) throw new ApiRequestError(400, { statusCode: 400, error: 'BadRequest', message: 'Enter a valid amount' });
      return api.addCashMovement({ type: moveType!, amountCents: cents, reason: moveReason.trim() || undefined });
    },
    onSuccess: () => {
      setMoveType(null);
      setMoveAmount('');
      setMoveReason('');
      onDone();
    },
    onError,
  });

  const close = useMutation({
    mutationFn: () => {
      const cents = toCents(counted);
      if (cents == null) throw new ApiRequestError(400, { statusCode: 400, error: 'BadRequest', message: 'Enter the counted amount' });
      return api.closeCashDrawer(cents);
    },
    onSuccess: (s) => {
      toast.success(
        s.overShortCents === 0
          ? 'Drawer closed — balanced.'
          : `Drawer closed — ${s.overShortCents! > 0 ? 'over' : 'short'} ${formatMoney(Math.abs(s.overShortCents ?? 0), currency)}.`,
      );
      setClosing(false);
      onDone();
    },
    onError,
  });

  const countedCents = toCents(counted);
  const previewOverShort =
    countedCents != null ? countedCents - drawer.expectedCashCents : null;

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="rounded-2xl border p-5">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
            <h2 className="font-semibold">Drawer open</h2>
          </div>
          <span className="text-xs text-muted-foreground">
            by {drawer.openedByName} ·{' '}
            {new Date(drawer.openedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3">
          <Stat label="Opening float" cents={drawer.openingFloatCents} currency={currency} />
          <Stat label="Cash sales" cents={drawer.salesCents} currency={currency} />
          <Stat label="Paid in" cents={drawer.payInsCents} currency={currency} />
          <Stat label="Refunds" cents={-drawer.refundsCents} currency={currency} />
          <Stat label="Paid out" cents={-drawer.payOutsCents} currency={currency} />
          <Stat label="Expected in drawer" cents={drawer.expectedCashCents} currency={currency} bold />
        </dl>

        {!closing && !moveType && (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setMoveType('PAY_IN')}>
              <ArrowDownCircle className="h-4 w-4" /> Pay in
            </Button>
            <Button size="sm" variant="outline" onClick={() => setMoveType('PAY_OUT')}>
              <ArrowUpCircle className="h-4 w-4" /> Pay out
            </Button>
            <Button size="sm" variant="brand" className="ml-auto" onClick={() => setClosing(true)}>
              <Lock className="h-4 w-4" /> Close drawer
            </Button>
          </div>
        )}

        {/* Pay in / out form */}
        {moveType && (
          <div className="mt-4 space-y-2 rounded-xl border bg-muted/30 p-3">
            <p className="text-sm font-medium">{moveType === 'PAY_IN' ? 'Paid into' : 'Paid out of'} the drawer</p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex-1 space-y-1">
                <Label className="text-xs">Amount ({currency})</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  value={moveAmount}
                  onChange={(e) => setMoveAmount(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="flex-[2] space-y-1">
                <Label className="text-xs">Reason (optional)</Label>
                <Input
                  value={moveReason}
                  onChange={(e) => setMoveReason(e.target.value)}
                  placeholder={moveType === 'PAY_IN' ? 'Extra change' : 'Paid supplier / tip-out'}
                />
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" disabled={movement.isPending} onClick={() => movement.mutate()}>
                {movement.isPending ? 'Saving…' : 'Save'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMoveType(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* Close form */}
        {closing && (
          <div className="mt-4 space-y-2 rounded-xl border bg-muted/30 p-3">
            <p className="text-sm font-medium">Count the drawer and close</p>
            <div className="space-y-1">
              <Label className="text-xs">Counted cash ({currency})</Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                inputMode="decimal"
                value={counted}
                onChange={(e) => setCounted(e.target.value)}
                placeholder={(drawer.expectedCashCents / 100).toFixed(2)}
                autoFocus
              />
            </div>
            {previewOverShort != null && (
              <p className="text-sm">
                Expected {formatMoney(drawer.expectedCashCents, currency)} ·{' '}
                <span
                  className={
                    previewOverShort === 0
                      ? 'font-semibold text-emerald-600'
                      : previewOverShort > 0
                        ? 'font-semibold text-amber-600'
                        : 'font-semibold text-destructive'
                  }
                >
                  {previewOverShort === 0
                    ? 'balanced'
                    : `${previewOverShort > 0 ? 'over' : 'short'} ${formatMoney(Math.abs(previewOverShort), currency)}`}
                </span>
              </p>
            )}
            <div className="flex gap-2">
              <Button size="sm" variant="brand" disabled={close.isPending} onClick={() => close.mutate()}>
                {close.isPending ? 'Closing…' : 'Close & record'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setClosing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Movements */}
      {movements.length > 0 && (
        <div className="rounded-2xl border">
          <p className="border-b px-4 py-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            This shift
          </p>
          <ul className="divide-y">
            {movements.map((m) => {
              const negative = m.type === 'REFUND' || m.type === 'PAY_OUT';
              return (
                <li key={m.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <div className="min-w-0">
                    <span className="font-medium">{MOVEMENT_LABEL[m.type]}</span>
                    {m.reason && <span className="text-muted-foreground"> · {m.reason}</span>}
                    <span className="block text-xs text-muted-foreground">
                      {m.createdByName} ·{' '}
                      {new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <span className={`shrink-0 tabular-nums font-semibold ${negative ? 'text-destructive' : ''}`}>
                    {negative ? '−' : '+'}
                    {formatMoney(m.amountCents, currency)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  cents,
  currency,
  bold,
}: {
  label: string;
  cents: number;
  currency: string;
  bold?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`tabular-nums ${bold ? 'text-base font-bold' : 'font-medium'}`}>
        {formatMoney(cents, currency)}
      </dd>
    </div>
  );
}
