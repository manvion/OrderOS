'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, CircleAlert, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useApi, useDashboard } from './dashboard-provider';
import { ApiRequestError, type Category, type MenuImportDraft } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/primitives';

/**
 * Photograph the menu; skip the hour of typing.
 *
 * A 60-item menu is the single most tedious step of onboarding, and it lands
 * before the restaurant has made a single sale on the platform — exactly where
 * patience runs out and onboardings die. So: one photo, Claude reads it, and the
 * owner REVIEWS the draft rather than typing from scratch.
 *
 * The review step is not decoration. Vision models misread laminate glare and
 * chalkboard specials, and a wrong price on a live menu loses money on every
 * order until someone notices. Every extracted row is editable, every unreadable
 * price is BLANK and blocks the import until a human types it, and the import
 * itself goes through the same validated create endpoints as manual entry. The
 * AI does the typing; the human stays accountable for the menu.
 */

interface DraftItem {
  name: string;
  description: string;
  /** Dollars-and-cents string for the input field, '' when the photo was unreadable. */
  price: string;
  categoryName: string;
}

export function MenuPhotoImport({ categories }: { categories: Category[] }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { restaurant, can } = useDashboard();

  const fileRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<DraftItem[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);

  // No key on the server -> no button. A button that always errors is worse
  // than no button.
  const { data: availability } = useQuery({
    queryKey: ['menu-import-availability'],
    queryFn: () => api.getMenuImportAvailability(),
    staleTime: Infinity,
  });

  const extract = useMutation({
    mutationFn: (file: File) => api.importMenuFromPhoto(file),
    onSuccess: (draft: MenuImportDraft) => {
      setItems(
        draft.categories.flatMap((category) =>
          category.items.map((item) => ({
            name: item.name,
            description: item.description ?? '',
            price: item.priceCents != null ? (item.priceCents / 100).toFixed(2) : '',
            categoryName: category.name,
          })),
        ),
      );
      setWarnings(draft.warnings);
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiRequestError ? err.body.message : 'Could not read the menu photo',
      ),
  });

  if (!restaurant || !can('MANAGER') || availability?.available === false) return null;

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) extract.mutate(file);
    // Reset so re-picking the same photo after a failure still fires.
    e.target.value = '';
  };

  /**
   * Create everything the owner approved. Categories first (skipping ones that
   * already exist, by name), then products into them — through the SAME endpoints
   * manual entry uses, so every validation rule applies identically.
   */
  const runImport = async () => {
    if (!items) return;
    setImporting(true);

    try {
      const categoryIdByName = new Map(
        categories.map((c) => [c.name.trim().toLowerCase(), c.id]),
      );

      let nextSort = categories.length;
      let created = 0;

      for (const item of items) {
        const key = item.categoryName.trim().toLowerCase();

        let categoryId = categoryIdByName.get(key);
        if (!categoryId) {
          const category = await api.createCategory({
            name: item.categoryName.trim(),
            sortOrder: nextSort++,
          });
          categoryId = category.id;
          categoryIdByName.set(key, categoryId);
        }

        await api.createProduct({
          categoryId,
          name: item.name.trim(),
          description: item.description.trim() || undefined,
          priceCents: Math.round(parseFloat(item.price) * 100),
          isAvailable: true,
        });
        created++;
      }

      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['categories'] });
      toast.success(`Imported ${created} items. Review prices once more on the live list.`);
      setItems(null);
    } catch (err) {
      // Partial imports are FINE: what was created is real and visible, what
      // wasn't is still in the dialog. Nothing is lost, nothing is duplicated
      // on retry beyond what the owner can see in front of them.
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['categories'] });
      toast.error(
        err instanceof ApiRequestError
          ? `Import stopped: ${err.body.message}. Items already imported are on your menu.`
          : 'Import stopped partway — items already imported are on your menu.',
      );
    } finally {
      setImporting(false);
    }
  };

  const patch = (index: number, changes: Partial<DraftItem>) =>
    setItems((current) =>
      current ? current.map((it, i) => (i === index ? { ...it, ...changes } : it)) : current,
    );

  const missingPrices = items?.filter((i) => !(parseFloat(i.price) > 0)).length ?? 0;

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={onPick}
      />

      <Button
        variant="outline"
        onClick={() => fileRef.current?.click()}
        disabled={extract.isPending}
      >
        {extract.isPending ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Reading the menu…
          </>
        ) : (
          <>
            <Camera className="h-4 w-4" />
            Import from photo
          </>
        )}
      </Button>

      {items && (
        <Dialog open onOpenChange={(open) => !open && !importing && setItems(null)}>
          <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                Check what we read — {items.length} item{items.length === 1 ? '' : 's'}
              </DialogTitle>
            </DialogHeader>

            <p className="text-sm text-muted-foreground">
              This is a draft read from your photo, not your live menu. Fix anything we got
              wrong — especially prices — then import. You stay in charge of what customers see.
            </p>

            {warnings.length > 0 && (
              <div className="space-y-1 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
                {warnings.map((w, i) => (
                  <p key={i} className="flex items-start gap-1.5">
                    <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {w}
                  </p>
                ))}
              </div>
            )}

            <div className="space-y-2">
              {items.map((item, i) => (
                <div key={i} className="grid grid-cols-[1fr_auto_auto] items-start gap-2">
                  <div className="min-w-0 space-y-1">
                    <Input
                      value={item.name}
                      onChange={(e) => patch(i, { name: e.target.value })}
                      placeholder="Item name"
                    />
                    <div className="flex gap-2">
                      <Input
                        value={item.categoryName}
                        onChange={(e) => patch(i, { categoryName: e.target.value })}
                        placeholder="Category"
                        className="w-40 text-xs"
                      />
                      <Input
                        value={item.description}
                        onChange={(e) => patch(i, { description: e.target.value })}
                        placeholder="Description (optional)"
                        className="flex-1 text-xs"
                      />
                    </div>
                  </div>

                  <Input
                    value={item.price}
                    onChange={(e) => patch(i, { price: e.target.value })}
                    placeholder="0.00"
                    inputMode="decimal"
                    // Red until it holds a real price. An unreadable price must be
                    // typed by a person — importing it as $0 would let customers
                    // order the dish for free.
                    className={`w-24 text-right font-mono ${
                      parseFloat(item.price) > 0 ? '' : 'border-destructive'
                    }`}
                    aria-label={`Price for ${item.name || 'item'}`}
                  />

                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setItems((c) => c?.filter((_, j) => j !== i) ?? null)}
                    aria-label={`Remove ${item.name || 'item'}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>

            <DialogFooter>
              <div className="flex w-full items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  {missingPrices > 0
                    ? `${missingPrices} item${missingPrices === 1 ? ' needs a' : 's need a'} price before importing`
                    : 'Everything has a price — ready to import'}
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setItems(null)} disabled={importing}>
                    Discard
                  </Button>
                  <Button
                    onClick={() => void runImport()}
                    disabled={importing || items.length === 0 || missingPrices > 0}
                  >
                    {importing ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Importing…
                      </>
                    ) : (
                      `Import ${items.length} item${items.length === 1 ? '' : 's'}`
                    )}
                  </Button>
                </div>
              </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
