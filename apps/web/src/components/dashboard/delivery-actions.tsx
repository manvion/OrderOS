'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bike, Check, ExternalLink, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { useApi, useDashboard } from './dashboard-provider';
import { ApiRequestError, type Order } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Everything that happens between "the food is ready" and "it left the building".
 *
 * Three jobs, in the order they occur at the pass:
 *
 *  1. WHO CARRIES IT — Uber, or our own driver. Only asked when the restaurant has
 *     both, because only then is there a real decision to make.
 *  2. WHO IS THIS GUY — the courier standing at the counter reads back a pickup
 *     code. If it doesn't match, the bag does not move.
 *  3. WHERE IS HE NOW — for a self-delivery, staff move the status by hand, because
 *     their own driver doesn't send us webhooks.
 */
export function DeliveryActions({ order }: { order: Order }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { restaurant } = useDashboard();

  const [driverName, setDriverName] = useState('');
  const [code, setCode] = useState('');
  const [showOverride, setShowOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['orders'] });

  const dispatchUber = useMutation({
    mutationFn: () => api.dispatchUber(order.id),
    onSuccess: () => {
      refresh();
      toast.success('Uber courier requested');
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not reach Uber'),
  });

  const selfDeliver = useMutation({
    mutationFn: () => api.selfDeliver(order.id, { name: driverName.trim() || undefined }),
    onSuccess: () => {
      refresh();
      toast.success('Assigned to your own driver');
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not assign'),
  });

  const selfStatus = useMutation({
    mutationFn: (status: 'OUT_FOR_DELIVERY' | 'DELIVERED') =>
      api.setSelfDeliveryStatus(order.id, status),
    onSuccess: (_r, status) => {
      refresh();
      toast.success(
        status === 'DELIVERED' ? 'Delivered — the customer has been thanked' : 'Marked on its way',
      );
    },
    onError: () => toast.error('Could not update the delivery'),
  });

  const handoff = useMutation({
    mutationFn: (override?: boolean) =>
      api.verifyHandoff(order.id, {
        code: code.trim() || undefined,
        override,
        overrideReason: override ? overrideReason.trim() || 'not given' : undefined,
      }),
    onSuccess: (result) => {
      refresh();
      setCode('');
      setShowOverride(false);
      toast.success(
        result.verified
          ? 'Code matched — bag handed over'
          : 'Handed over WITHOUT a matching code. This has been logged.',
      );
    },
    onError: (err) => {
      // A mismatch is the system working, not failing. Say so, loudly, and offer
      // the override rather than leaving staff stuck with a driver at the counter.
      toast.error(
        err instanceof ApiRequestError ? err.body.message : 'Could not verify the handoff',
        { duration: 8000 },
      );
      setShowOverride(true);
    },
  });

  const delivery = order.delivery;
  const bothOptions = restaurant?.uberDirectEnabled && restaurant?.selfDeliveryEnabled;

  // Nothing to do here unless the food is ready and it's going out for delivery.
  if (order.fulfillment !== 'DELIVERY') return null;
  if (!['READY', 'DRIVER_ASSIGNED', 'OUT_FOR_DELIVERY'].includes(order.status)) return null;

  /**
   * Step 1: nobody is carrying it yet.
   *
   * Show a button for every provider the restaurant actually has. The bug this
   * replaces: a restaurant with ONLY their own driver (no Uber) got no buttons at
   * all, because the code assumed "no choice to make" meant "the API already
   * dispatched" — which is only true when Uber is the one enabled option. They
   * were left with a ready order and no way to send it out.
   */
  if (!delivery) {
    const canUber = Boolean(restaurant?.uberDirectEnabled);
    const canSelf = Boolean(restaurant?.selfDeliveryEnabled);
    if (!canUber && !canSelf) return null; // no delivery integration at all

    const busy = dispatchUber.isPending || selfDeliver.isPending;

    return (
      <div className="space-y-2 rounded-xl border border-brand-subtle bg-brand-subtle p-3">
        <p className="text-xs font-semibold">
          {bothOptions ? "Who's taking this one?" : 'Send it out'}
        </p>

        <div className={`grid gap-2 ${bothOptions ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {canUber && (
            <Button size="sm" variant="outline" onClick={() => dispatchUber.mutate()} disabled={busy}>
              <Truck className="h-3.5 w-3.5" />
              {dispatchUber.isPending ? 'Calling Uber…' : bothOptions ? 'Uber' : 'Request an Uber courier'}
            </Button>
          )}

          {canSelf && (
            <Button size="sm" variant="outline" onClick={() => selfDeliver.mutate()} disabled={busy}>
              <Bike className="h-3.5 w-3.5" />
              {selfDeliver.isPending ? 'Assigning…' : bothOptions ? 'Our driver' : 'Assign our driver'}
            </Button>
          )}
        </div>

        {canSelf && (
          <Input
            value={driverName}
            onChange={(e) => setDriverName(e.target.value)}
            placeholder="Driver's name (optional)"
            className="h-8 text-xs"
          />
        )}
      </div>
    );
  }

  // --- Self-delivery: our driver, our buttons ---
  if (delivery.provider === 'SELF') {
    return (
      <div className="space-y-2 rounded-xl border p-3">
        <p className="flex items-center gap-1.5 text-xs font-semibold">
          <Bike className="h-3.5 w-3.5" />
          Your driver{delivery.driverName ? ` · ${delivery.driverName}` : ''}
        </p>

        {order.status === 'DRIVER_ASSIGNED' && (
          <Button
            size="sm"
            className="w-full"
            onClick={() => selfStatus.mutate('OUT_FOR_DELIVERY')}
            disabled={selfStatus.isPending}
          >
            Mark on its way
          </Button>
        )}

        {order.status === 'OUT_FOR_DELIVERY' && (
          <Button
            size="sm"
            className="w-full"
            onClick={() => selfStatus.mutate('DELIVERED')}
            disabled={selfStatus.isPending}
          >
            <Check className="h-3.5 w-3.5" />
            Mark delivered
          </Button>
        )}

        <p className="text-[11px] text-muted-foreground">
          The customer gets the same texts and tracking page as an Uber delivery.
        </p>
      </div>
    );
  }

  /**
   * ESCALATED: automation is out of options and a human must act.
   *
   * The customer has paid and is waiting. This is deliberately the loudest thing
   * on the board — an escalation nobody notices is exactly as bad as no escalation
   * at all, and worse, because we told ourselves we handled it.
   */
  if (delivery.escalatedAt) {
    return (
      <div className="space-y-2 rounded-xl border-2 border-destructive bg-destructive/10 p-3">
        <p className="flex items-center gap-1.5 text-xs font-bold text-destructive">
          <AlertTriangle className="h-4 w-4" />
          NO COURIER — YOU MUST ACT
        </p>
        <p className="text-xs text-destructive">
          {delivery.escalationReason ?? 'We could not get a courier for this order.'} The customer
          has paid and is waiting.
        </p>

        <div className="grid grid-cols-2 gap-2 pt-1">
          <Button size="sm" variant="outline" onClick={() => selfDeliver.mutate()}>
            <Bike className="h-3.5 w-3.5" />
            Deliver it myself
          </Button>
          <Button size="sm" variant="outline" onClick={() => dispatchUber.mutate()}>
            <Truck className="h-3.5 w-3.5" />
            Try Uber again
          </Button>
        </div>

        <a
          href={`tel:${order.customerPhone}`}
          className="block pt-1 text-center text-xs font-medium underline"
        >
          Call the customer
        </a>
      </div>
    );
  }

  // --- Uber: the handoff check ---
  const alreadyHandedOver = Boolean(delivery.handedOverAt);

  return (
    <div className="space-y-2 rounded-xl border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold">
          <Truck className="h-3.5 w-3.5" />
          {delivery.courierName ?? 'Waiting for a courier'}
          {delivery.courierVehicle ? ` · ${delivery.courierVehicle}` : ''}
        </p>

        {delivery.trackingUrl && (
          <a
            href={delivery.trackingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            Map
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      {/*
        THE PICKUP CODE. The whole reason this component exists.

        Big, monospace, unmissable. When a courier walks up, staff read this off
        the screen, ask the driver to read theirs, and compare. Three bags on the
        pass and two drivers at the counter is the exact situation where the wrong
        food goes out — and that mistake costs two customers and two free meals.
      */}
      {delivery.pickupCode && !alreadyHandedOver && (
        <div className="rounded-lg bg-foreground p-3 text-center">
          <p className="text-[10px] uppercase tracking-widest text-background/60">
            Ask the driver for their code
          </p>
          <p className="mt-0.5 font-mono text-2xl font-bold tracking-[0.2em] text-background">
            {delivery.pickupCode}
          </p>
        </div>
      )}

      {alreadyHandedOver ? (
        <p className="flex items-center gap-1.5 rounded-lg bg-emerald-50 p-2 text-xs font-medium text-emerald-900">
          <Check className="h-3.5 w-3.5" />
          Handed over{delivery.courierName ? ` to ${delivery.courierName}` : ''}
        </p>
      ) : (
        <>
          <div className="flex gap-2">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="Driver's code"
              maxLength={8}
              className="h-9 font-mono uppercase tracking-widest"
            />
            <Button
              size="sm"
              className="h-9 shrink-0"
              onClick={() => handoff.mutate(false)}
              disabled={!code.trim() || handoff.isPending}
            >
              Verify
            </Button>
          </div>

          {showOverride && (
            <div className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2">
              <p className="flex items-start gap-1.5 text-[11px] text-destructive">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                Only override if you are certain this is the right driver. This is logged.
              </p>
              <Input
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                placeholder="Why? e.g. driver's app not showing the code"
                className="h-8 text-xs"
              />
              <Button
                size="sm"
                variant="destructive"
                className="h-8 w-full text-xs"
                onClick={() => handoff.mutate(true)}
                disabled={handoff.isPending}
              >
                Hand over anyway
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
