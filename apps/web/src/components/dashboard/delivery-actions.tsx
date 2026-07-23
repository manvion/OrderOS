'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { AlertTriangle, Bike, Check, Copy, ExternalLink, MapPin, MessageCircle, Truck } from 'lucide-react';
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
  const [phone, setPhone] = useState(order.customerPhone ?? '');

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['orders'] });

  // Correct a bad delivery phone (the usual reason Uber declines) so a retry can go
  // through, without re-taking the whole order.
  const updatePhone = useMutation({
    mutationFn: () => api.updateOrderContact(order.id, { customerPhone: phone.trim() }),
    onSuccess: () => {
      refresh();
      toast.success('Phone updated — now try the courier again');
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not update the phone'),
  });

  const dispatchUber = useMutation({
    mutationFn: () => api.dispatchUber(order.id),
    onSuccess: () => {
      refresh();
      toast.success('Uber courier requested');
    },
    onError: (err) => {
      // Re-fetch so the card reflects the fresh failure, and show the courier's real
      // reason (bad phone/address) rather than a generic error.
      refresh();
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not reach Uber');
    },
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

        {/* Hand the driver a link so their phone shares live location and lets them
            mark it delivered — no login, they just scan or tap. */}
        {delivery.driverShareToken && order.status !== 'DELIVERED' && (
          <DriverHandoffCard
            token={delivery.driverShareToken}
            driverPhone={delivery.driverPhone}
            orderNumber={order.orderNumber}
          />
        )}

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

  /**
   * FAILED: Uber declined the dispatch (or it errored out) but automation hasn't
   * escalated it yet. Don't leave staff on a dead "waiting for a courier" card — give
   * them both ways forward right here: try Uber again, or hand it to their own driver.
   */
  if (delivery.status === 'FAILED') {
    const canUber = Boolean(restaurant?.uberDirectEnabled);
    const canSelf = Boolean(restaurant?.selfDeliveryEnabled);
    const busy = dispatchUber.isPending || selfDeliver.isPending;

    return (
      <div className="space-y-2 rounded-xl border border-destructive/40 bg-destructive/5 p-3">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-destructive">
          <AlertTriangle className="h-3.5 w-3.5" />
          Delivery didn&apos;t go through
        </p>
        {delivery.lastError && (
          <p className="text-[11px] text-destructive">{delivery.lastError}</p>
        )}

        {/* Most Uber declines are a bad/placeholder phone. Let staff fix it in place and
            retry, instead of cancelling and re-taking the order. */}
        <div className="space-y-1 rounded-lg border bg-background p-2">
          <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Customer phone
          </label>
          <div className="flex gap-2">
            <Input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="e.g. 514-555-0188"
              className="h-8 text-xs"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-8 shrink-0"
              onClick={() => updatePhone.mutate()}
              disabled={
                updatePhone.isPending ||
                phone.trim().length < 7 ||
                phone.trim() === (order.customerPhone ?? '')
              }
            >
              {updatePhone.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Fix a bad number, then Try Uber again.
          </p>
        </div>

        <div className={`grid gap-2 ${canUber && canSelf ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {canUber && (
            <Button size="sm" variant="outline" onClick={() => dispatchUber.mutate()} disabled={busy}>
              <Truck className="h-3.5 w-3.5" />
              {dispatchUber.isPending ? 'Calling Uber…' : 'Try Uber again'}
            </Button>
          )}
          {canSelf && (
            <Button size="sm" variant="outline" onClick={() => selfDeliver.mutate()} disabled={busy}>
              <Bike className="h-3.5 w-3.5" />
              {selfDeliver.isPending ? 'Assigning…' : 'Use own driver'}
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

        <a
          href={`tel:${order.customerPhone}`}
          className="block pt-0.5 text-center text-[11px] font-medium text-muted-foreground underline"
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

/**
 * The link that turns the restaurant's own rider into a live pin.
 *
 * The driver isn't a user of ours and never will be, so we don't onboard them — we
 * hand them a capability URL and let their own phone do the rest. Three ways to get
 * it to them, because the driver might be standing at the pass (scan the QR) or
 * already on the road (WhatsApp / copy):
 */
function DriverHandoffCard({
  token,
  driverPhone,
  orderNumber,
}: {
  token: string;
  driverPhone: string | null;
  orderNumber: string;
}) {
  const [qr, setQr] = useState<string | null>(null);
  const [url, setUrl] = useState('');

  useEffect(() => {
    // Built from the browser's own origin, so it points at whatever host the
    // dashboard is being served from without a hard-coded domain.
    const link = `${window.location.origin}/d/${token}`;
    setUrl(link);
    void QRCode.toDataURL(link, { width: 320, margin: 1 }).then(setQr).catch(() => setQr(null));
  }, [token]);

  const message = `Delivery for order #${orderNumber}. Open this on your phone to share your location and mark it delivered: ${url}`;
  const waHref = driverPhone
    ? `https://wa.me/${driverPhone.replace(/\D/g, '')}?text=${encodeURIComponent(message)}`
    : `https://wa.me/?text=${encodeURIComponent(message)}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Driver link copied');
    } catch {
      toast.error('Could not copy — long-press the link instead');
    }
  };

  return (
    <div className="space-y-2 rounded-lg border border-dashed p-3">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
        <MapPin className="h-3.5 w-3.5" />
        Give your driver live tracking
      </p>

      <div className="flex items-center gap-3">
        {qr ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={qr}
            alt="Scan to open the driver page"
            className="h-24 w-24 shrink-0 rounded-md border bg-white"
          />
        ) : (
          <div className="h-24 w-24 shrink-0 animate-pulse rounded-md bg-muted" />
        )}

        <div className="min-w-0 space-y-1.5">
          <p className="text-[11px] text-muted-foreground">
            Driver scans this, taps <span className="font-medium">Start sharing</span>, and the
            customer sees them move. They can mark it delivered — with a photo — from the same page.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline" className="h-7 text-xs">
              <a href={waHref} target="_blank" rel="noopener noreferrer">
                <MessageCircle className="h-3.5 w-3.5" />
                WhatsApp
              </a>
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={copy}>
              <Copy className="h-3.5 w-3.5" />
              Copy link
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
