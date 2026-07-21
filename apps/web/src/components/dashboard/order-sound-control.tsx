'use client';

import { useState } from 'react';
import { Bell, BellOff, Play } from 'lucide-react';
import {
  CHIME_SOUNDS,
  playChime,
  unlockChimeAudio,
  useChimeSettings,
  type ChimeSettings,
} from '@/lib/order-chime';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { Switch, Label } from '@/components/ui/primitives';

/**
 * The new-order alert control for the service screens.
 *
 * A bell button that shows at a glance whether the terminal will beep, opening a
 * small panel to choose the sound, set the volume, and test it. Every change is a
 * user gesture, which conveniently also unlocks the browser's audio so the next
 * poll-triggered chime is allowed to play.
 */
export function OrderSoundControl() {
  const [open, setOpen] = useState(false);
  const [settings, update] = useChimeSettings();

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={settings.enabled ? 'Order sound on' : 'Order sound off'}
        aria-expanded={open}
        onClick={() => {
          unlockChimeAudio();
          setOpen((v) => !v);
        }}
        className="flex h-9 w-9 items-center justify-center rounded-lg border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {settings.enabled ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default"
          />
          <div className="absolute right-0 top-full z-50 mt-2 w-64 space-y-3 rounded-xl border bg-background p-3 shadow-lifted">
            <div className="flex items-center justify-between">
              <Label htmlFor="chime-enabled" className="text-sm font-semibold">
                New-order sound
              </Label>
              <Switch
                id="chime-enabled"
                checked={settings.enabled}
                onCheckedChange={(v: boolean) => update({ enabled: v })}
              />
            </div>

            <div className={settings.enabled ? 'space-y-3' : 'space-y-3 opacity-50'}>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Sound</Label>
                <Select
                  value={settings.sound}
                  disabled={!settings.enabled}
                  onChange={(e) =>
                    update({ sound: e.target.value as ChimeSettings['sound'] })
                  }
                  className="h-8 text-sm"
                >
                  {CHIME_SOUNDS.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </div>

              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">
                  Volume · {Math.round(settings.volume * 100)}%
                </Label>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(settings.volume * 100)}
                  disabled={!settings.enabled}
                  onChange={(e) => update({ volume: Number(e.target.value) / 100 })}
                  className="w-full accent-brand"
                />
              </div>

              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                disabled={!settings.enabled}
                onClick={() => {
                  unlockChimeAudio();
                  playChime(settings.sound, settings.volume);
                }}
              >
                <Play className="h-3.5 w-3.5" />
                Test sound
              </Button>
            </div>

            <p className="text-[11px] text-muted-foreground">
              Plays on this device when a new order comes in. Saved for this terminal.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
