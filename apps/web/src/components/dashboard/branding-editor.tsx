'use client';

import { useRef, useState } from 'react';
import Image from 'next/image';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ImagePlus, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { useApi, useDashboard } from './dashboard-provider';
import { ApiRequestError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/primitives';

/**
 * Logo, cover image, and brand colours.
 *
 * Both upload endpoints have existed since the first commit. The LOGO one had
 * nothing calling it, so every restaurant was logo-less while the setup checklist
 * told them to "add your logo" and offered no way to do it. The COVER one was the
 * same, except worse: the storefront homepage already renders `coverImageUrl` as its
 * hero, so the feature was visible, working, and unreachable — every restaurant on
 * the platform got the fallback gradient and no way to change it.
 *
 * A promise the product can't keep is worse than a missing feature.
 *
 * The primary colour drives `--brand` across the storefront, the widget and every
 * email we send — which is why the previews here matter more than they look like
 * they should. It is the button customers press to spend money.
 */
export function BrandingEditor() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { restaurant, can } = useDashboard();

  const logoRef = useRef<HTMLInputElement>(null);
  const coverRef = useRef<HTMLInputElement>(null);

  const [primary, setPrimary] = useState(restaurant?.brandPrimaryColor ?? '#EA580C');
  const [accent, setAccent] = useState(restaurant?.brandAccentColor ?? '#0F172A');

  const uploadLogo = useMutation({
    mutationFn: (file: File) => api.uploadLogo(file),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.success('Logo updated — it appears on your page, emails and receipts.');
    },
    onError: (err) =>
      // The API enforces type and size (5MB, jpg/png/webp/svg) and says which rule
      // was broken. Pass that through rather than a generic failure.
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not upload the logo'),
  });

  const uploadCover = useMutation({
    mutationFn: (file: File) => api.uploadCover(file),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.success('Cover photo updated — it is the first thing customers see.');
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not upload the photo'),
  });

  const saveColors = useMutation({
    mutationFn: () =>
      api.updateCurrent({ brandPrimaryColor: primary, brandAccentColor: accent }),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.success('Brand colours saved');
    },
    onError: () => toast.error('Could not save the colours'),
  });

  const saveTemplate = useMutation({
    mutationFn: (websiteTemplate: 'CLASSIC' | 'BOLD' | 'MINIMAL') =>
      api.updateCurrent({ websiteTemplate }),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.success('Website template updated');
    },
    onError: () => toast.error('Could not switch templates'),
  });

  const saveLogoMode = useMutation({
    mutationFn: (logoDisplayMode: 'LOGO_AND_NAME' | 'LOGO_ONLY' | 'NAME_ONLY') =>
      api.updateCurrent({ logoDisplayMode }),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.success('Header style updated');
    },
    onError: () => toast.error('Could not update the header style'),
  });

  if (!restaurant) return null;
  const readOnly = !can('MANAGER');

  const colorsChanged =
    primary !== restaurant.brandPrimaryColor || accent !== restaurant.brandAccentColor;

  /** Both uploads behave identically; only the endpoint differs. */
  const onPick = (mutate: (f: File) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) mutate(file);
    // Reset, so picking the SAME file again after a failed upload still fires.
    e.target.value = '';
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Your brand</CardTitle>
        <CardDescription>
          Used on your ordering page, your QR codes, the widget on your own website, and every
          email we send your customers.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-8">
        {/* ---------- Cover photo ---------- */}
        <div className="space-y-2">
          <Label>Cover photo</Label>

          <div className="relative overflow-hidden rounded-xl border">
            {restaurant.coverImageUrl ? (
              <Image
                src={restaurant.coverImageUrl}
                alt=""
                width={800}
                height={240}
                className="h-40 w-full object-cover"
              />
            ) : (
              // The SAME gradient the storefront hero falls back to (140deg, primary
              // -> accent), so what they see here is literally what a customer sees.
              <div
                className="flex h-40 w-full items-center justify-center"
                style={{
                  background: `linear-gradient(140deg, ${primary} 0%, ${accent} 100%)`,
                }}
              >
                <p className="text-sm font-medium text-white/90">
                  No photo yet — customers see this gradient
                </p>
              </div>
            )}
          </div>

          <input
            ref={coverRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={onPick((f) => uploadCover.mutate(f))}
          />

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => coverRef.current?.click()}
              disabled={readOnly || uploadCover.isPending}
            >
              <ImagePlus className="h-3.5 w-3.5" />
              {uploadCover.isPending
                ? 'Uploading…'
                : restaurant.coverImageUrl
                  ? 'Replace photo'
                  : 'Add a cover photo'}
            </Button>
            <p className="text-xs text-muted-foreground">
              Wide, not tall — around 1600×600. A photo of the food beats a photo of the building.
            </p>
          </div>
        </div>

        {/* ---------- Logo ---------- */}
        <div className="flex flex-wrap items-center gap-5">
          {restaurant.logoUrl ? (
            <Image
              src={restaurant.logoUrl}
              alt=""
              width={72}
              height={72}
              className="rounded-2xl border object-cover"
              style={{ width: 72, height: 72 }}
            />
          ) : (
            <div
              className="flex items-center justify-center rounded-2xl text-2xl font-bold text-white"
              style={{ width: 72, height: 72, background: primary }}
            >
              {restaurant.name.charAt(0)}
            </div>
          )}

          <div className="space-y-1.5">
            <input
              ref={logoRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/svg+xml"
              className="hidden"
              onChange={onPick((f) => uploadLogo.mutate(f))}
            />

            <Button
              variant="outline"
              size="sm"
              onClick={() => logoRef.current?.click()}
              disabled={readOnly || uploadLogo.isPending}
            >
              <Upload className="h-3.5 w-3.5" />
              {uploadLogo.isPending
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

        {/* ---------- Header style ---------- */}
        <div className="space-y-2">
          <Label>Header style</Label>
          <p className="text-xs text-muted-foreground">
            If your logo already has your name built into the artwork, showing the text name again
            right next to it just repeats itself.
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            {(
              [
                { value: 'LOGO_AND_NAME', label: 'Logo + name' },
                { value: 'LOGO_ONLY', label: 'Logo only' },
                { value: 'NAME_ONLY', label: 'Name only' },
              ] as const
            ).map(({ value, label }) => (
              <button
                key={value}
                type="button"
                disabled={readOnly || saveLogoMode.isPending || (value !== 'NAME_ONLY' && !restaurant.logoUrl)}
                onClick={() => saveLogoMode.mutate(value)}
                className={`rounded-xl border p-3 text-left text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  restaurant.logoDisplayMode === value
                    ? 'border-brand-subtle bg-brand-subtle'
                    : 'hover:bg-accent/50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {!restaurant.logoUrl && (
            <p className="text-xs text-muted-foreground">Upload a logo above to unlock these.</p>
          )}
        </div>

        {/* ---------- Website template ---------- */}
        <div className="space-y-2">
          <Label>Website template</Label>
          <p className="text-xs text-muted-foreground">
            Three different layouts, not a colour change — switch anytime and see it live instantly.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <TemplateOption
              swatch="photo"
              title="Classic"
              description="Full-bleed cover photo, a gallery, a closing pitch. Best with real photography."
              active={restaurant.websiteTemplate === 'CLASSIC'}
              onSelect={() => saveTemplate.mutate('CLASSIC')}
              disabled={readOnly || saveTemplate.isPending}
              accent={primary}
            />
            <TemplateOption
              swatch="bold"
              title="Bold"
              description="Solid colour hero, menu-forward. Built for a fast QR scan-to-order."
              active={restaurant.websiteTemplate === 'BOLD'}
              onSelect={() => saveTemplate.mutate('BOLD')}
              disabled={readOnly || saveTemplate.isPending}
              accent={primary}
            />
            <TemplateOption
              swatch="minimal"
              title="Minimal"
              description="Centered, text-first, no photo needed. Quiet and clean."
              active={restaurant.websiteTemplate === 'MINIMAL'}
              onSelect={() => saveTemplate.mutate('MINIMAL')}
              disabled={readOnly || saveTemplate.isPending}
              accent={primary}
            />
          </div>
        </div>

        {/* ---------- Colours ---------- */}
        <div className="grid gap-6 sm:grid-cols-2">
          <ColorField
            id="brand-color"
            label="Brand colour"
            hint="Buttons, links, and highlights."
            value={primary}
            onChange={setPrimary}
            disabled={readOnly}
          />
          <ColorField
            id="accent-color"
            label="Accent colour"
            hint="The second colour in the gradient above, when you have no cover photo."
            value={accent}
            onChange={setAccent}
            disabled={readOnly}
          />
        </div>

        {/* The live preview of the one thing these colours actually do: the button a
            customer presses to spend money, on the surface it sits on. */}
        <div className="flex flex-wrap items-center gap-4 rounded-xl p-5" style={{ background: accent }}>
          <span className="text-sm font-semibold text-white">The Classic · $12.00</span>
          <span
            className="rounded-lg px-4 py-2 text-sm font-semibold text-white"
            style={{ background: primary }}
          >
            Add to cart
          </span>
        </div>

        {!readOnly && colorsChanged && (
          <Button size="sm" onClick={() => saveColors.mutate()} disabled={saveColors.isPending}>
            {saveColors.isPending ? 'Saving…' : 'Save colours'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/** A tiny stylised mockup of each layout's shape -- enough to tell them apart
 *  at a glance without shipping three real screenshots into the settings page. */
function TemplateOption({
  swatch,
  title,
  description,
  active,
  onSelect,
  disabled,
  accent,
}: {
  swatch: 'photo' | 'bold' | 'minimal';
  title: string;
  description: string;
  active: boolean;
  onSelect: () => void;
  disabled: boolean;
  accent: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={`overflow-hidden rounded-xl border text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        active ? 'border-brand-subtle bg-brand-subtle' : 'hover:bg-accent/50'
      }`}
    >
      <div className="aspect-[4/3] w-full border-b bg-muted/40 p-2">
        {swatch === 'photo' && (
          <div className="flex h-full flex-col justify-end gap-1 rounded-md p-2" style={{ background: `linear-gradient(160deg, ${accent}55, #00000055)` }}>
            <div className="h-2 w-3/5 rounded-sm bg-white/90" />
            <div className="h-1.5 w-2/5 rounded-sm bg-white/60" />
          </div>
        )}
        {swatch === 'bold' && (
          <div className="flex h-full flex-col justify-center gap-1.5 rounded-md p-2" style={{ background: accent }}>
            <div className="h-2 w-4/5 rounded-sm bg-white" />
            <div className="h-2 w-2/5 rounded-sm bg-white/70" />
          </div>
        )}
        {swatch === 'minimal' && (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 rounded-md bg-white p-2">
            <div className="h-1.5 w-2/5 rounded-sm" style={{ background: accent }} />
            <div className="h-1 w-3/5 rounded-sm bg-muted-foreground/30" />
          </div>
        )}
      </div>
      <div className="p-3">
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
    </button>
  );
}

function ColorField({
  id,
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          disabled={disabled}
          className="h-10 w-12 cursor-pointer rounded-lg border"
        />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          disabled={disabled}
          className="w-32 font-mono"
        />
      </div>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
