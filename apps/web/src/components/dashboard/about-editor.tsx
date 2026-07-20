'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ABOUT_BODY_MAX, aboutParagraphs } from '@dinedirect/shared';
import { toast } from 'sonner';
import { useApi, useDashboard } from './dashboard-provider';
import { ApiRequestError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/primitives';

/**
 * The About page — the one part of their site a restaurant writes themselves.
 *
 * Everything else on the storefront is generated from data they already keep current
 * (hours, address, menu), because a page you have to remember to update is a page
 * that is wrong within a year. But nobody can generate "we've ground the beef
 * ourselves since 1998", and that sentence is why some people choose one burger
 * place over another.
 *
 * Photos live in Branding → Hero background now (the same gallery), because they're a
 * visual asset that plays in the hero, not part of writing the story.
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

  const [headline, setHeadline] = useState(restaurant?.aboutHeadline ?? '');
  const [body, setBody] = useState(restaurant?.aboutBody ?? '');
  const [headlineFr, setHeadlineFr] = useState(restaurant?.aboutHeadlineFr ?? '');
  const [bodyFr, setBodyFr] = useState(restaurant?.aboutBodyFr ?? '');
  const bilingual = restaurant?.menuLanguage === 'BOTH';

  const save = useMutation({
    mutationFn: () =>
      api.updateCurrent({
        aboutHeadline: headline.trim() || null,
        aboutBody: body.trim() || null,
        aboutHeadlineFr: headlineFr.trim() || null,
        aboutBodyFr: bodyFr.trim() || null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.success('Your About page is updated.');
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not save'),
  });

  if (!restaurant) return null;
  const readOnly = !can('MANAGER');

  const changed =
    headline.trim() !== (restaurant.aboutHeadline ?? '') ||
    body.trim() !== (restaurant.aboutBody ?? '') ||
    headlineFr.trim() !== (restaurant.aboutHeadlineFr ?? '') ||
    bodyFr.trim() !== (restaurant.aboutBodyFr ?? '');

  const paragraphs = aboutParagraphs(body);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Your story</CardTitle>
        <CardDescription>
          Shown on your homepage, under the hero. Optional — but it is the one thing on your
          site that only you can write.
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
          {bilingual && (
            <Input
              value={headlineFr}
              onChange={(e) => setHeadlineFr(e.target.value)}
              placeholder="Titre en français (optional)"
              maxLength={120}
              lang="fr"
              disabled={readOnly}
            />
          )}
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
          {bilingual && (
            <Textarea
              value={bodyFr}
              onChange={(e) => setBodyFr(e.target.value.slice(0, ABOUT_BODY_MAX))}
              placeholder="Votre histoire en français (optional)"
              lang="fr"
              className="min-h-40"
              disabled={readOnly}
            />
          )}
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

        {!readOnly && changed && (
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save your story'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
