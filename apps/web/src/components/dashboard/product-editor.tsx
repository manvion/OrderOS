'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Plus, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { useApi } from './dashboard-provider';
import { ApiRequestError, type Category, type Product } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Switch,
} from '@/components/ui/primitives';

interface DraftModifier {
  name: string;
  priceCents: number;
}

interface DraftGroup {
  name: string;
  selectionType: 'SINGLE' | 'MULTIPLE';
  required: boolean;
  minSelections: number;
  maxSelections: number;
  modifiers: DraftModifier[];
}

/**
 * Create or edit a product, including its modifier groups.
 *
 * Prices are edited in currency units (12.00) and converted to cents on submit —
 * the API only ever sees integers, but nobody wants to type 1200 for a $12 burger.
 */
export function ProductEditor({
  product,
  categories,
  currency,
  onClose,
  onSaved,
}: {
  product: Product | null;
  categories: Category[];
  currency: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const api = useApi();
  const isNew = product === null;

  const [name, setName] = useState(product?.name ?? '');
  const [description, setDescription] = useState(product?.description ?? '');
  const [price, setPrice] = useState(product ? (product.priceCents / 100).toFixed(2) : '');
  const [categoryId, setCategoryId] = useState(product?.categoryId ?? categories[0]?.id ?? '');
  const [isAvailable, setIsAvailable] = useState(product?.isAvailable ?? true);
  const [imageFile, setImageFile] = useState<File | null>(null);

  const [groups, setGroups] = useState<DraftGroup[]>(
    product?.modifierGroups.map((g) => ({
      name: g.name,
      selectionType: g.selectionType,
      required: g.required,
      minSelections: g.minSelections,
      maxSelections: g.maxSelections,
      modifiers: g.modifiers.map((m) => ({ name: m.name, priceCents: m.priceCents })),
    })) ?? [],
  );

  const addGroup = () =>
    setGroups([
      ...groups,
      {
        name: '',
        selectionType: 'SINGLE',
        required: true,
        minSelections: 1,
        maxSelections: 1,
        modifiers: [{ name: '', priceCents: 0 }],
      },
    ]);

  const updateGroup = (index: number, patch: Partial<DraftGroup>) => {
    setGroups((prev) =>
      prev.map((g, i) => {
        if (i !== index) return g;
        const next = { ...g, ...patch };

        // Keep the group internally consistent. The API enforces these too, but
        // silently fixing them here means the owner never hits a 400 they can't
        // interpret.
        if (next.selectionType === 'SINGLE') {
          next.maxSelections = 1;
          next.minSelections = next.required ? 1 : 0;
        }
        if (next.required && next.minSelections < 1) next.minSelections = 1;
        if (!next.required && patch.required === false) next.minSelections = 0;
        if (next.maxSelections < next.minSelections) next.maxSelections = next.minSelections;

        return next;
      }),
    );
  };

  const save = useMutation({
    mutationFn: async () => {
      const priceCents = Math.round(parseFloat(price || '0') * 100);

      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        priceCents,
        categoryId,
        isAvailable,
        sortOrder: product?.sortOrder ?? 0,
        modifierGroups: groups
          // Drop half-finished groups rather than rejecting the whole save.
          .filter((g) => g.name.trim() && g.modifiers.some((m) => m.name.trim()))
          .map((g, groupIndex) => ({
            name: g.name.trim(),
            selectionType: g.selectionType,
            required: g.required,
            minSelections: g.minSelections,
            maxSelections: g.maxSelections,
            sortOrder: groupIndex,
            modifiers: g.modifiers
              .filter((m) => m.name.trim())
              .map((m, i) => ({
                name: m.name.trim(),
                priceCents: m.priceCents,
                isAvailable: true,
                sortOrder: i,
              })),
          })),
      };

      const saved = isNew
        ? await api.createProduct(payload)
        : await api.updateProduct(product.id, payload);

      // The image is a second call: it's multipart, and it needs the product id,
      // which doesn't exist until the create above returns.
      if (imageFile) {
        await api.uploadProductImage(saved.id, imageFile);
      }

      return saved;
    },
    onSuccess: () => {
      toast.success(isNew ? 'Product added' : 'Product updated');
      onSaved();
    },
    onError: (err) => {
      if (err instanceof ApiRequestError && err.body.fieldErrors) {
        const first = Object.values(err.body.fieldErrors)[0];
        toast.error(first ?? err.body.message);
        return;
      }
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not save');
    },
  });

  const canSave = name.trim().length > 0 && parseFloat(price || '0') >= 0 && categoryId;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isNew ? 'Add a product' : `Edit ${product.name}`}</DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="p-name">Name</Label>
              <Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </div>
            <div className="space-y-2">
              <Label htmlFor="p-category">Category</Label>
              <Select
                id="p-category"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="p-description">Description</Label>
            <Textarea
              id="p-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="min-h-[60px]"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="p-price">Price ({currency})</Label>
              <Input
                id="p-price"
                type="number"
                step="0.01"
                min="0"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="12.00"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="p-image">Photo</Label>
              <label className="flex h-10 cursor-pointer items-center gap-2 rounded-md border border-input px-3 text-sm text-muted-foreground hover:bg-accent">
                <Upload className="h-4 w-4" />
                <span className="truncate">{imageFile?.name ?? 'Choose an image'}</span>
                <input
                  id="p-image"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={(e) => setImageFile(e.target.files?.[0] ?? null)}
                />
              </label>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium">Available</p>
              <p className="text-xs text-muted-foreground">
                Sold-out items are hidden from the storefront.
              </p>
            </div>
            <Switch checked={isAvailable} onCheckedChange={setIsAvailable} />
          </div>

          {/* Modifier groups */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold">Options</h3>
                <p className="text-xs text-muted-foreground">
                  Size, extras, cooking preference — anything the customer chooses.
                </p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={addGroup}>
                <Plus className="h-3.5 w-3.5" />
                Add group
              </Button>
            </div>

            {groups.map((group, groupIndex) => (
              <div key={groupIndex} className="space-y-3 rounded-lg border p-4">
                <div className="flex items-center gap-2">
                  <Input
                    value={group.name}
                    onChange={(e) => updateGroup(groupIndex, { name: e.target.value })}
                    placeholder="Group name (e.g. Size)"
                    className="h-9"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => setGroups(groups.filter((_, i) => i !== groupIndex))}
                    aria-label="Remove group"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <Select
                    value={group.selectionType}
                    onChange={(e) =>
                      updateGroup(groupIndex, {
                        selectionType: e.target.value as 'SINGLE' | 'MULTIPLE',
                      })
                    }
                    className="h-9 text-sm"
                  >
                    <option value="SINGLE">Choose one</option>
                    <option value="MULTIPLE">Choose several</option>
                  </Select>

                  <label className="flex h-9 items-center gap-2 text-sm">
                    <Switch
                      checked={group.required}
                      onCheckedChange={(required) => updateGroup(groupIndex, { required })}
                    />
                    Required
                  </label>

                  {group.selectionType === 'MULTIPLE' && (
                    <div className="flex h-9 items-center gap-2">
                      <span className="whitespace-nowrap text-xs text-muted-foreground">
                        Max
                      </span>
                      <Input
                        type="number"
                        min={1}
                        max={20}
                        value={group.maxSelections}
                        onChange={(e) =>
                          updateGroup(groupIndex, {
                            maxSelections: Math.max(1, Number(e.target.value)),
                          })
                        }
                        className="h-9"
                      />
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  {group.modifiers.map((modifier, modifierIndex) => (
                    <div key={modifierIndex} className="flex gap-2">
                      <Input
                        value={modifier.name}
                        onChange={(e) => {
                          const next = [...groups];
                          next[groupIndex].modifiers[modifierIndex].name = e.target.value;
                          setGroups(next);
                        }}
                        placeholder="Option name (e.g. Large)"
                        className="h-9"
                      />
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        value={(modifier.priceCents / 100).toFixed(2)}
                        onChange={(e) => {
                          const next = [...groups];
                          next[groupIndex].modifiers[modifierIndex].priceCents = Math.round(
                            parseFloat(e.target.value || '0') * 100,
                          );
                          setGroups(next);
                        }}
                        className="h-9 w-24"
                        placeholder="0.00"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={() => {
                          const next = [...groups];
                          next[groupIndex].modifiers = next[groupIndex].modifiers.filter(
                            (_, i) => i !== modifierIndex,
                          );
                          setGroups(next);
                        }}
                        aria-label="Remove option"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}

                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const next = [...groups];
                      next[groupIndex].modifiers.push({ name: '', priceCents: 0 });
                      setGroups(next);
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add option
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={!canSave || save.isPending}>
            {save.isPending ? 'Saving…' : isNew ? 'Add product' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
