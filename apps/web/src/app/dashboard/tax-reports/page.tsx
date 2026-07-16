'use client';

import { useDashboard, useRequireRole } from '@/components/dashboard/dashboard-provider';
import { PlanGate } from '@/components/dashboard/plan-gate';
import { TaxReportPanel } from '@/components/dashboard/tax-report-panel';

export default function TaxReportsPage() {
  return (
    <PlanGate capability="TAX_REPORTS">
      <TaxReportsPageInner />
    </PlanGate>
  );
}

function TaxReportsPageInner() {
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
