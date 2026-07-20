'use client';

import { useEffect } from 'react';
import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '@/lib/use-online-status';

/**
 * Two jobs, both about surviving a dropped connection on an all-cloud POS:
 *
 *  1. Registers the service worker, so the dashboard shell still LOADS offline (a reload
 *     on dead Wi-Fi shows the app, not the browser's error page).
 *  2. Shows an unmissable banner when the connection is down — because the orders and
 *     totals on screen are the last-known state, and staff must know the difference
 *     between "live" and "stale". Payments can't be taken offline, so this is honest
 *     rather than pretending the app is fully functional.
 *
 * Deliberately NOT an offline order queue: queuing orders to sync later touches order and
 * payment integrity (duplicate tickets, stock, double charges) and needs real on-device
 * testing before it can be trusted with money. This slice makes the app resilient and
 * honest; the sync queue is a follow-on.
 */
export function OfflineGuard() {
  const online = useOnlineStatus();

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    // Register after load so it never competes with first paint.
    const register = () => navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    if (document.readyState === 'complete') register();
    else {
      window.addEventListener('load', register);
      return () => window.removeEventListener('load', register);
    }
  }, []);

  if (online) return null;

  return (
    <div className="sticky top-0 z-50 flex items-center justify-center gap-2 bg-amber-500 px-4 py-1.5 text-center text-sm font-medium text-amber-950">
      <WifiOff className="h-4 w-4 shrink-0" />
      You&apos;re offline — showing the last data loaded. New orders and payments will
      resume when the connection is back.
    </div>
  );
}
