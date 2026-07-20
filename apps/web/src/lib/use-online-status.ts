'use client';

import { useEffect, useState } from 'react';

/**
 * Tracks the browser's connection state. `navigator.onLine` is the baseline; we also
 * flip on the window online/offline events so the UI reacts the instant the Wi-Fi drops
 * or comes back — which, on an all-cloud POS, is exactly when staff need to be told the
 * data they're looking at may be stale.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  return online;
}
