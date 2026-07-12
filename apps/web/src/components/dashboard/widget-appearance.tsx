'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import {
  DEFAULT_WIDGET_SETTINGS,
  type WidgetSettings,
} from '@orderos/shared';
import { toast } from 'sonner';
import { useApi } from './dashboard-provider';
import { ApiRequestError, type WebsiteIntegration } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Switch,
} from '@/components/ui/primitives';

const FONT_STACKS = [
  { label: 'Match my website', value: 'inherit' },
  { label: 'System', value: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
  { label: 'Helvetica / Arial', value: 'Helvetica, Arial, sans-serif' },
  { label: 'Georgia (serif)', value: 'Georgia, "Times New Roman", serif' },
  { label: 'Menlo (mono)', value: 'Menlo, Consolas, monospace' },
];

/**
 * Appearance editor, with a live preview of the actual button.
 *
 * The preview is rendered with the same CSS values the loader will use, so what
 * the owner approves here is what lands on their website. Anything less than that
 * and they discover the mismatch on their live site, in front of customers.
 */
export function WidgetAppearance({
  integration,
  onClose,
  onSaved,
}: {
  integration: WebsiteIntegration;
  onClose: () => void;
  onSaved: () => void;
}) {
  const api = useApi();

  const [settings, setSettings] = useState<WidgetSettings>({
    ...DEFAULT_WIDGET_SETTINGS,
    ...(integration.settings as WidgetSettings),
  });
  const [domains, setDomains] = useState<string[]>(integration.allowedDomains);
  const [newDomain, setNewDomain] = useState('');

  const set = <K extends keyof WidgetSettings>(key: K, value: WidgetSettings[K]) =>
    setSettings((s) => ({ ...s, [key]: value }));

  const save = useMutation({
    mutationFn: () =>
      api.updateIntegration(integration.id, { settings, allowedDomains: domains }),
    onSuccess: () => {
      toast.success('Saved — your live site picks this up within a few minutes.');
      onSaved();
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not save'),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Customise the widget</DialogTitle>
          <DialogDescription>
            Changes apply to your live website without you touching its code again.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 md:grid-cols-[1fr_260px]">
          <div className="space-y-5">
            <div className="space-y-2">
              <Label>How it appears</Label>
              <Select
                value={settings.mode}
                onChange={(e) => set('mode', e.target.value as WidgetSettings['mode'])}
              >
                <option value="FLOATING_BUTTON">Floating button (recommended)</option>
                <option value="INLINE_MENU">Menu embedded in the page</option>
                <option value="MANUAL_TRIGGER">My own button opens it</option>
              </Select>
              <p className="text-xs text-muted-foreground">
                {settings.mode === 'INLINE_MENU' &&
                  'Add <div id="orderos-menu"></div> where the menu should appear.'}
                {settings.mode === 'MANUAL_TRIGGER' &&
                  'Call OrderOS.open() from your own button, or OrderOS.attach("#my-button").'}
                {settings.mode === 'FLOATING_BUTTON' &&
                  'A button floats in the corner of every page the snippet is on.'}
              </p>
            </div>

            {settings.mode === 'FLOATING_BUTTON' && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="btn-text">Button text</Label>
                  <Input
                    id="btn-text"
                    value={settings.buttonText}
                    onChange={(e) => set('buttonText', e.target.value)}
                    maxLength={30}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pos">Position</Label>
                  <Select
                    id="pos"
                    value={settings.position}
                    onChange={(e) =>
                      set('position', e.target.value as WidgetSettings['position'])
                    }
                  >
                    <option value="BOTTOM_RIGHT">Bottom right</option>
                    <option value="BOTTOM_LEFT">Bottom left</option>
                    <option value="TOP_RIGHT">Top right</option>
                    <option value="TOP_LEFT">Top left</option>
                  </Select>
                </div>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <ColorField
                label="Button colour"
                value={settings.primaryColor}
                onChange={(v) => set('primaryColor', v)}
              />
              <ColorField
                label="Text colour"
                value={settings.textColor}
                onChange={(v) => set('textColor', v)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="font">Font</Label>
              <Select
                id="font"
                value={settings.fontFamily}
                onChange={(e) => set('fontFamily', e.target.value)}
              >
                {FONT_STACKS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                We never load a webfont onto your site — that would slow it down and shift your
                layout. We use fonts your visitors already have.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="radius">Corner roundness — {settings.borderRadius}px</Label>
              <input
                id="radius"
                type="range"
                min={0}
                max={32}
                value={settings.borderRadius}
                onChange={(e) => set('borderRadius', Number(e.target.value))}
                className="w-full"
              />
            </div>

            <div className="space-y-3">
              <ToggleRow
                label="Show my logo"
                checked={settings.showLogo}
                onChange={(v) => set('showLogo', v)}
              />
              <ToggleRow
                label="Open full screen"
                hint="Always full screen on phones regardless"
                checked={settings.fullPage}
                onChange={(v) => set('fullPage', v)}
              />
              <ToggleRow
                label="Hide the button when closed"
                hint="Rather than letting people start an order you can't cook"
                checked={settings.hideWhenClosed}
                onChange={(v) => set('hideWhenClosed', v)}
              />
            </div>

            {/* Allowed domains */}
            <div className="space-y-2">
              <Label>Allowed domains</Label>
              <p className="text-xs text-muted-foreground">
                The widget only runs on these. A copy of your snippet pasted onto any other site
                simply won&apos;t work.
              </p>

              <div className="space-y-2">
                {domains.map((d) => (
                  <div key={d} className="flex items-center gap-2 rounded-lg border px-3 py-2">
                    <span className="flex-1 font-mono text-sm">{d}</span>
                    <button
                      type="button"
                      onClick={() => setDomains(domains.filter((x) => x !== d))}
                      // Removing the last domain would silently brick the widget,
                      // and the API rejects an empty list anyway.
                      disabled={domains.length === 1}
                      className="text-muted-foreground hover:text-destructive disabled:opacity-30"
                      aria-label={`Remove ${d}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>

              <div className="flex gap-2">
                <Input
                  value={newDomain}
                  onChange={(e) => setNewDomain(e.target.value)}
                  placeholder="shop.joesburgers.com"
                  className="h-9"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const d = newDomain.trim().toLowerCase();
                    if (d && !domains.includes(d)) setDomains([...domains, d]);
                    setNewDomain('');
                  }}
                  disabled={!newDomain.trim()}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add
                </Button>
              </div>
            </div>
          </div>

          {/* Live preview */}
          <div className="space-y-2">
            <Label>Preview</Label>
            <div className="relative h-[340px] overflow-hidden rounded-xl border bg-slate-100">
              {/* A fake website, so the button is judged in context rather than
                  floating on a white square. */}
              <div className="space-y-2 p-4 opacity-40">
                <div className="h-3 w-2/3 rounded bg-slate-300" />
                <div className="h-2 w-full rounded bg-slate-300" />
                <div className="h-2 w-5/6 rounded bg-slate-300" />
                <div className="mt-4 h-20 w-full rounded bg-slate-300" />
                <div className="h-2 w-full rounded bg-slate-300" />
                <div className="h-2 w-4/6 rounded bg-slate-300" />
              </div>

              <button
                type="button"
                onClick={() => toast.info('This is how your button will look and behave.')}
                style={{
                  position: 'absolute',
                  background: settings.primaryColor,
                  color: settings.textColor,
                  borderRadius: settings.borderRadius,
                  fontFamily:
                    settings.fontFamily === 'inherit' ? undefined : settings.fontFamily,
                  boxShadow: '0 4px 14px rgba(0,0,0,.18)',
                  padding: '12px 20px',
                  fontWeight: 600,
                  fontSize: 14,
                  ...positionStyle(settings.position),
                }}
              >
                {settings.buttonText}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              {settings.mode === 'FLOATING_BUTTON'
                ? 'Roughly what your visitors will see.'
                : 'This mode has no floating button.'}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function positionStyle(position: WidgetSettings['position']): React.CSSProperties {
  switch (position) {
    case 'BOTTOM_LEFT':
      return { bottom: 16, left: 16 };
    case 'TOP_RIGHT':
      return { top: 16, right: 16 };
    case 'TOP_LEFT':
      return { top: 16, left: 16 };
    default:
      return { bottom: 16, right: 16 };
  }
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex gap-2">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="h-10 w-12 cursor-pointer rounded border"
          aria-label={label}
        />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="font-mono"
        />
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
