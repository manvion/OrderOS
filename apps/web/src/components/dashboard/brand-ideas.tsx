'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, Sparkles, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { useApi } from './dashboard-provider';
import { ApiRequestError, type BrandIdea } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * "I don't have a name or a logo yet."
 *
 * Free OpenRouter text models can't draw a logo, but they are good at naming and
 * at picking a tasteful two-colour palette — and a clean monogram from that IS a
 * usable logo for a small restaurant on day one. So the AI returns a few
 * name + palette + font ideas, we render each as an SVG lettermark, and the owner
 * picks: take the name, take the monogram as their logo, or both.
 *
 * The monogram is rasterised to PNG in the browser before upload, so it flows
 * through the exact same logo pipeline as any uploaded image — no new storage path,
 * no SVG-sanitisation questions.
 */
const FONT_STACK: Record<BrandIdea['font'], string> = {
  serif: 'Georgia, "Times New Roman", serif',
  sans: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  script: '"Brush Script MT", "Segoe Script", cursive',
};

function monogramSvgString(idea: BrandIdea, size = 512): string {
  const font = FONT_STACK[idea.font] ?? FONT_STACK.sans;
  const r = Math.round(size * 0.18);
  const initials = idea.initials.replace(/[<>&"']/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${r}" fill="${idea.bg}"/>
  <text x="50%" y="52%" text-anchor="middle" dominant-baseline="central" font-family='${font}' font-size="${Math.round(size * 0.44)}" font-weight="700" fill="${idea.fg}">${initials}</text>
</svg>`;
}

/** Rasterise the monogram SVG to a 512px PNG File the logo endpoint accepts. */
async function monogramToPng(idea: BrandIdea): Promise<File> {
  const svg = monogramSvgString(idea, 512);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.width = 512;
    img.height = 512;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Could not render the monogram'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');
    ctx.drawImage(img, 0, 0, 512, 512);
    const png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode PNG'))), 'image/png'),
    );
    const safe = idea.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'logo';
    return new File([png], `${safe}.png`, { type: 'image/png' });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function BrandIdeasGenerator() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [brief, setBrief] = useState('');
  const [ideas, setIdeas] = useState<BrandIdea[]>([]);

  const generate = useMutation({
    mutationFn: () => api.generateBrandIdeas(brief.trim() || undefined),
    onSuccess: ({ ideas }) => {
      setIdeas(ideas);
      if (ideas.length === 0) toast('No ideas came back — try a more specific brief.');
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not generate ideas'),
  });

  const useName = useMutation({
    mutationFn: (name: string) => api.updateCurrent({ name }),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.success('Name updated');
    },
    onError: () => toast.error('Could not update the name'),
  });

  const useLogo = useMutation({
    mutationFn: async (idea: BrandIdea) => api.uploadLogo(await monogramToPng(idea)),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.success('Logo set — it appears on your page, QR codes and emails.');
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not set the logo'),
  });

  return (
    <div className="space-y-3 rounded-xl border border-dashed p-4">
      <div>
        <p className="flex items-center gap-1.5 text-sm font-semibold">
          <Wand2 className="h-4 w-4 text-brand" />
          No name or logo yet? Let AI suggest a few
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Describe your place and pick a name and a matching monogram — use one, the other, or both.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Input
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="e.g. cozy Italian trattoria in Montreal"
          className="min-w-56 flex-1"
          onKeyDown={(e) => e.key === 'Enter' && !generate.isPending && generate.mutate()}
        />
        <Button onClick={() => generate.mutate()} disabled={generate.isPending}>
          {generate.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
          {generate.isPending ? 'Thinking…' : ideas.length ? 'More ideas' : 'Generate'}
        </Button>
      </div>

      {ideas.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {ideas.map((idea, i) => {
            const uploading = useLogo.isPending && useLogo.variables === idea;
            return (
              <div key={`${idea.name}-${i}`} className="space-y-2.5 rounded-lg border p-3">
                <div className="flex items-center gap-3">
                  <svg viewBox="0 0 56 56" className="h-14 w-14 shrink-0" aria-hidden>
                    <rect width="56" height="56" rx="10" fill={idea.bg} />
                    <text
                      x="28"
                      y="29"
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontFamily={FONT_STACK[idea.font]}
                      fontSize="25"
                      fontWeight={700}
                      fill={idea.fg}
                    >
                      {idea.initials}
                    </text>
                  </svg>
                  <div className="min-w-0">
                    <p className="truncate font-semibold leading-tight">{idea.name}</p>
                    {idea.tagline && (
                      <p className="truncate text-xs text-muted-foreground">{idea.tagline}</p>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 flex-1 text-xs"
                    disabled={useName.isPending}
                    onClick={() => useName.mutate(idea.name)}
                  >
                    Use name
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 flex-1 text-xs"
                    disabled={useLogo.isPending}
                    onClick={() => useLogo.mutate(idea)}
                  >
                    {uploading ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Check className="h-3 w-3" />
                    )}
                    Use as logo
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
