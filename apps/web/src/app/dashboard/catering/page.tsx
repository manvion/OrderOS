'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Check, Loader2, Mail, Phone, Plus, Trash2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { formatMoney } from '@dinedirect/shared';
import { useApi, useDashboard, useRequireRole } from '@/components/dashboard/dashboard-provider';
import { PlanGate } from '@/components/dashboard/plan-gate';
import {
  ApiRequestError,
  type CateringPackage,
  type CateringRequest,
  type CateringStatus,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Badge, Label, Skeleton } from '@/components/ui/primitives';

const STATUSES: CateringStatus[] = ['NEW', 'IN_PROGRESS', 'CONFIRMED', 'COMPLETED', 'CANCELLED'];
const STATUS_LABEL: Record<CateringStatus, string> = {
  NEW: 'New',
  IN_PROGRESS: 'In progress',
  CONFIRMED: 'Confirmed',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export default function CateringPage() {
  return (
    <PlanGate capability="CATERING">
      <CateringInner />
    </PlanGate>
  );
}

function CateringInner() {
  const { restaurant } = useDashboard();
  useRequireRole('MANAGER', '/dashboard');
  const api = useApi();
  const currency = restaurant?.currency ?? 'USD';

  const { data: requests, isLoading: loadingRequests } = useQuery({
    queryKey: ['catering', 'requests', restaurant?.id],
    queryFn: () => api.listCateringRequests(),
    enabled: Boolean(restaurant),
  });

  const { data: packages, isLoading: loadingPackages } = useQuery({
    queryKey: ['catering', 'packages', restaurant?.id],
    queryFn: () => api.listCateringPackages(),
    enabled: Boolean(restaurant),
  });

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Catering & parties</h1>
        <p className="text-sm text-muted-foreground">
          Party packages your customers pay for online, plus custom enquiries to quote.
        </p>
      </div>

      {/* Requests inbox — the thing you check. */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Enquiries & orders
        </h2>
        {loadingRequests ? (
          <Skeleton className="h-40 w-full" />
        ) : !requests?.length ? (
          <Card>
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              No catering enquiries yet. Add a package below and it appears on your storefront.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {requests.map((r) => (
              <RequestCard key={r.id} request={r} currency={currency} />
            ))}
          </div>
        )}
      </section>

      {/* Packages management. */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Your packages
        </h2>
        <AddPackage currency={currency} />
        {loadingPackages ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          packages?.map((p) => <PackageRow key={p.id} pkg={p} currency={currency} />)
        )}
      </section>
    </div>
  );
}

function RequestCard({ request, currency }: { request: CateringRequest; currency: string }) {
  const queryClient = useQueryClient();
  const api = useApi();

  const setStatus = useMutation({
    mutationFn: (status: CateringStatus) => api.setCateringRequestStatus(request.id, status),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['catering', 'requests'] });
      toast.success('Status updated');
    },
    onError: () => toast.error('Could not update the status'),
  });

  const eventDate = new Date(request.eventDate).toLocaleDateString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  return (
    <Card>
      <CardContent className="space-y-3 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Badge variant={request.type === 'PACKAGE' ? 'info' : 'secondary'}>
                {request.type === 'PACKAGE' ? 'Package' : 'Custom quote'}
              </Badge>
              {request.type === 'PACKAGE' && (
                <Badge variant={request.paymentStatus === 'PAID' ? 'success' : 'warning'}>
                  {request.paymentStatus === 'PAID' ? 'Paid' : 'Unpaid'}
                </Badge>
              )}
            </div>
            <p className="mt-1.5 font-semibold">
              {request.packageName ?? 'Custom catering'}
              {request.totalCents != null && (
                <span className="ml-2 tabular-nums text-muted-foreground">
                  {formatMoney(request.totalCents, currency)}
                </span>
              )}
            </p>
          </div>

          <Select
            value={request.status}
            onChange={(e) => setStatus.mutate(e.target.value as CateringStatus)}
            disabled={setStatus.isPending}
            className="h-9 w-40"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
        </div>

        <div className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
          <span className="flex items-center gap-2">
            <Users className="h-3.5 w-3.5 text-muted-foreground" />
            {request.headCount} people
          </span>
          <span className="flex items-center gap-2">
            <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
            {eventDate} · {request.fulfillment === 'DELIVERY' ? 'Delivery' : 'Pickup'}
          </span>
          <span className="font-medium">{request.customerName}</span>
          <span className="flex items-center gap-3 text-muted-foreground">
            <a href={`tel:${request.customerPhone}`} className="flex items-center gap-1 hover:underline">
              <Phone className="h-3 w-3" />
              {request.customerPhone}
            </a>
            <a href={`mailto:${request.customerEmail}`} className="flex items-center gap-1 hover:underline">
              <Mail className="h-3 w-3" />
              Email
            </a>
          </span>
        </div>

        {request.deliveryAddress && (
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Deliver to:</span> {request.deliveryAddress}
          </p>
        )}
        {request.message && (
          <p className="rounded-lg bg-muted/50 p-3 text-sm">{request.message}</p>
        )}
      </CardContent>
    </Card>
  );
}

function AddPackage({ currency }: { currency: string }) {
  const queryClient = useQueryClient();
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [minPeople, setMinPeople] = useState('10');

  const create = useMutation({
    mutationFn: () =>
      api.createCateringPackage({
        name: name.trim(),
        description: description.trim() || null,
        pricePerPersonCents: Math.round(parseFloat(price || '0') * 100),
        minPeople: Math.max(1, Math.round(Number(minPeople) || 1)),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['catering', 'packages'] });
      toast.success('Package added');
      setName('');
      setDescription('');
      setPrice('');
      setMinPeople('10');
      setOpen(false);
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not add the package'),
  });

  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" />
        Add a package
      </Button>
    );
  }

  const canSave = name.trim().length > 0 && parseFloat(price || '0') > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">New package</CardTitle>
        <CardDescription>Priced per person — the customer multiplies it by headcount.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="cp-name">Name</Label>
          <Input id="cp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Taco bar" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="cp-desc">What's included (optional)</Label>
          <Textarea
            id="cp-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Build-your-own tacos, three proteins, sides, salsas."
            className="min-h-[60px]"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="cp-price">Price per person ({currency})</Label>
            <Input
              id="cp-price"
              type="number"
              step="0.01"
              min="0"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="18.00"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cp-min">Minimum people</Label>
            <Input
              id="cp-min"
              type="number"
              min="1"
              value={minPeople}
              onChange={(e) => setMinPeople(e.target.value)}
            />
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => create.mutate()} disabled={!canSave || create.isPending}>
            {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Add package
          </Button>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function PackageRow({ pkg, currency }: { pkg: CateringPackage; currency: string }) {
  const queryClient = useQueryClient();
  const api = useApi();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['catering', 'packages'] });

  const toggle = useMutation({
    mutationFn: () => api.updateCateringPackage(pkg.id, { isActive: !pkg.isActive }),
    onSuccess: refresh,
    onError: () => toast.error('Could not update the package'),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteCateringPackage(pkg.id),
    onSuccess: () => {
      refresh();
      toast.success('Package removed');
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not remove it'),
  });

  return (
    <Card className={pkg.isActive ? '' : 'opacity-60'}>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="font-semibold">
            {pkg.name}
            {!pkg.isActive && <span className="ml-2 text-xs text-muted-foreground">(hidden)</span>}
          </p>
          <p className="text-sm text-muted-foreground">
            {formatMoney(pkg.pricePerPersonCents, currency)}/person · min {pkg.minPeople}
            {pkg.maxPeople ? `–${pkg.maxPeople}` : ''} people
          </p>
          {pkg.description && (
            <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{pkg.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => toggle.mutate()} disabled={toggle.isPending}>
            {pkg.isActive ? 'Hide' : 'Show'}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
            aria-label={`Remove ${pkg.name}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
