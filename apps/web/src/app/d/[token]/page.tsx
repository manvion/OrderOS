'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { CheckCircle2, Loader2, MapPin, Navigation, Radio, Camera } from 'lucide-react';
import { driverApi, ApiRequestError, type DriverContext } from '@/lib/api';
import { Button } from '@/components/ui/button';

/**
 * The restaurant's OWN driver, on their own phone.
 *
 * This page exists so a self-delivery — a moped rider, not an Uber courier — still
 * puts a moving pin on the customer's tracking map. The driver scans a QR the
 * kitchen shows them (or taps a WhatsApp link), lands here, and taps one button.
 * From then on the browser streams GPS straight into the same fields the customer's
 * map already reads. No app, no login: the token in the URL is the whole credential.
 *
 * It is built for one thumb, outdoors, on a cracked screen: big targets, high
 * contrast, and every state says plainly what is happening.
 */

/** Send a fix at most this often. The server also dedupes anything under 15m. */
const PING_EVERY_MS = 6_000;

export default function DriverPage() {
  const token = String(useParams().token);

  const [ctx, setCtx] = useState<DriverContext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'pickup' | 'deliver'>(null);
  const [done, setDone] = useState(false);

  const watchIdRef = useRef<number | null>(null);
  const lastSentRef = useRef(0);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);

  // --- Load the order context ---
  useEffect(() => {
    let alive = true;
    driverApi
      .getContext(token)
      .then((c) => {
        if (!alive) return;
        setCtx(c);
        if (c.finished) setDone(true);
      })
      .catch((err) => {
        if (!alive) return;
        setLoadError(
          err instanceof ApiRequestError ? err.body.message : 'Could not load this delivery.',
        );
      });
    return () => {
      alive = false;
    };
  }, [token]);

  const stopSharing = useCallback(() => {
    if (watchIdRef.current !== null && typeof navigator !== 'undefined') {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    void wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
    setSharing(false);
  }, []);

  // Tidy up if the driver closes the tab.
  useEffect(() => () => stopSharing(), [stopSharing]);

  const startSharing = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGeoError('This phone can’t share location from the browser.');
      return;
    }
    setGeoError(null);

    // Keep the screen awake while riding — a locked phone stops sending GPS, which
    // is the whole failure this page exists to prevent. Best-effort; unsupported on
    // some browsers, which is fine.
    try {
      const anyNav = navigator as unknown as {
        wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> };
      };
      wakeLockRef.current = (await anyNav.wakeLock?.request('screen')) ?? null;
    } catch {
      /* no wake lock — carry on */
    }

    // One fast fix RIGHT NOW so the customer sees the driver — and the route from the
    // driver to the door — the instant "picked up" is tapped, instead of waiting up to
    // 20s for the first high-accuracy GPS lock below. Low accuracy + a cached fix is
    // fine for this first pin; watchPosition sharpens it moments later.
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeoError(null);
        lastSentRef.current = Date.now();
        void driverApi.ping(token, pos.coords.latitude, pos.coords.longitude).catch(() => {});
      },
      () => {
        /* no quick fix — watchPosition will get one shortly */
      },
      { enableHighAccuracy: false, maximumAge: 60_000, timeout: 8_000 },
    );

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        setGeoError(null);
        const now = Date.now();
        if (now - lastSentRef.current < PING_EVERY_MS) return;
        lastSentRef.current = now;
        void driverApi.ping(token, pos.coords.latitude, pos.coords.longitude).catch(() => {
          // A dropped fix is not worth alarming the driver over — the next one retries.
        });
      },
      (err) => {
        setGeoError(
          err.code === err.PERMISSION_DENIED
            ? 'Location is blocked. Allow location for this site, then tap again.'
            : 'Couldn’t get a location fix. Move to open sky and try again.',
        );
        stopSharing();
      },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 },
    );
    setSharing(true);
  }, [token, stopSharing]);

  const markPickedUp = useCallback(async () => {
    setBusy('pickup');
    try {
      await driverApi.setStatus(token, 'OUT_FOR_DELIVERY');
      setCtx((c) => (c ? { ...c, status: 'DROPOFF_ENROUTE' } : c));
      if (!sharing) void startSharing();
    } catch {
      /* leave the button re-enabled to retry */
    } finally {
      setBusy(null);
    }
  }, [token, sharing, startSharing]);

  const markDelivered = useCallback(
    async (photo?: string) => {
      setBusy('deliver');
      try {
        await driverApi.setStatus(token, 'DELIVERED', photo);
        stopSharing();
        setDone(true);
      } catch (err) {
        setGeoError(
          err instanceof ApiRequestError ? err.body.message : 'Could not mark delivered. Try again.',
        );
      } finally {
        setBusy(null);
      }
    },
    [token, stopSharing],
  );

  // --- States ---
  if (loadError) {
    return (
      <Centered>
        <p className="text-lg font-semibold">This link isn’t working</p>
        <p className="mt-2 text-muted-foreground">{loadError}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Ask the restaurant to open the order and show you a fresh link.
        </p>
      </Centered>
    );
  }

  if (!ctx) {
    return (
      <Centered>
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </Centered>
    );
  }

  if (done) {
    return (
      <Centered>
        <CheckCircle2 className="h-14 w-14 text-emerald-500" />
        <p className="mt-4 text-2xl font-bold">Delivered</p>
        <p className="mt-2 text-muted-foreground">
          Thanks — order #{ctx.orderNumber} for {ctx.restaurantName} is done. You can close this
          page.
        </p>
      </Centered>
    );
  }

  const mapsHref =
    ctx.dropoffLatitude != null && ctx.dropoffLongitude != null
      ? `https://www.google.com/maps/dir/?api=1&destination=${ctx.dropoffLatitude},${ctx.dropoffLongitude}`
      : ctx.dropoffAddress
        ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(ctx.dropoffAddress)}`
        : null;

  return (
    <main className="mx-auto min-h-screen max-w-md px-5 py-8">
      <header>
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {ctx.restaurantName} · Order #{ctx.orderNumber}
        </p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">Deliver to {ctx.customerName}</h1>
      </header>

      {/* Where it's going. */}
      <div className="mt-5 rounded-2xl border p-4">
        <div className="flex items-start gap-3">
          <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-brand" />
          <div className="min-w-0">
            <p className="font-medium">{ctx.dropoffAddress ?? 'Address on file'}</p>
            {ctx.dropoffNotes && (
              <p className="mt-1 text-sm text-muted-foreground">“{ctx.dropoffNotes}”</p>
            )}
          </div>
        </div>
        {mapsHref && (
          <Button asChild variant="outline" className="mt-4 w-full">
            <a href={mapsHref} target="_blank" rel="noopener noreferrer">
              <Navigation className="h-4 w-4" />
              Open in Maps
            </a>
          </Button>
        )}
      </div>

      {/* Location sharing — the point of the page. */}
      <div className="mt-4 rounded-2xl border p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Radio className={`h-5 w-5 ${sharing ? 'text-emerald-500' : 'text-muted-foreground'}`} />
            <span className="font-medium">
              {sharing ? 'Sharing your location' : 'Location off'}
            </span>
          </div>
          {sharing && (
            <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-emerald-600">
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
              Live
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {sharing
            ? 'The customer can see you moving on their map. Keep this page open while you ride.'
            : 'Turn this on so the customer can watch their order approach.'}
        </p>
        {geoError && <p className="mt-2 text-sm text-red-600">{geoError}</p>}
        <Button
          variant={sharing ? 'outline' : 'brand'}
          className="mt-3 w-full"
          onClick={sharing ? stopSharing : startSharing}
        >
          {sharing ? 'Stop sharing' : 'Start sharing my location'}
        </Button>
      </div>

      {/* The two things that move the order along. */}
      <div className="mt-6 space-y-3">
        <Button
          variant="outline"
          className="h-12 w-full text-base"
          disabled={busy !== null}
          onClick={markPickedUp}
        >
          {busy === 'pickup' ? <Loader2 className="h-5 w-5 animate-spin" /> : 'I’ve picked up the food'}
        </Button>

        <DeliveredButton busy={busy === 'deliver'} onDeliver={markDelivered} />
      </div>
    </main>
  );
}

/**
 * "Delivered", with an optional proof-of-delivery photo.
 *
 * Tapping it opens the phone camera. If the driver takes a photo we compress it and
 * send it as proof; if they cancel the camera we still mark it delivered — the
 * handover already happened, and a blocked photo must never trap the food as
 * "on its way" forever.
 */
function DeliveredButton({
  busy,
  onDeliver,
}: {
  busy: boolean;
  onDeliver: (photo?: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // let the same photo be re-picked after a failure
    if (!file) {
      onDeliver(); // camera cancelled — deliver without proof
      return;
    }
    try {
      onDeliver(await compressImage(file));
    } catch {
      onDeliver(); // couldn't process the image — still mark delivered
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={onFile}
      />
      <Button
        variant="brand"
        className="h-14 w-full text-base"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : (
          <>
            <Camera className="h-5 w-5" />
            Delivered — take proof photo
          </>
        )}
      </Button>
    </>
  );
}

/**
 * Shrink a phone photo to something sensible before upload — long edge 1280px,
 * JPEG q0.72. A modern phone photo is 3–8MB; this lands well under the 5MB store
 * limit and uploads fast on a curb-side connection. Returns a data URL.
 */
function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const max = 1280;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const g = canvas.getContext('2d');
      if (!g) return reject(new Error('no canvas'));
      g.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.72));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('bad image'));
    };
    img.src = url;
  });
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 text-center">
      {children}
    </main>
  );
}
