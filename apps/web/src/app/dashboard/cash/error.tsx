'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Route-level error boundary for the cash drawer. Instead of Next.js's blank
 * "Application error", this surfaces the actual message so a failure here is
 * diagnosable at a glance rather than a mystery in the browser console.
 */
export default function CashError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Also log it, so it's in the console with a stack for a deeper look.
    console.error('Cash drawer page error:', error);
  }, [error]);

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Cash drawer</h1>
        <p className="text-sm text-destructive">Something went wrong loading this page.</p>
      </div>
      <pre className="overflow-auto rounded-lg border bg-muted p-3 text-xs">
        {error.message || 'Unknown error'}
        {error.digest ? `\n\ndigest: ${error.digest}` : ''}
      </pre>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
