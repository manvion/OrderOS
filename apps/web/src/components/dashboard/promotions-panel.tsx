'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Percent, Plus, Tag, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { formatMoney } from '@dinedirect/shared';
import { useApi, useDashboard } from '@/components/dashboard/dashboard-provider';
import { ApiRequestError, type Promotion } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { Label, Skeleton, Switch } from '@/components/ui/primitives';

/** value is basis points for PERCENT (500 = 5%), cents for FIXED. */
export function PromotionsPanel() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { restaurant, can } = useDashboard();
  const readOnly = !can('MANAGER');

  const [name, setName] = useState('');
  const [type, setType] = useState<'PERCENT' | 'FIXED'>('PERCENT');
  const [amount, setAmount] = useState('');
  const [code, setCode] = useState('');
  const [minSubtotal, setMinSubtotal] = useState('');
  const [scope, setScope] = useState<'ORDER' | 'ITEMS'>('ORDER');
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);

  const { data: promotions, isLoading } = useQuery({
    queryKey: ['promotions', restaurant?.id],
    queryFn: () => api.listPromotions(),
    enabled: Boolean(restaurant),
  });

  const { data: products } = useQuery({
    queryKey: ['products', restaurant?.id],
    queryFn: () => api.listProducts(),
    enabled: Boolean(restaurant),
  });
  const productName = (id: string) => products?.find((p) => p.id === id)?.name ?? id;

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['promotions'] });

  const create = useMutation({
    mutationFn: () =>
      api.createPromotion({
        name: name.trim(),
        type,
        // PERCENT: 10 (%) -> 1000 bps. FIXED: 5.00 (currency) -> 500 cents.
        // Same "* 100" either way -- just two different units of "hundredths".
        value: Math.round(Number(amount) * 100),
        code: code.trim() || undefined,
        productIds: scope === 'ITEMS' ? selectedProductIds : [],
        minSubtotalCents: minSubtotal ? Math.round(Number(minSubtotal) * 100) : 0,
      }),
    onSuccess: () => {
      invalidate();
      setName('');
      setAmount('');
      setCode('');
      setMinSubtotal('');
      setScope('ORDER');
      setSelectedProductIds([]);
      toast.success('Promotion created');
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not create the promotion'),
  });

  const setActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.setPromotionActive(id, isActive),
    onSuccess: invalidate,
    onError: () => toast.error('Could not update the promotion'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deletePromotion(id),
    onSuccess: () => {
      invalidate();
      toast.success('Promotion deleted');
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not delete'),
  });

  if (!restaurant) return null;

  const canCreate =
    name.trim().length > 0 &&
    Number(amount) > 0 &&
    (scope === 'ORDER' || selectedProductIds.length > 0);

  return (
    <div className="space-y-6">
      {!readOnly && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Create a promotion</CardTitle>
            <CardDescription>
              Leave the code blank to apply it automatically to every qualifying order —
              set one and customers type it in at checkout.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="promo-name">Name</Label>
                <Input
                  id="promo-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Weekend deal"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="promo-type">Type</Label>
                <Select
                  id="promo-type"
                  value={type}
                  onChange={(e) => setType(e.target.value as typeof type)}
                >
                  <option value="PERCENT">Percent off</option>
                  <option value="FIXED">Fixed amount off</option>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="promo-amount">
                  {type === 'PERCENT' ? 'Percent off' : `Amount off (${restaurant.currency})`}
                </Label>
                <Input
                  id="promo-amount"
                  type="number"
                  min={0}
                  step={type === 'PERCENT' ? 1 : 0.01}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder={type === 'PERCENT' ? '10' : '5.00'}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="promo-code">Code (optional)</Label>
                <Input
                  id="promo-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="Blank = automatic"
                  className="uppercase placeholder:normal-case"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="promo-min">Minimum order ({restaurant.currency}, optional)</Label>
                <Input
                  id="promo-min"
                  type="number"
                  min={0}
                  step={0.01}
                  value={minSubtotal}
                  onChange={(e) => setMinSubtotal(e.target.value)}
                  placeholder="0"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Applies to</Label>
              <div className="inline-flex rounded-lg border bg-muted/40 p-1">
                {(['ORDER', 'ITEMS'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setScope(s)}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                      scope === s
                        ? 'bg-background text-foreground shadow-soft'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {s === 'ORDER' ? 'Whole order' : 'Specific items'}
                  </button>
                ))}
              </div>

              {scope === 'ITEMS' && (
                <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border p-2">
                  {products?.length ? (
                    products.map((p) => (
                      <label
                        key={p.id}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
                      >
                        <input
                          type="checkbox"
                          checked={selectedProductIds.includes(p.id)}
                          onChange={(e) =>
                            setSelectedProductIds((ids) =>
                              e.target.checked ? [...ids, p.id] : ids.filter((id) => id !== p.id),
                            )
                          }
                          className="h-4 w-4 rounded border-input accent-brand"
                        />
                        {p.name}
                      </label>
                    ))
                  ) : (
                    <p className="p-2 text-sm text-muted-foreground">No menu items yet.</p>
                  )}
                </div>
              )}
            </div>

            <Button onClick={() => create.mutate()} disabled={!canCreate || create.isPending}>
              <Plus className="h-4 w-4" />
              {create.isPending ? 'Creating…' : 'Create promotion'}
            </Button>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : !promotions?.length ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Tag className="mx-auto h-10 w-10 text-muted-foreground" />
            <p className="mt-4 font-medium">No promotions yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Run a percent-off weekend deal or a code for regulars.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {promotions.map((promo: Promotion) => (
            <Card key={promo.id} className={promo.isActive ? '' : 'opacity-60'}>
              <CardContent className="space-y-3 p-5">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-subtle text-brand">
                      <Percent className="h-4 w-4" />
                    </span>
                    <div>
                      <p className="font-semibold leading-tight">{promo.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {promo.type === 'PERCENT'
                          ? `${promo.value / 100}% off`
                          : `${formatMoney(promo.value, restaurant.currency)} off`}
                      </p>
                    </div>
                  </div>
                  {!readOnly && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => remove.mutate(promo.id)}
                      aria-label={`Delete ${promo.name}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>

                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="rounded-full bg-brand-subtle px-2.5 py-1 font-medium text-brand">
                    {promo.code ? promo.code : 'Automatic'}
                  </span>
                  {promo.minSubtotalCents > 0 && (
                    <span className="rounded-full border px-2.5 py-1 text-muted-foreground">
                      Min {formatMoney(promo.minSubtotalCents, restaurant.currency)}
                    </span>
                  )}
                  <span className="rounded-full border px-2.5 py-1 text-muted-foreground">
                    {promo.redemptions} used
                  </span>
                </div>

                {promo.productIds.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Tags: {promo.productIds.map(productName).join(', ')}
                  </p>
                )}

                {!readOnly && (
                  <label className="flex items-center justify-between border-t pt-3 text-sm">
                    <span className="text-muted-foreground">Active</span>
                    <Switch
                      checked={promo.isActive}
                      onCheckedChange={(isActive) => setActive.mutate({ id: promo.id, isActive })}
                    />
                  </label>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
