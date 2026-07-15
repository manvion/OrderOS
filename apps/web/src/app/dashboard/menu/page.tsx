'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Sparkles, Trash2 } from 'lucide-react';
import { formatMoney } from '@dinedirect/shared';
import { toast } from 'sonner';
import { useApi, useDashboard, useRequireRole } from '@/components/dashboard/dashboard-provider';
import { ApiRequestError, type Product } from '@/lib/api';
import { MenuPhotoImport } from '@/components/dashboard/menu-photo-import';
import { ProductEditor } from '@/components/dashboard/product-editor';
import { PromotionsPanel } from '@/components/dashboard/promotions-panel';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge, Skeleton, Switch } from '@/components/ui/primitives';

export default function MenuPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { restaurant, can } = useDashboard();
  useRequireRole('MANAGER', '/dashboard/kitchen');

  const [tab, setTab] = useState<'items' | 'promotions'>('items');
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [newCategory, setNewCategory] = useState('');

  const { data: categories, isLoading: loadingCategories } = useQuery({
    queryKey: ['categories', restaurant?.id],
    queryFn: () => api.listCategories(),
    enabled: Boolean(restaurant),
  });

  const { data: products, isLoading: loadingProducts } = useQuery({
    queryKey: ['products', restaurant?.id],
    queryFn: () => api.listProducts(),
    enabled: Boolean(restaurant),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['products'] });
    void queryClient.invalidateQueries({ queryKey: ['categories'] });
  };

  const [bulkFillProgress, setBulkFillProgress] = useState<{ done: number; total: number } | null>(
    null,
  );

  /**
   * Sweeps every item with no description, one at a time -- sequential on
   * purpose, so it never fires more than one request at once against the
   * free-model ladder's throttle. One item's failure (a model having a bad
   * moment) doesn't stop the rest of the sweep.
   */
  const bulkFillDescriptions = useMutation({
    mutationFn: async () => {
      const targets = (products ?? []).filter((p) => !p.description?.trim());
      setBulkFillProgress({ done: 0, total: targets.length });
      for (const [i, product] of targets.entries()) {
        const categoryName = categories?.find((c) => c.id === product.categoryId)?.name;
        try {
          const { description } = await api.generateProductDescription(product.name, categoryName);
          await api.updateProduct(product.id, { description });
        } catch {
          // Keep going -- one bad item shouldn't stop the sweep.
        }
        setBulkFillProgress({ done: i + 1, total: targets.length });
      }
    },
    onSuccess: () => {
      invalidate();
      toast.success('Descriptions filled in');
    },
    onError: () => toast.error('Something went wrong filling descriptions'),
    onSettled: () => setBulkFillProgress(null),
  });

  const missingDescriptionCount = (products ?? []).filter((p) => !p.description?.trim()).length;

  const createCategory = useMutation({
    mutationFn: (name: string) => api.createCategory({ name, sortOrder: categories?.length ?? 0 }),
    onSuccess: () => {
      invalidate();
      setNewCategory('');
      toast.success('Category added');
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not add the category'),
  });

  const deleteCategory = useMutation({
    mutationFn: (id: string) => api.deleteCategory(id),
    onSuccess: () => {
      invalidate();
      toast.success('Category deleted');
    },
    // The API refuses to delete a category that still holds products, and says so.
    // Surface that message verbatim rather than a generic failure.
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not delete'),
  });

  /**
   * The 86 switch. Optimistic on purpose: when the kitchen runs out of salmon
   * they hit this and immediately move on — waiting on a round trip to see the
   * toggle flip is exactly the friction that makes people not bother.
   */
  const setAvailability = useMutation({
    mutationFn: ({ id, isAvailable }: { id: string; isAvailable: boolean }) =>
      api.setProductAvailability(id, isAvailable),
    onMutate: async ({ id, isAvailable }) => {
      await queryClient.cancelQueries({ queryKey: ['products'] });
      const previous = queryClient.getQueryData<Product[]>(['products', restaurant?.id]);
      queryClient.setQueryData<Product[]>(['products', restaurant?.id], (old) =>
        old?.map((p) => (p.id === id ? { ...p, isAvailable } : p)),
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      // Roll back — the toggle must never lie about what customers can order.
      queryClient.setQueryData(['products', restaurant?.id], context?.previous);
      toast.error('Could not update availability');
    },
    onSettled: () => invalidate(),
  });

  const deleteProduct = useMutation({
    mutationFn: (id: string) => api.deleteProduct(id),
    onSuccess: () => {
      invalidate();
      toast.success('Product deleted');
    },
    onError: () => toast.error('Could not delete the product'),
  });

  if (!restaurant) return null;
  const readOnly = !can('MANAGER');

  if (loadingCategories || loadingProducts) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Menu</h1>
          <p className="text-sm text-muted-foreground">
            {products?.length ?? 0} items across {categories?.length ?? 0} categories
          </p>
        </div>
        {!readOnly && tab === 'items' && (
          <div className="flex flex-wrap gap-2">
            {/* One photo instead of an hour of typing. Renders nothing when the
                server has no vision key — see MenuPhotoImport. */}
            <MenuPhotoImport categories={categories ?? []} />
            {missingDescriptionCount > 0 && (
              <Button
                variant="outline"
                onClick={() => bulkFillDescriptions.mutate()}
                disabled={bulkFillDescriptions.isPending}
              >
                <Sparkles className="h-4 w-4" />
                {bulkFillProgress
                  ? `Filling ${bulkFillProgress.done}/${bulkFillProgress.total}…`
                  : `AI fill ${missingDescriptionCount} description${missingDescriptionCount === 1 ? '' : 's'}`}
              </Button>
            )}
            <Button onClick={() => setEditing('new')} disabled={!categories?.length}>
              <Plus className="h-4 w-4" />
              Add product
            </Button>
          </div>
        )}
      </div>

      <div className="inline-flex rounded-lg border bg-muted/40 p-1">
        {(['items', 'promotions'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium capitalize transition-colors ${
              tab === t
                ? 'bg-background text-foreground shadow-soft'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'promotions' && <PromotionsPanel />}

      {tab === 'items' && !categories?.length && (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="font-medium">Start with a category</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Burgers, Sides, Drinks — however you group your menu.
            </p>
          </CardContent>
        </Card>
      )}

      {tab === 'items' && !readOnly && (
        <Card>
          <CardContent className="flex gap-2 p-4">
            <Input
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              placeholder="New category name"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newCategory.trim()) {
                  createCategory.mutate(newCategory.trim());
                }
              }}
            />
            <Button
              variant="outline"
              onClick={() => newCategory.trim() && createCategory.mutate(newCategory.trim())}
              disabled={!newCategory.trim() || createCategory.isPending}
            >
              Add
            </Button>
          </CardContent>
        </Card>
      )}

      <div className={tab === 'items' ? 'space-y-6' : 'hidden'}>
        {categories?.map((category) => {
          const items = products?.filter((p) => p.categoryId === category.id) ?? [];

          return (
            <div key={category.id}>
              <div className="flex items-center justify-between gap-2 pb-3">
                <h2 className="font-semibold">
                  {category.name}
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    {items.length}
                  </span>
                </h2>
                {!readOnly && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    onClick={() => deleteCategory.mutate(category.id)}
                    aria-label={`Delete ${category.name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>

              {items.length === 0 ? (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  Nothing in {category.name} yet.
                </p>
              ) : (
                <div className="space-y-2">
                  {items.map((product) => (
                    <Card key={product.id}>
                      <CardContent className="flex flex-wrap items-center gap-4 p-4">
                        <button
                          className="min-w-0 flex-1 text-left"
                          onClick={() => !readOnly && setEditing(product)}
                          disabled={readOnly}
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{product.name}</span>
                            {product.modifierGroups.length > 0 && (
                              <Badge variant="outline" className="text-[10px]">
                                {product.modifierGroups.length} option
                                {product.modifierGroups.length === 1 ? '' : 's'}
                              </Badge>
                            )}
                          </div>
                          {product.description && (
                            <p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground">
                              {product.description}
                            </p>
                          )}
                        </button>

                        <span className="font-semibold tabular-nums">
                          {formatMoney(product.priceCents, restaurant.currency)}
                        </span>

                        <div className="flex items-center gap-3">
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={product.isAvailable}
                              onCheckedChange={(isAvailable) =>
                                setAvailability.mutate({ id: product.id, isAvailable })
                              }
                              aria-label={`${product.name} availability`}
                            />
                            <span className="w-16 text-xs text-muted-foreground">
                              {product.isAvailable ? 'Available' : 'Sold out'}
                            </span>
                          </div>

                          {!readOnly && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-destructive"
                              onClick={() => deleteProduct.mutate(product.id)}
                              aria-label={`Delete ${product.name}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {editing && categories && (
        <ProductEditor
          product={editing === 'new' ? null : editing}
          categories={categories}
          currency={restaurant.currency}
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
