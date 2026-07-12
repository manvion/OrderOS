'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * One QueryClient per browser session, created inside useState so that a re-render
 * never swaps it for a fresh one (which would silently throw the cache away).
 *
 * `retry: false` on purpose. The console's first call is `adminMe`, and a 401 there
 * is the correct answer for anyone who isn't a platform admin — retrying it three
 * times just makes the "Not found" screen take two seconds to appear.
 */
export function AdminQueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, refetchOnWindowFocus: true, retry: false },
        },
      }),
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
