'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { formatMoney } from '@dinedirect/shared';
import { useApi, useDashboard } from '@/components/dashboard/dashboard-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/primitives';

/** yyyy-mm-dd in the browser's own timezone -- what an owner reading "today" means. */
function toDateInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

// `to` here is the last INCLUSIVE day shown in the date field -- the API wants
// an exclusive boundary, so callers add one day right before the request.
const PRESETS = [
  {
    label: 'This month',
    range: () => {
      const now = new Date();
      return { from: startOfMonth(now), to: new Date(now.getFullYear(), now.getMonth() + 1, 0) };
    },
  },
  {
    label: 'Last month',
    range: () => {
      const now = new Date();
      return {
        from: new Date(now.getFullYear(), now.getMonth() - 1, 1),
        to: new Date(now.getFullYear(), now.getMonth(), 0),
      };
    },
  },
  {
    label: 'This year',
    range: () => {
      const now = new Date();
      return { from: new Date(now.getFullYear(), 0, 1), to: new Date(now.getFullYear(), 11, 31) };
    },
  },
] as const;

/**
 * Daily/monthly tax totals, broken out by name (GST, QST, ...) -- what an
 * owner actually needs to hand to an accountant or a tax filing, not just a
 * revenue chart. Exportable as CSV since nobody files taxes from a web page.
 */
export function TaxReportPanel() {
  const api = useApi();
  const { restaurant } = useDashboard();
  const [from, setFrom] = useState(() => toDateInput(startOfMonth(new Date())));
  const [to, setTo] = useState(() => toDateInput(new Date()));
  const [downloading, setDownloading] = useState(false);

  // The field shows the last INCLUSIVE day; the API wants an exclusive
  // upper bound, so the request always asks for one day past what's shown.
  const toExclusive = useMemo(() => {
    const d = new Date(`${to}T00:00:00`);
    d.setDate(d.getDate() + 1);
    return toDateInput(d);
  }, [to]);

  const { data: report, isLoading } = useQuery({
    queryKey: ['analytics', 'tax-report', restaurant?.id, from, toExclusive],
    queryFn: () => api.getTaxReport(from, toExclusive),
    enabled: Boolean(restaurant),
  });

  const currency = restaurant?.currency ?? 'USD';

  const download = async () => {
    setDownloading(true);
    try {
      const blob = await api.downloadTaxReportCsv(from, toExclusive);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tax-report_${from}_to_${to}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Could not download the report');
    } finally {
      setDownloading(false);
    }
  };

  const applyPreset = (range: () => { from: Date; to: Date }) => {
    const r = range();
    setFrom(toDateInput(r.from));
    setTo(toDateInput(r.to));
  };

  const hasTax = useMemo(() => (report?.taxNames.length ?? 0) > 0, [report]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileText className="h-4 w-4" />
          Tax report
        </CardTitle>
        <CardDescription>
          Subtotal, discount and tax by name for a date range — what an accountant or a filing
          actually needs, not a revenue chart.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex gap-2">
            {PRESETS.map((p) => (
              <Button key={p.label} variant="outline" size="sm" onClick={() => applyPreset(p.range)}>
                {p.label}
              </Button>
            ))}
          </div>
          <div className="flex items-end gap-2">
            <label className="space-y-1 text-xs text-muted-foreground">
              From
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="block h-9 rounded-lg border bg-background px-2.5 text-sm"
              />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              To
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="block h-9 rounded-lg border bg-background px-2.5 text-sm"
              />
            </label>
          </div>
          <Button variant="outline" size="sm" onClick={download} disabled={downloading || !report}>
            <Download className="h-3.5 w-3.5" />
            {downloading ? 'Downloading…' : 'Download CSV'}
          </Button>
        </div>

        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : !report || report.summary.orderCount === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No paid orders in this range.
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-4">
              <Stat label="Subtotal" value={formatMoney(report.summary.subtotalCents, currency)} />
              <Stat label="Discounts" value={`-${formatMoney(report.summary.discountCents, currency)}`} />
              {hasTax ? (
                report.taxByName.map((t) => (
                  <Stat key={t.name} label={t.name} value={formatMoney(t.amountCents, currency)} />
                ))
              ) : (
                <Stat label="Tax" value={formatMoney(report.summary.taxCents, currency)} />
              )}
              <Stat label="Orders" value={String(report.summary.orderCount)} />
            </div>

            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/50 text-left">
                  <tr>
                    <th className="p-3 font-medium">Date</th>
                    <th className="p-3 text-right font-medium">Subtotal</th>
                    <th className="p-3 text-right font-medium">Discount</th>
                    {report.taxNames.map((name) => (
                      <th key={name} className="p-3 text-right font-medium">
                        {name}
                      </th>
                    ))}
                    <th className="p-3 text-right font-medium">Total</th>
                    <th className="p-3 text-right font-medium">Orders</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {report.daily.map((d) => (
                    <tr key={d.date}>
                      <td className="p-3">{d.date}</td>
                      <td className="p-3 text-right tabular-nums">
                        {formatMoney(d.subtotalCents, currency)}
                      </td>
                      <td className="p-3 text-right tabular-nums">
                        {formatMoney(d.discountCents, currency)}
                      </td>
                      {report.taxNames.map((name) => (
                        <td key={name} className="p-3 text-right tabular-nums">
                          {formatMoney(d.taxByName[name] ?? 0, currency)}
                        </td>
                      ))}
                      <td className="p-3 text-right font-medium tabular-nums">
                        {formatMoney(d.totalCents, currency)}
                      </td>
                      <td className="p-3 text-right tabular-nums">{d.orderCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-semibold tabular-nums">{value}</p>
    </div>
  );
}
