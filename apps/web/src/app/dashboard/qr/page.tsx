'use client';

import { useState } from 'react';
import Image from 'next/image';
import { useAuth } from '@clerk/nextjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Plus, Printer, QrCode, Sparkles, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useApi, useDashboard } from '@/components/dashboard/dashboard-provider';
import { ApiRequestError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { Badge, Label, Skeleton } from '@/components/ui/primitives';

/**
 * Every code here is an ORDERING code — each one opens the menu, ready to order,
 * in one scan. The types only differ in where the paper lives and what extra
 * context the scan carries. Spelled out because an operator looking for "the QR
 * to order" read this page as tables-only and concluded the feature was missing.
 */
const TYPE_HELP: Record<string, string> = {
  COUNTER: 'Scan-to-order for the till, a counter card, or a sticker. Opens your menu directly.',
  TABLE: 'Scan-to-order for table tents. Also pre-fills the table number, so dine-in orders arrive labeled and runners know where the food goes.',
  FLYER: 'Scan-to-order for print, windows and posters. Rendered large with heavy error correction so it survives bad printing.',
};

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export default function QrPage() {
  const api = useApi();
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  const { restaurant, can } = useDashboard();

  // COUNTER first: the universal "scan to order" code every restaurant needs.
  // TABLE is the dine-in specialisation (and errors when dine-in is off).
  const [type, setType] = useState<'TABLE' | 'COUNTER' | 'FLYER'>('COUNTER');
  const [label, setLabel] = useState('');
  const [tableNumber, setTableNumber] = useState('');
  const [tableFrom, setTableFrom] = useState(1);
  const [tableTo, setTableTo] = useState(12);

  const { data: codes, isLoading } = useQuery({
    queryKey: ['qr', restaurant?.id],
    queryFn: () => api.listQrCodes(),
    enabled: Boolean(restaurant),
  });

  const { data: stats } = useQuery({
    queryKey: ['qr', 'stats', restaurant?.id],
    queryFn: () => api.getQrStats(),
    enabled: Boolean(restaurant),
  });

  const create = useMutation({
    mutationFn: () =>
      api.createQrCode({
        type,
        label: label.trim(),
        ...(type === 'TABLE' ? { tableNumber: tableNumber.trim() } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['qr'] });
      setLabel('');
      setTableNumber('');
      toast.success('QR code created');
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not create the code'),
  });

  const bulkTables = useMutation({
    mutationFn: () => api.createTableRange(tableFrom, tableTo),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['qr'] });
      toast.success(
        result.skipped > 0
          ? `${result.created} new codes created. ${result.skipped} already existed and were left alone.`
          : `${result.created} table codes ready to print.`,
      );
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not create the codes'),
  });

  /**
   * The print sheet is an authenticated HTML page, so we can't just link to it —
   * a plain <a> carries no bearer token. Fetch it, then open the HTML in a new tab
   * as a blob so the owner gets a real Ctrl+P page.
   */
  const openPrintSheet = async () => {
    try {
      const token = await getToken();
      const res = await fetch(`${apiUrl}/api/qr/print-sheet`, {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(restaurant ? { 'X-Restaurant-Id': restaurant.id } : {}),
        },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? 'Could not build the print sheet');
      }

      const html = await res.text();
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      // Revoke late — revoking immediately can race the new tab's load.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteQrCode(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['qr'] });
      toast.success('QR code deleted');
    },
    // The API refuses to delete a code with orders attributed to it (its printed
    // copies are on live tables). Show that reason as-is.
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not delete'),
  });

  /**
   * The download endpoints are behind ClerkAuthGuard, and a plain `<a download>`
   * cannot attach a bearer token. So fetch the bytes through the authenticated
   * client and hand the browser a blob URL instead.
   */
  const download = async (id: string, format: 'png' | 'svg', label: string) => {
    try {
      const token = await getToken();
      const res = await fetch(`${apiUrl}/api/qr/${id}/download.${format}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(restaurant ? { 'X-Restaurant-Id': restaurant.id } : {}),
        },
      });
      if (!res.ok) throw new Error('Download failed');

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `qr-${label.toLowerCase().replace(/\s+/g, '-')}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Could not download the code');
    }
  };

  if (!restaurant) return null;
  const readOnly = !can('MANAGER');

  const statsById = new Map((stats ?? []).map((s) => [s.id, s]));

  const canCreate =
    label.trim().length > 0 && (type !== 'TABLE' || tableNumber.trim().length > 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">QR codes</h1>
        <p className="text-sm text-muted-foreground">
          Print these and customers order from their phone — no app, no commission.
        </p>
      </div>

      {!restaurant.isPublished && (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="p-4 text-sm text-amber-900">
            Your page isn&apos;t live yet, so these codes won&apos;t work until you publish. You can
            still create and print them.
          </CardContent>
        </Card>
      )}

      {/*
        Bulk tables. A restaurant with 24 tables is not going to fill in a form 24
        times — they'll just never set up dine-in. This is the difference between a
        feature that exists and a feature that gets used.
      */}
      {!readOnly && restaurant.dineInEnabled && (
        <Card className="border-brand-subtle bg-brand-subtle">
          <CardHeader>
            <CardTitle className="text-base">Set up your whole dining room</CardTitle>
            <CardDescription>
              Generate a code for every table at once, then print them all on one sheet.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="t-from" className="text-xs">
                  From table
                </Label>
                <Input
                  id="t-from"
                  type="number"
                  min={1}
                  max={999}
                  value={tableFrom}
                  onChange={(e) => setTableFrom(Number(e.target.value))}
                  className="h-9 w-24"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="t-to" className="text-xs">
                  To table
                </Label>
                <Input
                  id="t-to"
                  type="number"
                  min={1}
                  max={999}
                  value={tableTo}
                  onChange={(e) => setTableTo(Number(e.target.value))}
                  className="h-9 w-24"
                />
              </div>

              <Button
                onClick={() => bulkTables.mutate()}
                disabled={bulkTables.isPending || tableTo < tableFrom}
              >
                <Sparkles className="h-4 w-4" />
                {bulkTables.isPending
                  ? 'Generating…'
                  : `Create ${Math.max(0, tableTo - tableFrom + 1)} codes`}
              </Button>

              <Button variant="outline" onClick={openPrintSheet}>
                <Printer className="h-4 w-4" />
                Print sheet
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">
              Tables you already have codes for are left alone — their printed copies keep working.
            </p>
          </CardContent>
        </Card>
      )}

      {!readOnly && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Create a single code</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="qr-type">Type</Label>
                <Select
                  id="qr-type"
                  value={type}
                  onChange={(e) => setType(e.target.value as typeof type)}
                >
                  <option value="COUNTER">Order — counter / sticker</option>
                  <option value="TABLE">Order — dine-in table</option>
                  <option value="FLYER">Order — flyer / window</option>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="qr-label">Label</Label>
                <Input
                  id="qr-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder={type === 'TABLE' ? 'Table 4' : 'Front window'}
                />
              </div>

              {type === 'TABLE' && (
                <div className="space-y-2">
                  <Label htmlFor="qr-table">Table number</Label>
                  <Input
                    id="qr-table"
                    value={tableNumber}
                    onChange={(e) => setTableNumber(e.target.value)}
                    placeholder="4"
                  />
                </div>
              )}
            </div>

            <p className="text-xs text-muted-foreground">{TYPE_HELP[type]}</p>

            <Button onClick={() => create.mutate()} disabled={!canCreate || create.isPending}>
              <Plus className="h-4 w-4" />
              {create.isPending ? 'Creating…' : 'Create code'}
            </Button>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-64" />
          ))}
        </div>
      ) : !codes?.length ? (
        <Card>
          <CardContent className="py-16 text-center">
            <QrCode className="mx-auto h-10 w-10 text-muted-foreground" />
            <p className="mt-4 font-medium">No codes yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Start with one per table, plus one for the counter.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {codes.map((code) => {
            const stat = statsById.get(code.id);
            return (
              <Card key={code.id}>
                <CardContent className="space-y-4 p-5">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold">{code.label}</p>
                      <Badge variant="outline" className="mt-1 text-[10px]">
                        {code.type.toLowerCase()}
                      </Badge>
                    </div>
                    {!readOnly && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        onClick={() => remove.mutate(code.id)}
                        aria-label={`Delete ${code.label}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>

                  {code.imageUrl && (
                    <div className="flex justify-center rounded-lg bg-white p-4">
                      <Image
                        src={code.imageUrl}
                        alt={`QR code for ${code.label}`}
                        width={140}
                        height={140}
                        className="h-35 w-35"
                        unoptimized
                      />
                    </div>
                  )}

                  {stat && (
                    <div className="grid grid-cols-3 gap-2 text-center text-xs">
                      <div>
                        <p className="font-semibold tabular-nums">{stat.scans}</p>
                        <p className="text-muted-foreground">scans</p>
                      </div>
                      <div>
                        <p className="font-semibold tabular-nums">{stat.orders}</p>
                        <p className="text-muted-foreground">orders</p>
                      </div>
                      <div>
                        <p className="font-semibold tabular-nums">{stat.conversionRate}%</p>
                        <p className="text-muted-foreground">convert</p>
                      </div>
                    </div>
                  )}

                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => download(code.id, 'png', code.label)}
                    >
                      <Download className="h-3.5 w-3.5" />
                      PNG
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => download(code.id, 'svg', code.label)}
                    >
                      <Download className="h-3.5 w-3.5" />
                      SVG
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
