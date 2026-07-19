'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SOCIAL_PLATFORMS } from '@dinedirect/shared';
import { toast } from 'sonner';
import { useApi, useDashboard } from './dashboard-provider';
import { ApiRequestError } from '@/lib/api';
import { SOCIAL_META, SocialIcon } from '@/components/shared/social-icons';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

/**
 * Social profile links, shown as an icon row on the storefront footer.
 *
 * One field per supported platform — no free-form "platform + URL" builder, because
 * the storefront renders a fixed set of brand icons and a link to something without
 * an icon would show a blank. Empty fields simply aren't saved.
 */
export function SocialLinksEditor() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { restaurant, can } = useDashboard();

  // Seed each platform's field from whatever is saved.
  const saved = new Map((restaurant?.socialLinks ?? []).map((l) => [l.platform, l.url]));
  const [urls, setUrls] = useState<Record<string, string>>(
    Object.fromEntries(SOCIAL_PLATFORMS.map((p) => [p, saved.get(p) ?? ''])),
  );

  const save = useMutation({
    mutationFn: () => {
      const socialLinks = SOCIAL_PLATFORMS.flatMap((platform) => {
        const url = urls[platform]?.trim();
        return url ? [{ platform, url }] : [];
      });
      return api.updateCurrent({ socialLinks });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.success('Social links updated.');
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiRequestError ? err.body.message : 'Could not save your links',
      ),
  });

  if (!restaurant) return null;
  const readOnly = !can('MANAGER');

  const changed = SOCIAL_PLATFORMS.some(
    (p) => (urls[p]?.trim() ?? '') !== (saved.get(p) ?? ''),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Social links</CardTitle>
        <CardDescription>
          Add your profiles and they appear as a row of icons in your storefront footer.
          Leave a field blank to hide it.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {SOCIAL_PLATFORMS.map((platform) => (
          <div key={platform} className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <SocialIcon platform={platform} className="h-4 w-4" />
            </span>
            <Input
              value={urls[platform] ?? ''}
              onChange={(e) => setUrls((prev) => ({ ...prev, [platform]: e.target.value }))}
              placeholder={SOCIAL_META[platform].placeholder}
              aria-label={SOCIAL_META[platform].label}
              inputMode="url"
              disabled={readOnly}
            />
          </div>
        ))}

        {!readOnly && changed && (
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save social links'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
