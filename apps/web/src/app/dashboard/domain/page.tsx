'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  Copy,
  ExternalLink,
  Globe,
  Loader2,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { useApi, useDashboard } from '@/components/dashboard/dashboard-provider';
import { ApiRequestError, type CustomDomain } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge, Label, Skeleton } from '@/components/ui/primitives';

/**
 * "Use my own domain."
 *
 * We do NOT sell domains — the owner buys `joesburgers.com` wherever they like.
 * Our job is the part they can't do: attach it, tell them exactly which records to
 * paste into their registrar, and then watch DNS until it goes live.
 *
 * That instruction is the entire product here. "Add a CNAME record" is precisely
 * where a non-technical restaurant owner gives up and phones you. So we compute the
 * exact record — apex domains need an A record and CANNOT take a CNAME, which is a
 * DNS rule most people don't know and the single most common way this silently
 * fails — and show it as a copyable table with their registrar's field names.
 */
export default function DomainPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { restaurant, can } = useDashboard();

  const [domain, setDomain] = useState('');

  const { data: domains, isLoading } = useQuery({
    queryKey: ['domains', restaurant?.id],
    queryFn: () => api.listDomains(),
    enabled: Boolean(restaurant),
    // While a domain is pending, poll — DNS lands when it lands, and the owner
    // shouldn't have to refresh to find out.
    refetchInterval: (query) =>
      query.state.data?.some((d) => d.status !== 'ACTIVE') ? 15_000 : false,
  });

  const add = useMutation({
    mutationFn: () => api.addDomain(domain.trim()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['domains'] });
      setDomain('');
      toast.success('Domain added. Now add the DNS records below at your registrar.');
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not add the domain'),
  });

  const check = useMutation({
    mutationFn: (id: string) => api.checkDomain(id),
    onSuccess: (d) => {
      void queryClient.invalidateQueries({ queryKey: ['domains'] });
      toast[d.status === 'ACTIVE' ? 'success' : 'info'](
        d.status === 'ACTIVE'
          ? 'Your domain is live!'
          : "DNS isn't pointing at us yet. It can take up to an hour — we'll keep checking.",
      );
    },
    onError: () => toast.error('Could not check the domain'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.removeDomain(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['domains'] });
      toast.success('Domain removed.');
    },
    onError: () => toast.error('Could not remove the domain'),
  });

  if (!restaurant) return null;
  const readOnly = !can('OWNER');

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Your own domain</h1>
        <p className="text-sm text-muted-foreground">
          Serve your ordering page at <strong>joesburgers.com</strong> instead of{' '}
          {restaurant.slug}.dinedirect.manvion.ca.
        </p>
      </div>

      {!readOnly && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Connect a domain you own</CardTitle>
            <CardDescription>
              Buy it from any registrar (Namecheap, GoDaddy, Cloudflare — it doesn&apos;t matter
              to us). Then bring it here and we&apos;ll do the rest, including the HTTPS
              certificate.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Input
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="joesburgers.com"
                className="min-w-64 flex-1"
              />
              <Button onClick={() => add.mutate()} disabled={domain.trim().length < 4 || add.isPending}>
                {add.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Adding…
                  </>
                ) : (
                  <>
                    <Globe className="h-4 w-4" />
                    Connect
                  </>
                )}
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">
              Works for a bare domain (<code>joesburgers.com</code>) or a subdomain (
              <code>order.joesburgers.com</code>).
            </p>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : !domains?.length ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Globe className="mx-auto h-10 w-10 text-muted-foreground" />
            <p className="mt-4 font-medium">No custom domain yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Your page is live at{' '}
              <span className="font-mono">{restaurant.slug}.dinedirect.manvion.ca</span> — that works
              perfectly well. A custom domain is for when you want your own name on it.
            </p>
          </CardContent>
        </Card>
      ) : (
        domains.map((d) => <DomainCard key={d.id} domain={d} readOnly={readOnly} onCheck={() => check.mutate(d.id)} onRemove={() => remove.mutate(d.id)} checking={check.isPending} />)
      )}
    </div>
  );
}

function DomainCard({
  domain: d,
  readOnly,
  checking,
  onCheck,
  onRemove,
}: {
  domain: CustomDomain;
  readOnly: boolean;
  checking: boolean;
  onCheck: () => void;
  onRemove: () => void;
}) {
  const isLive = d.status === 'ACTIVE';

  return (
    <Card className={isLive ? 'border-emerald-200' : undefined}>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <span className="font-mono">{d.domain}</span>
            {isLive ? (
              <Badge variant="success" className="gap-1">
                <Check className="h-3 w-3" />
                Live
              </Badge>
            ) : (
              <Badge variant="warning">Waiting for DNS</Badge>
            )}
          </CardTitle>

          {isLive && (
            <CardDescription>
              <a
                href={`https://${d.domain}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 hover:underline"
              >
                Open your site
                <ExternalLink className="h-3 w-3" />
              </a>
            </CardDescription>
          )}
        </div>

        {!readOnly && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            onClick={onRemove}
            aria-label={`Remove ${d.domain}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {isLive ? (
          <div className="space-y-1 rounded-xl bg-emerald-50 p-4 text-sm text-emerald-900">
            <p className="font-medium">Everything&apos;s working.</p>
            <p className="text-emerald-800">
              HTTPS is on, and Apple Pay is
              {d.applePayRegistered ? ' enabled' : ' still being set up'} for this domain.
            </p>
          </div>
        ) : (
          <>
            {/*
              THE INSTRUCTION. This is the whole feature.

              An apex domain (joesburgers.com) needs an A record and CANNOT take a
              CNAME — a DNS rule, not our choice, and the single most common reason
              a custom domain silently never resolves. So we compute the exact
              record rather than letting the owner guess, and we label the columns
              the way registrars label them.
            */}
            <div>
              <Label>Add these records at your registrar</Label>
              <p className="mt-1 text-xs text-muted-foreground">
                Log in wherever you bought the domain, find &ldquo;DNS&rdquo; or &ldquo;Nameservers
                &rdquo;, and add exactly this:
              </p>
            </div>

            <div className="overflow-x-auto rounded-xl border">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="p-3 font-medium">Type</th>
                    <th className="p-3 font-medium">Name / Host</th>
                    <th className="p-3 font-medium">Value / Points to</th>
                    <th className="p-3" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {(d.dnsRecords ?? []).map((r, i) => (
                    <tr key={i}>
                      <td className="p-3 font-mono font-semibold">{r.type}</td>
                      <td className="p-3 font-mono">{r.name}</td>
                      <td className="p-3 font-mono">{r.value}</td>
                      <td className="p-3">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => {
                            void navigator.clipboard.writeText(r.value);
                            toast.success('Copied');
                          }}
                          aria-label="Copy value"
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="rounded-lg bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
              DNS changes can take a few minutes — occasionally up to an hour, depending on your
              registrar. <strong>You can close this page.</strong> We keep checking, and your
              domain switches itself on the moment it&apos;s ready.
            </p>

            <Button variant="outline" size="sm" onClick={onCheck} disabled={checking}>
              <RefreshCw className={`h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} />
              {checking ? 'Checking…' : "I've added them — check now"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
