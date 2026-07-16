'use client';

import { useDashboard, useRequireRole } from '@/components/dashboard/dashboard-provider';
import { TaxReportPanel } from '@/components/dashboard/tax-report-panel';

export default function TaxReportsPage() {
  const { restaurant } = useDashboard();
  useRequireRole('MANAGER', '/dashboard/kitchen');

  if (!restaurant) return null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Tax reports</h1>
        <p className="text-sm text-muted-foreground">
          Daily and monthly totals, broken out by tax name — GST, QST, or whatever your
          jurisdiction calls it.
        </p>
      </div>

      <TaxReportPanel />
    </div>
  );
}
