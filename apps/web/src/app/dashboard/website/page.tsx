'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  Globe,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { formatMoney, type WidgetSettings } from '@orderos/shared';
import { toast } from 'sonner';
import { useApi, useDashboard } from '@/components/dashboard/dashboard-provider';
import { ApiRequestError } from '@/lib/api';
import type { WebsiteIntegration, WidgetFunnel } from '@/lib/api';
import { WidgetAppearance } from '@/components/dashboard/widget-appearance';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge, Label, Skeleton } from '@/components/ui/primitives';

export default function WebsitePage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { restaurant, can } = useDashboard();

  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [editing, setEditing] = useState<WebsiteIntegration | null>(null);

  const { data: integrations, isLoading } = useQuery({
    queryKey: ['integrations', restaurant?.id],
    queryFn: () => api.listIntegrations(),
    enabled: Boolean(restaurant),
  });

  const { data: funnel } = useQuery({
    queryKey: ['integrations', 'analytics', restaurant?.id],
    queryFn: () => api.getWidgetAnalytics(),
    enabled: Boolean(restaurant),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['integrations'] });

  const create = useMutation({
    mutationFn: () => api.createIntegration({ name: name.trim(), domain: domain.trim() }),
    onSuccess: () => {
      invalidate();
      setName('');
      setDomain('');
      toast.success('Website added — copy the snippet below into your site.');
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not add the website'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteIntegration(id),
    onSuccess: () => {
      invalidate();
      toast.success('Website removed. The widget will stop working on that site.');
    },
    onError: () => toast.error('Could not remove the website'),
  });

  const rotate = useMutation({
    mutationFn: (id: string) => api.rotateWidgetKey(id),
    onSuccess: () => {
      invalidate();
      toast.warning('New key generated. Your website is BROKEN until you paste the new snippet.', {
        duration: 15_000,
      });
    },
    onError: () => toast.error('Could not rotate the key'),
  });

  if (!restaurant) return null;
  const readOnly = !can('MANAGER');

  const statsFor = (id: string) => funnel?.find((f) => f.integrationId === id);

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Your website</h1>
        <p className="text-sm text-muted-foreground">
          Already have a website? Add ordering to it with one line of code — no rebuild, no
          migration.
        </p>
      </div>

      {!restaurant.isPublished && (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="p-4 text-sm text-amber-900">
            Your ordering page isn&apos;t published yet, so the widget won&apos;t load on your site.
            Publish in Settings first.
          </CardContent>
        </Card>
      )}

      {!readOnly && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add a website</CardTitle>
            <CardDescription>
              The domain where you&apos;ll paste the code. The widget only runs on domains you
              register here.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="w-name">Label</Label>
                <Input
                  id="w-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Main site (WordPress)"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="w-domain">Domain</Label>
                <Input
                  id="w-domain"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder="joesburgers.com"
                />
                <p className="text-xs text-muted-foreground">
                  Just the domain. We handle{' '}
                  <code className="text-[11px]">www.</code> automatically.
                </p>
              </div>
            </div>

            <Button
              onClick={() => create.mutate()}
              disabled={!name.trim() || !domain.trim() || create.isPending}
            >
              <Plus className="h-4 w-4" />
              {create.isPending ? 'Adding…' : 'Add website'}
            </Button>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : !integrations?.length ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Globe className="mx-auto h-10 w-10 text-muted-foreground" />
            <p className="mt-4 font-medium">No websites connected</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Add your existing website above to start taking orders from it.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {integrations.map((integration) => {
            const stats = statsFor(integration.id);

            return (
              <Card key={integration.id}>
                <CardHeader className="flex-row items-start justify-between space-y-0">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-base">
                      {integration.name}
                      {/*
                        The single most useful thing this page can tell an owner:
                        have we actually seen the snippet running on their site?
                        "Not detected" turns a support ticket into a self-fix.
                      */}
                      {integration.installedAt ? (
                        <Badge variant="success" className="gap-1 text-[10px]">
                          <Check className="h-3 w-3" />
                          Installed
                        </Badge>
                      ) : (
                        <Badge variant="warning" className="text-[10px]">
                          Not detected yet
                        </Badge>
                      )}
                    </CardTitle>
                    <CardDescription className="flex items-center gap-1.5">
                      <a
                        href={`https://${integration.domain}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline"
                      >
                        {integration.domain}
                      </a>
                      <ExternalLink className="h-3 w-3" />
                    </CardDescription>
                  </div>

                  {!readOnly && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => remove.mutate(integration.id)}
                      aria-label={`Remove ${integration.name}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </CardHeader>

                <CardContent className="space-y-6">
                  <EmbedSnippet code={integration.embedCode} />

                  {!integration.installedAt && (
                    <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
                      Paste the snippet just before <code>&lt;/body&gt;</code> on your site, then
                      load the page once. This badge turns green as soon as we see it.
                    </p>
                  )}

                  {stats && <Funnel stats={stats} currency={restaurant.currency} />}

                  <div className="flex flex-wrap gap-2">
                    {!readOnly && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setEditing(integration)}
                      >
                        Customise appearance
                      </Button>
                    )}
                    <Button variant="outline" size="sm" asChild>
                      <a
                        href={`/embed/${integration.widgetKey}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Preview widget
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </Button>
                    {can('OWNER') && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground"
                        onClick={() => {
                          if (
                            confirm(
                              'Rotate the widget key?\n\nYour website will STOP taking orders until you paste the new snippet in. Only do this if the key has leaked somewhere it shouldn\'t be.',
                            )
                          ) {
                            rotate.mutate(integration.id);
                          }
                        }}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        Rotate key
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {editing && (
        <WidgetAppearance
          integration={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            invalidate();
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function EmbedSnippet({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      toast.success('Snippet copied');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy — select the code and copy it manually');
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>Paste this into your website</Label>
        <Button variant="ghost" size="sm" onClick={copy}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>

      <pre className="overflow-x-auto rounded-lg bg-slate-950 p-4 text-xs leading-relaxed text-slate-100">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** Views → opens → cart → checkout → paid. Where customers fall out. */
function Funnel({ stats, currency }: { stats: WidgetFunnel; currency: string }) {
  const steps = [
    { label: 'Saw the button', value: stats.views },
    { label: 'Opened', value: stats.opens },
    { label: 'Added to cart', value: stats.addToCart },
    { label: 'Started checkout', value: stats.checkouts },
    { label: 'Paid', value: stats.paidOrders },
  ];
  const max = Math.max(...steps.map((s) => s.value), 1);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Stat label="Revenue (30d)" value={formatMoney(stats.revenueCents, currency)} />
        <Stat label="Orders" value={String(stats.paidOrders)} />
        <Stat
          label="Conversion"
          value={stats.conversionRate === null ? '—' : `${stats.conversionRate}%`}
          hint={stats.conversionRate === null ? 'No visitors yet' : 'of people who saw the button'}
        />
      </div>

      <div className="space-y-1.5">
        {steps.map((step) => (
          <div key={step.label} className="flex items-center gap-3 text-xs">
            <span className="w-28 shrink-0 text-muted-foreground">{step.label}</span>
            <div className="h-5 flex-1 overflow-hidden rounded bg-muted">
              <div
                className="h-full rounded bg-brand"
                style={{ width: `${Math.max(2, (step.value / max) * 100)}%` }}
              />
            </div>
            <span className="w-10 shrink-0 text-right font-medium tabular-nums">{step.value}</span>
          </div>
        ))}
      </div>

      {stats.abandonedCheckouts > 3 && (
        <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {stats.abandonedCheckouts} people started checkout but didn&apos;t pay. That&apos;s usually
          a payment problem rather than a menu problem — check that Stripe is fully connected.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-lg font-bold tabular-nums">{value}</p>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
