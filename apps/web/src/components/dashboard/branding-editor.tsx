'use client';

import { useRef, useState } from 'react';
import Image from 'next/image';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Film, ImagePlus, Lock, Scissors, Trash2, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { useApi, useDashboard } from './dashboard-provider';
import { BrandIdeasGenerator } from './brand-ideas';
import { ApiRequestError } from '@/lib/api';
import { nameWordmarkStyle, logoColorFilter } from '@/lib/name-style';
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
  const { restaurant, can, hasFeature } = useDashboard();
  // The ordering-website layouts are a paid capability. Logo, name, cover and colours
  // are NOT — they print on QR codes, the kitchen board and every email, on any plan.
  const websiteLocked = !hasFeature('WEBSITE_STOREFRONT');

  const logoRef = useRef<HTMLInputElement>(null);
  const coverRef = useRef<HTMLInputElement>(null);

  const [primary, setPrimary] = useState(restaurant?.brandPrimaryColor ?? '#EA580C');
  const [accent, setAccent] = useState(restaurant?.brandAccentColor ?? '#0F172A');
  const [heroVideo, setHeroVideo] = useState(restaurant?.heroVideoUrl ?? '');
  const [tagline, setTagline] = useState(restaurant?.heroTagline ?? '');

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
    mutationFn: (
      websiteTemplate: 'CLASSIC' | 'RUSTIC' | 'BUILDER' | 'BENTO' | 'ELEGANT' | 'PUNCHY',
    ) => api.updateCurrent({ websiteTemplate }),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.success('Website template updated');
    },
    onError: () => toast.error('Could not switch templates'),
  });

  const saveThemeMode = useMutation({
    mutationFn: (themeMode: 'LIGHT' | 'DARK') => api.updateCurrent({ themeMode }),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.success('Theme updated');
    },
    onError: () => toast.error('Could not switch theme'),
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

  const saveLogoScale = useMutation({
    mutationFn: (logoScale: number) => api.updateCurrent({ logoScale }),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.success('Logo size updated');
    },
    onError: () => toast.error('Could not update the logo size'),
  });

  const saveLogoColor = useMutation({
    mutationFn: (logoColor: 'ORIGINAL' | 'WHITE' | 'BLACK') => api.updateCurrent({ logoColor }),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.success('Logo colour updated');
    },
    onError: () => toast.error('Could not update the logo colour'),
  });

  const saveHeroLogoColor = useMutation({
    mutationFn: (heroLogoColor: string) => api.updateCurrent({ heroLogoColor }),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.success('Hero logo colour updated');
    },
    onError: () => toast.error('Could not update the hero logo colour'),
  });

  const removeLogoBg = useMutation({
    mutationFn: () => api.removeLogoBackground(),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.success('Logo background removed.');
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiRequestError ? err.body.message : 'Could not remove the background',
      ),
  });

  const saveHeroVideo = useMutation({
    mutationFn: (heroVideoUrl: string | null) => api.updateCurrent({ heroVideoUrl }),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.success('Background video updated');
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not save the video'),
  });

  const videoRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);

  const uploadVideo = useMutation({
    mutationFn: (file: File) => api.uploadHeroVideo(file),
    onSuccess: (res) => {
      setHeroVideo(res.heroVideoUrl);
      void queryClient.invalidateQueries();
      toast.success('Background video uploaded');
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not upload the video'),
  });

  const removeVideo = useMutation({
    mutationFn: () => api.updateCurrent({ heroVideoUrl: null }),
    onSuccess: () => {
      setHeroVideo('');
      void queryClient.invalidateQueries();
      toast.success('Background video removed');
    },
    onError: () => toast.error('Could not remove the video'),
  });

  // The hero slideshow plays these when there's no video — the same gallery the
  // About story uses, surfaced here so photos and video live in one place.
  const gallery = useQuery({
    queryKey: ['gallery', restaurant?.id],
    queryFn: () => api.listGallery(),
    enabled: Boolean(restaurant),
  });

  const addPhoto = useMutation({
    mutationFn: (file: File) => api.addGalleryImage(file),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['gallery'] });
      toast.success('Photo added');
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not add the photo'),
  });

  const removePhoto = useMutation({
    mutationFn: (id: string) => api.removeGalleryImage(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['gallery'] });
      toast.success('Photo removed');
    },
    onError: () => toast.error('Could not remove the photo'),
  });

  const saveNameStyle = useMutation({
    mutationFn: (body: {
      nameFont?: 'DISPLAY' | 'SERIF' | 'SANS' | 'MONO' | 'SCRIPT';
      nameColor?: string | null;
      nameTransform?: 'NONE' | 'UPPERCASE';
    }) => api.updateCurrent(body),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.success('Name style updated');
    },
    onError: () => toast.error('Could not update the name style'),
  });

  const saveTagline = useMutation({
    mutationFn: (body: {
      heroTagline?: string | null;
      heroTaglineColor?: string | null;
      heroTaglineFont?: 'DISPLAY' | 'SERIF' | 'SANS' | 'MONO' | 'SCRIPT';
    }) => api.updateCurrent(body),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.success('Hero tagline updated');
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not save the tagline'),
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
        {/* ---------- Logo ---------- */}
        <div className="flex flex-wrap items-center gap-5">
          {restaurant.logoUrl ? (
            // Shown exactly as the storefront header shows it: height-constrained,
            // width auto, never cropped — so a wide wordmark logo previews as a wide
            // wordmark here, not a squashed square. The white pad keeps a transparent
            // PNG visible on any theme.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={restaurant.logoUrl}
              alt=""
              className="h-16 w-auto max-w-[220px] rounded-2xl border object-contain p-1.5"
              style={{
                filter: logoColorFilter(restaurant.logoColor),
                // A brand-coloured pad so a white OR black recolour is visible here.
                background: restaurant.logoColor === 'ORIGINAL' ? '#fff' : primary,
              }}
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

            <div className="flex flex-wrap gap-2">
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
              {restaurant.logoUrl && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => removeLogoBg.mutate()}
                  disabled={readOnly || removeLogoBg.isPending}
                >
                  <Scissors className="h-3.5 w-3.5" />
                  {removeLogoBg.isPending ? 'Removing…' : 'Remove background'}
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Square works best. PNG, JPG, WebP or SVG, up to 5MB. New uploads have their
              background removed automatically; use “Remove background” to redo it.
            </p>

            {restaurant.logoUrl && (
              <div className="space-y-2 pt-1">
                {/* Header logo — sits on the light top bar, so usually stays original. */}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="w-24 text-xs font-medium text-muted-foreground">Header logo</span>
                  {(
                    [
                      { value: 'ORIGINAL', label: 'Original' },
                      { value: 'WHITE', label: 'White' },
                      { value: 'BLACK', label: 'Black' },
                    ] as const
                  ).map(({ value, label }) => (
                    <button
                      key={value}
                      type="button"
                      disabled={readOnly || saveLogoColor.isPending}
                      onClick={() => saveLogoColor.mutate(value)}
                      className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                        (restaurant.logoColor ?? 'ORIGINAL') === value
                          ? 'border-brand-subtle bg-brand-subtle'
                          : 'hover:bg-accent/50'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {/* Hero logo — over the media, so often white, or your own colour. */}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="w-24 text-xs font-medium text-muted-foreground">Hero logo</span>
                  {(
                    [
                      { value: 'ORIGINAL', label: 'Original' },
                      { value: 'WHITE', label: 'White' },
                      { value: 'BLACK', label: 'Black' },
                    ] as const
                  ).map(({ value, label }) => (
                    <button
                      key={value}
                      type="button"
                      disabled={readOnly || saveHeroLogoColor.isPending}
                      onClick={() => saveHeroLogoColor.mutate(value)}
                      className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                        (restaurant.heroLogoColor ?? 'ORIGINAL') === value
                          ? 'border-brand-subtle bg-brand-subtle'
                          : 'hover:bg-accent/50'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                  {/* Custom colour — fills the logo as a solid silhouette in your colour. */}
                  <label
                    className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                      restaurant.heroLogoColor?.startsWith('#')
                        ? 'border-brand-subtle bg-brand-subtle'
                        : 'hover:bg-accent/50'
                    } ${readOnly ? 'pointer-events-none opacity-40' : ''}`}
                  >
                    <span
                      className="h-3.5 w-3.5 rounded-full border"
                      style={{
                        background: restaurant.heroLogoColor?.startsWith('#')
                          ? restaurant.heroLogoColor
                          : 'conic-gradient(red, orange, yellow, green, blue, violet, red)',
                      }}
                    />
                    Custom
                    <input
                      type="color"
                      className="sr-only"
                      disabled={readOnly || saveHeroLogoColor.isPending}
                      value={
                        restaurant.heroLogoColor?.startsWith('#') ? restaurant.heroLogoColor : '#ffffff'
                      }
                      onChange={(e) => saveHeroLogoColor.mutate(e.target.value.toUpperCase())}
                    />
                  </label>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* AI helper: suggests a name + monogram for a restaurant that has neither. */}
        <BrandIdeasGenerator />

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

        {/* ---------- Logo size ---------- */}
        {restaurant.logoDisplayMode !== 'NAME_ONLY' && restaurant.logoUrl && (
          <div className="space-y-2">
            <Label>Logo size</Label>
            <p className="text-xs text-muted-foreground">
              Make a wide “logo + name” image bigger in your header instead of small.
            </p>
            <div className="grid gap-2 sm:grid-cols-4">
              {(
                [
                  { value: 75, label: 'Small' },
                  { value: 100, label: 'Default' },
                  { value: 150, label: 'Large' },
                  { value: 200, label: 'Extra large' },
                ] as const
              ).map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  disabled={readOnly || saveLogoScale.isPending}
                  onClick={() => saveLogoScale.mutate(value)}
                  className={`rounded-xl border p-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    (restaurant.logoScale ?? 100) === value
                      ? 'border-brand-subtle bg-brand-subtle'
                      : 'hover:bg-accent/50'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}


        {/* ---------- Name style ---------- */}
        {restaurant.logoDisplayMode !== 'LOGO_ONLY' && (
          <div className="space-y-3">
            <div>
              <Label>Restaurant name style</Label>
              <p className="text-xs text-muted-foreground">
                How your name is set in the header when it&apos;s shown as text.
              </p>
            </div>

            {/* Live preview in the restaurant's own name */}
            <div className="flex min-h-14 items-center rounded-xl border bg-background px-4 py-3">
              <span
                className="truncate text-2xl font-semibold tracking-tight"
                style={nameWordmarkStyle(restaurant)}
              >
                {restaurant.name}
              </span>
            </div>

            {/* Font */}
            <div className="grid gap-2 sm:grid-cols-5">
              {(
                [
                  { value: 'DISPLAY', label: 'Display' },
                  { value: 'SERIF', label: 'Serif' },
                  { value: 'SANS', label: 'Sans' },
                  { value: 'MONO', label: 'Mono' },
                  { value: 'SCRIPT', label: 'Script' },
                ] as const
              ).map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  disabled={readOnly || saveNameStyle.isPending}
                  onClick={() => saveNameStyle.mutate({ nameFont: value })}
                  style={nameWordmarkStyle({ nameFont: value })}
                  className={`rounded-xl border p-3 text-base transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    (restaurant.nameFont ?? 'DISPLAY') === value
                      ? 'border-brand-subtle bg-brand-subtle'
                      : 'hover:bg-accent/50'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Colour + format */}
            <div className="flex flex-wrap items-center gap-2">
              {(
                [
                  { value: null, label: 'Default' },
                  { value: 'BRAND', label: 'Brand colour' },
                ] as const
              ).map(({ value, label }) => (
                <button
                  key={label}
                  type="button"
                  disabled={readOnly || saveNameStyle.isPending}
                  onClick={() => saveNameStyle.mutate({ nameColor: value })}
                  className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    (restaurant.nameColor ?? null) === value
                      ? 'border-brand-subtle bg-brand-subtle'
                      : 'hover:bg-accent/50'
                  }`}
                >
                  {label}
                </button>
              ))}

              {/* Custom colour — an all-caps hex like #C0392B. The picker sets it live. */}
              <label
                className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                  restaurant.nameColor && restaurant.nameColor.startsWith('#')
                    ? 'border-brand-subtle bg-brand-subtle'
                    : 'hover:bg-accent/50'
                } ${readOnly ? 'pointer-events-none opacity-40' : ''}`}
              >
                <span
                  className="h-4 w-4 rounded-full border"
                  style={{
                    background:
                      restaurant.nameColor && restaurant.nameColor.startsWith('#')
                        ? restaurant.nameColor
                        : 'conic-gradient(red, orange, yellow, green, blue, violet, red)',
                  }}
                />
                Custom
                <input
                  type="color"
                  className="sr-only"
                  disabled={readOnly || saveNameStyle.isPending}
                  value={
                    restaurant.nameColor && restaurant.nameColor.startsWith('#')
                      ? restaurant.nameColor
                      : '#111111'
                  }
                  onChange={(e) => saveNameStyle.mutate({ nameColor: e.target.value.toUpperCase() })}
                />
              </label>

              <span className="mx-1 hidden h-6 w-px bg-border sm:block" />

              {(
                [
                  { value: 'NONE', label: 'Normal' },
                  { value: 'UPPERCASE', label: 'UPPERCASE' },
                ] as const
              ).map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  disabled={readOnly || saveNameStyle.isPending}
                  onClick={() => saveNameStyle.mutate({ nameTransform: value })}
                  className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    (restaurant.nameTransform ?? 'NONE') === value
                      ? 'border-brand-subtle bg-brand-subtle'
                      : 'hover:bg-accent/50'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ---------- Hero background (video + photos) ---------- */}
        <div className="space-y-3">
          <div>
            <Label>Hero background</Label>
            <p className="text-xs text-muted-foreground">
              What plays full-screen behind your logo on the homepage. A video is the most
              modern look; with no video, your photos play as a moving slideshow.
            </p>
          </div>

          {/* Video */}
          <div className="rounded-xl border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-sm font-medium">
                <Film className="h-4 w-4 text-muted-foreground" />
                {restaurant.heroVideoUrl ? 'Video added' : 'Background video'}
              </span>
              <div className="flex items-center gap-2">
                {!readOnly && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => videoRef.current?.click()}
                    disabled={uploadVideo.isPending}
                  >
                    <Upload className="h-3.5 w-3.5" />
                    {uploadVideo.isPending
                      ? 'Uploading…'
                      : restaurant.heroVideoUrl
                        ? 'Replace'
                        : 'Upload video'}
                  </Button>
                )}
                {!readOnly && restaurant.heroVideoUrl && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => removeVideo.mutate()}
                    disabled={removeVideo.isPending}
                  >
                    <X className="h-3.5 w-3.5" />
                    Remove
                  </Button>
                )}
              </div>
            </div>
            {restaurant.heroVideoUrl && (
              <video
                src={restaurant.heroVideoUrl}
                className="mt-3 aspect-video w-full rounded-lg bg-black object-cover"
                muted
                loop
                autoPlay
                playsInline
              />
            )}
            {/* Advanced: paste a hosted link instead of uploading. */}
            <div className="mt-3 flex gap-2">
              <Input
                value={heroVideo}
                onChange={(e) => setHeroVideo(e.target.value)}
                placeholder="…or paste a hosted .mp4 / .webm link"
                inputMode="url"
                disabled={readOnly}
              />
              {!readOnly && heroVideo.trim() !== (restaurant.heroVideoUrl ?? '') && (
                <Button
                  size="sm"
                  onClick={() => saveHeroVideo.mutate(heroVideo.trim() || null)}
                  disabled={saveHeroVideo.isPending}
                >
                  Save
                </Button>
              )}
            </div>
            <input
              ref={videoRef}
              type="file"
              accept="video/mp4,video/webm,video/quicktime"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) uploadVideo.mutate(file);
                e.target.value = '';
              }}
            />
          </div>

          {/* Photos — the same gallery the About story uses; they play as the slideshow. */}
          <div className="rounded-xl border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-sm font-medium">
                <ImagePlus className="h-4 w-4 text-muted-foreground" />
                Photos
                <span className="font-normal text-muted-foreground">
                  play as a slideshow when there&apos;s no video
                </span>
              </span>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5">
              {gallery.data?.map((image) => (
                <div key={image.id} className="group relative overflow-hidden rounded-lg border">
                  <Image
                    src={image.url}
                    alt=""
                    width={160}
                    height={120}
                    className="h-20 w-full object-cover"
                  />
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() => removePhoto.mutate(image.id)}
                      aria-label="Remove photo"
                      className="absolute right-1 top-1 rounded-md bg-black/60 p-1 text-white opacity-0 transition-opacity hover:bg-destructive group-hover:opacity-100"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ))}
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => photoRef.current?.click()}
                  disabled={addPhoto.isPending}
                  className="flex h-20 flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <ImagePlus className="h-4 w-4" />
                  <span className="text-[10px] font-medium">
                    {addPhoto.isPending ? 'Uploading…' : 'Add'}
                  </span>
                </button>
              )}
            </div>
            <input
              ref={photoRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) addPhoto.mutate(file);
                e.target.value = '';
              }}
            />
          </div>

          {/* Poster / fallback — the still shown before a video loads and when there's
              no video or photos at all. (This is the old 'cover photo'.) */}
          <div className="flex flex-wrap items-center gap-3 rounded-xl border p-4">
            <div className="h-14 w-24 shrink-0 overflow-hidden rounded-lg border">
              {restaurant.coverImageUrl ? (
                <Image
                  src={restaurant.coverImageUrl}
                  alt=""
                  width={160}
                  height={90}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div
                  className="h-full w-full"
                  style={{ background: `linear-gradient(140deg, ${primary} 0%, ${accent} 100%)` }}
                />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Poster / fallback image</p>
              <p className="text-xs text-muted-foreground">
                Shown before a video loads, and when there&apos;s no video or photos.
              </p>
            </div>
            {!readOnly && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => coverRef.current?.click()}
                disabled={uploadCover.isPending}
              >
                <ImagePlus className="h-3.5 w-3.5" />
                {uploadCover.isPending ? 'Uploading…' : restaurant.coverImageUrl ? 'Replace' : 'Add image'}
              </Button>
            )}
            <input
              ref={coverRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={onPick((f) => uploadCover.mutate(f))}
            />
          </div>
        </div>

        {/* ---------- Hero tagline ---------- */}
        <div className="space-y-3">
          <div>
            <Label htmlFor="hero-tagline">Hero tagline</Label>
            <p className="text-xs text-muted-foreground">
              A short line under your logo in the hero — your words about the place (“Home of
              the famous flautas”). Leave blank to use your description.
            </p>
          </div>

          <div className="flex gap-2">
            <Input
              id="hero-tagline"
              value={tagline}
              onChange={(e) => setTagline(e.target.value)}
              placeholder="Home of the famous flautas"
              maxLength={160}
              disabled={readOnly}
            />
            {!readOnly && tagline.trim() !== (restaurant.heroTagline ?? '') && (
              <Button
                size="sm"
                onClick={() => saveTagline.mutate({ heroTagline: tagline.trim() || null })}
                disabled={saveTagline.isPending}
              >
                Save
              </Button>
            )}
          </div>

          {/* Font */}
          <div className="grid gap-2 sm:grid-cols-5">
            {(
              [
                { value: 'DISPLAY', label: 'Display' },
                { value: 'SERIF', label: 'Serif' },
                { value: 'SANS', label: 'Sans' },
                { value: 'MONO', label: 'Mono' },
                { value: 'SCRIPT', label: 'Script' },
              ] as const
            ).map(({ value, label }) => (
              <button
                key={value}
                type="button"
                disabled={readOnly || saveTagline.isPending}
                onClick={() => saveTagline.mutate({ heroTaglineFont: value })}
                style={nameWordmarkStyle({ nameFont: value })}
                className={`rounded-xl border p-2.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  (restaurant.heroTaglineFont ?? 'SANS') === value
                    ? 'border-brand-subtle bg-brand-subtle'
                    : 'hover:bg-accent/50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Colour */}
          <div className="flex flex-wrap items-center gap-2">
            {(
              [
                { value: null, label: 'Default' },
                { value: 'BRAND', label: 'Brand colour' },
              ] as const
            ).map(({ value, label }) => (
              <button
                key={label}
                type="button"
                disabled={readOnly || saveTagline.isPending}
                onClick={() => saveTagline.mutate({ heroTaglineColor: value })}
                className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  (restaurant.heroTaglineColor ?? null) === value
                    ? 'border-brand-subtle bg-brand-subtle'
                    : 'hover:bg-accent/50'
                }`}
              >
                {label}
              </button>
            ))}
            <label
              className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                restaurant.heroTaglineColor && restaurant.heroTaglineColor.startsWith('#')
                  ? 'border-brand-subtle bg-brand-subtle'
                  : 'hover:bg-accent/50'
              } ${readOnly ? 'pointer-events-none opacity-40' : ''}`}
            >
              <span
                className="h-4 w-4 rounded-full border"
                style={{
                  background:
                    restaurant.heroTaglineColor && restaurant.heroTaglineColor.startsWith('#')
                      ? restaurant.heroTaglineColor
                      : 'conic-gradient(red, orange, yellow, green, blue, violet, red)',
                }}
              />
              Custom
              <input
                type="color"
                className="sr-only"
                disabled={readOnly || saveTagline.isPending}
                value={
                  restaurant.heroTaglineColor && restaurant.heroTaglineColor.startsWith('#')
                    ? restaurant.heroTaglineColor
                    : '#ffffff'
                }
                onChange={(e) => saveTagline.mutate({ heroTaglineColor: e.target.value.toUpperCase() })}
              />
            </label>
          </div>
        </div>

        {/* ---------- Website template ---------- */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <Label>Website template</Label>
              <p className="text-xs text-muted-foreground">
                Eight different layouts, not a colour change — switch anytime and see it live instantly.
              </p>
            </div>

            {/* The owner's setting, not the customer's -- there is no toggle on
                the live site. Same layout and personality either way; only the
                palette flips. */}
            <div className={`inline-flex shrink-0 rounded-lg border bg-muted/40 p-1 ${websiteLocked ? 'hidden' : ''}`}>
              {(['LIGHT', 'DARK'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => saveThemeMode.mutate(m)}
                  disabled={readOnly || saveThemeMode.isPending}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                    restaurant.themeMode === m
                      ? 'bg-background text-foreground shadow-soft'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {m === 'LIGHT' ? 'Light' : 'Dark'}
                </button>
              ))}
            </div>
          </div>
          {websiteLocked && (
            <div className="flex items-start gap-2.5 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              <Lock className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                The ordering website and its layouts are on{' '}
                <span className="font-semibold text-foreground">Growth</span> and up. Your logo,
                name and colours above still print on your QR codes and emails on every plan.
              </span>
            </div>
          )}
          <div className={`grid gap-3 sm:grid-cols-3 lg:grid-cols-4 ${websiteLocked ? 'hidden' : ''}`}>
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
              swatch="rustic"
              title="Rustic"
              description="Warm cream palette, dashed borders, a dark coupon-card hero. Artisanal."
              active={restaurant.websiteTemplate === 'RUSTIC'}
              onSelect={() => saveTemplate.mutate('RUSTIC')}
              disabled={readOnly || saveTemplate.isPending}
              accent={primary}
            />
            <TemplateOption
              swatch="builder"
              title="Builder"
              description="Bold black type, a floating status card. App-like and fast."
              active={restaurant.websiteTemplate === 'BUILDER'}
              onSelect={() => saveTemplate.mutate('BUILDER')}
              disabled={readOnly || saveTemplate.isPending}
              accent={primary}
            />
            <TemplateOption
              swatch="bento"
              title="Bento"
              description="Chunky rounded type, bright colour-blocked cards. Playful and confident."
              active={restaurant.websiteTemplate === 'BENTO'}
              onSelect={() => saveTemplate.mutate('BENTO')}
              disabled={readOnly || saveTemplate.isPending}
              accent={primary}
            />
            <TemplateOption
              swatch="elegant"
              title="Elegant"
              description="Cream and forest green, serif type, a dark band behind the hero. Fine dining."
              active={restaurant.websiteTemplate === 'ELEGANT'}
              onSelect={() => saveTemplate.mutate('ELEGANT')}
              disabled={readOnly || saveTemplate.isPending}
              accent={primary}
            />
            <TemplateOption
              swatch="punchy"
              title="Punchy"
              description="Dark charcoal, one bright accent, a phone-framed photo. Confident comfort food."
              active={restaurant.websiteTemplate === 'PUNCHY'}
              onSelect={() => saveTemplate.mutate('PUNCHY')}
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
  swatch: 'photo' | 'bold' | 'minimal' | 'rustic' | 'builder' | 'bento' | 'elegant' | 'punchy' | 'signature';
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
        {swatch === 'rustic' && (
          <div className="flex h-full items-center gap-1.5 rounded-md p-2" style={{ background: '#241a10' }}>
            <div className="flex flex-1 flex-col gap-1">
              <div className="h-2 w-full rounded-sm bg-white/90" />
              <div className="h-1.5 w-2/3 rounded-sm" style={{ background: accent }} />
            </div>
            <div className="h-full w-1/3 rounded-sm" style={{ background: accent }} />
          </div>
        )}
        {swatch === 'builder' && (
          <div className="flex h-full flex-col justify-between gap-1.5 rounded-md bg-white p-2">
            <div className="h-3 w-4/5 rounded-sm bg-foreground" />
            <div className="h-4 w-2/5 self-end rounded-md border" style={{ borderColor: accent }} />
          </div>
        )}
        {swatch === 'bento' && (
          <div className="grid h-full grid-cols-3 gap-1 rounded-md p-1">
            <div className="col-span-2 rounded-sm" style={{ background: accent }} />
            <div className="rounded-sm bg-[#1c1c1c]" />
          </div>
        )}
        {swatch === 'elegant' && (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 rounded-md p-2" style={{ background: '#f7f2e7' }}>
            <div className="h-1.5 w-2/5 rounded-sm bg-[#2a2118]" />
            <div className="h-3 w-3/5 rounded-sm" style={{ background: '#1f3d2b' }} />
          </div>
        )}
        {swatch === 'punchy' && (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 rounded-md p-2" style={{ background: '#161513' }}>
            <div className="h-1.5 w-2/5 rounded-full" style={{ background: accent }} />
            <div className="h-2 w-3/5 rounded-sm bg-white/90" />
            <div className="h-4 w-1/4 rounded-md" style={{ background: '#0c0b0a' }} />
          </div>
        )}
        {swatch === 'signature' && (
          <div
            className="flex h-full flex-col justify-center gap-1.5 rounded-md p-2"
            style={{
              background: `radial-gradient(ellipse 120% 90% at 15% 0%, ${accent}, transparent 60%), #17171a`,
            }}
          >
            <div className="h-1.5 w-1/4 rounded-full bg-white/25" />
            <div className="h-2.5 w-4/5 rounded-sm bg-white/90" />
            <div className="h-3 w-1/3 rounded-md" style={{ background: accent }} />
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
