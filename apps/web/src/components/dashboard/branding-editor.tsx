'use client';

import { useRef, useState } from 'react';
import Image from 'next/image';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { toast } from 'sonner';
import { useApi, useDashboard } from './dashboard-provider';
import { ApiRequestError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/primitives';

/**
 * Logo and brand colours.
 *
 * The upload endpoint has existed since the first commit with nothing calling it —
 * so every restaurant on the platform was logo-less, and the setup checklist told
 * them to "add your logo" while offering no way to do it. That is worse than not
 * having the feature: it's a promise the product can't keep.
 *
 * The colour set here is what drives `--brand` across the storefront, the widget
 * and every email we send, which is why a live preview matters more than it looks
 * like it should.
 */
export function BrandingEditor() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { restaurant, can } = useDashboard();
  const fileRef = useRef<HTMLInputElement>(null);

  const [primary, setPrimary] = useState(restaurant?.brandPrimaryColor ?? '#EA580C');

  const upload = useMutation({
    mutationFn: (file: File) => api.uploadLogo(file),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.success('Logo updated — it appears on your page, emails and receipts.');
    },
    onError: (err) =>
      // The API enforces type and size (5MB, jpg/png/webp/svg) and says which
      // rule was broken. Pass that through rather than a generic failure.
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not upload the logo'),
  });

  const saveColor = useMutation({
    mutationFn: () => api.updateCurrent({ brandPrimaryColor: primary }),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.success('Brand colour saved');
    },
    onError: () => toast.error('Could not save the colour'),
  });

  if (!restaurant) return null;
  const readOnly = !can('MANAGER');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Your brand</CardTitle>
        <CardDescription>
          Used on your ordering page, your QR codes, the widget on your own website, and every
          email we send your customers.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="flex flex-wrap items-center gap-5">
          {restaurant.logoUrl ? (
            <Image
              src={restaurant.logoUrl}
              alt=""
              width={72}
              height={72}
              className="h-18 w-18 rounded-2xl border object-cover"
              style={{ width: 72, height: 72 }}
            />
          ) : (
            <div
              className="flex h-18 w-18 items-center justify-center rounded-2xl text-2xl font-bold text-white"
              style={{ width: 72, height: 72, background: primary }}
            >
              {restaurant.name.charAt(0)}
            </div>
          )}

          <div className="space-y-1.5">
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/svg+xml"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) upload.mutate(file);
                // Reset, so picking the SAME file again after a failed upload
                // still fires a change event.
                e.target.value = '';
              }}
            />

            <Button
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
              disabled={readOnly || upload.isPending}
            >
              <Upload className="h-3.5 w-3.5" />
              {upload.isPending
                ? 'Uploading…'
                : restaurant.logoUrl
                  ? 'Replace logo'
                  : 'Upload a logo'}
            </Button>
            <p className="text-xs text-muted-foreground">
              Square works best. PNG, JPG, WebP or SVG, up to 5MB.
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="brand-color">Brand colour</Label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id="brand-color"
              type="color"
              value={primary}
              onChange={(e) => setPrimary(e.target.value.toUpperCase())}
              disabled={readOnly}
              className="h-10 w-12 cursor-pointer rounded-lg border"
            />
            <Input
              value={primary}
              onChange={(e) => setPrimary(e.target.value.toUpperCase())}
              disabled={readOnly}
              className="w-32 font-mono"
            />

            {/* Live preview of the one thing this colour actually does: the button
                customers press to spend money. */}
            <span
              className="rounded-lg px-4 py-2 text-sm font-semibold text-white"
              style={{ background: primary }}
            >
              Add to cart
            </span>

            {!readOnly && primary !== restaurant.brandPrimaryColor && (
              <Button size="sm" onClick={() => saveColor.mutate()} disabled={saveColor.isPending}>
                {saveColor.isPending ? 'Saving…' : 'Save'}
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
