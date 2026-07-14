'use client';

import { useRef, useState } from 'react';
import Image from 'next/image';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ImagePlus, Trash2 } from 'lucide-react';
import { ABOUT_BODY_MAX, GALLERY_MAX_IMAGES, aboutParagraphs } from '@dinedirect/shared';
import { toast } from 'sonner';
import { useApi, useDashboard } from './dashboard-provider';
import { ApiRequestError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { Label, Skeleton } from '@/components/ui/primitives';

/**
 * The About page — the one part of their site a restaurant writes themselves.
 *
 * Everything else on the storefront is generated from data they already keep current
 * (hours, address, menu), because a page you have to remember to update is a page
 * that is wrong within a year. But nobody can generate "we've ground the beef
 * ourselves since 1998", and that sentence is why some people choose one burger
 * place over another.
 *
 * PLAIN TEXT, deliberately. No rich text editor, no markdown, no HTML. A tenant who
 * can store HTML that we inject into a page on *.dinedirect.manvion.ca has stored XSS — they
 * would be running script on a domain that carries other people's sessions. The
 * formatting model is "a blank line starts a new paragraph", which is enough.
 */
export function AboutEditor() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { restaurant, can } = useDashboard();
  const fileRef = useRef<HTMLInputElement>(null);

  const [headline, setHeadline] = useState(restaurant?.aboutHeadline ?? '');
  const [body, setBody] = useState(restaurant?.aboutBody ?? '');

  const { data: gallery, isLoading } = useQuery({
    queryKey: ['gallery', restaurant?.id],
    queryFn: () => api.listGallery(),
    enabled: Boolean(restaurant),
  });

  const save = useMutation({
    mutationFn: () =>
      api.updateCurrent({
        aboutHeadline: headline.trim() || null,
        aboutBody: body.trim() || null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.success('Your About page is updated.');
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not save'),
  });

  const addPhoto = useMutation({
    mutationFn: (file: File) => api.addGalleryImage(file),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['gallery'] });
      toast.success('Photo added.');
    },
    onError: (err) =>
      // The API enforces type, size and the photo limit, and says which rule was
      // broken. Pass that through rather than inventing a generic failure.
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not add the photo'),
  });

  const removePhoto = useMutation({
    mutationFn: (id: string) => api.removeGalleryImage(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['gallery'] });
      toast.success('Photo removed.');
    },
    onError: () => toast.error('Could not remove the photo'),
  });

  if (!restaurant) return null;
  const readOnly = !can('MANAGER');

  const changed =
    headline.trim() !== (restaurant.aboutHeadline ?? '') ||
    body.trim() !== (restaurant.aboutBody ?? '');

  const paragraphs = aboutParagraphs(body);
  const atLimit = (gallery?.length ?? 0) >= GALLERY_MAX_IMAGES;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Your story</CardTitle>
        <CardDescription>
          Shown on your About page, above your hours and address. Optional — but it is the one
          thing on your site that only you can write.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="about-headline">Headline</Label>
          <Input
            id="about-headline"
            value={headline}
            onChange={(e) => setHeadline(e.target.value)}
            placeholder={`About ${restaurant.name}`}
            maxLength={120}
            disabled={readOnly}
          />
          <p className="text-xs text-muted-foreground">
            Leave it blank and we&apos;ll use &ldquo;About {restaurant.name}&rdquo;.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="about-body">Your story</Label>
          <Textarea
            id="about-body"
            value={body}
            onChange={(e) => setBody(e.target.value.slice(0, ABOUT_BODY_MAX))}
            placeholder={
              "We opened on the corner of 5th in 1998 with one griddle and a queue out the door.\n\nLeave a blank line to start a new paragraph."
            }
            className="min-h-40"
            disabled={readOnly}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Plain text. A blank line starts a new paragraph
              {paragraphs.length > 0 && ` — you have ${paragraphs.length}`}.
            </p>
            <p className="text-xs tabular-nums text-muted-foreground">
              {body.length} / {ABOUT_BODY_MAX}
            </p>
          </div>
        </div>

        {/* ---------- Photos ---------- */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label>Photos</Label>
            <span className="text-xs text-muted-foreground">
              {gallery?.length ?? 0} of {GALLERY_MAX_IMAGES}
            </span>
          </div>

          {isLoading ? (
            <Skeleton className="h-28 w-full" />
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {gallery?.map((image) => (
                <div key={image.id} className="group relative overflow-hidden rounded-xl border">
                  <Image
                    src={image.url}
                    alt={image.caption ?? ''}
                    width={200}
                    height={140}
                    className="h-24 w-full object-cover"
                  />
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() => removePhoto.mutate(image.id)}
                      aria-label="Remove photo"
                      className="absolute right-1.5 top-1.5 rounded-lg bg-black/60 p-1.5 text-white opacity-0 transition-opacity hover:bg-destructive group-hover:opacity-100 focus:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}

              {!readOnly && !atLimit && (
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={addPhoto.isPending}
                  className="flex h-24 flex-col items-center justify-center gap-1 rounded-xl border border-dashed text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <ImagePlus className="h-5 w-5" />
                  <span className="text-xs font-medium">
                    {addPhoto.isPending ? 'Uploading…' : 'Add photo'}
                  </span>
                </button>
              )}
            </div>
          )}

          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) addPhoto.mutate(file);
              // Reset, so picking the SAME file again after a failure still fires.
              e.target.value = '';
            }}
          />
        </div>

        {!readOnly && changed && (
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save your story'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
