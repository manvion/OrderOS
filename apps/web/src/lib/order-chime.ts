'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * The new-order alert sound for the service screens (Orders, POS, Kitchen).
 *
 * Sounds are SYNTHESISED with the Web Audio API rather than shipped as audio files:
 * the dashboard is an offline-capable PWA that runs on a tablet by the pass, and a
 * chime that depends on a network fetch is a chime that goes silent exactly when the
 * wifi drops mid-shift. A few oscillators cost nothing and always play.
 *
 * The preference is per-DEVICE (localStorage), not per-account: whether the counter
 * tablet beeps, and how loud, is a property of that terminal in that room, not of the
 * manager who happens to be logged in.
 */

export type ChimeSound = 'ding' | 'bell' | 'chime' | 'marimba' | 'alert';

export const CHIME_SOUNDS: Array<{ id: ChimeSound; label: string }> = [
  { id: 'ding', label: 'Ding' },
  { id: 'bell', label: 'Bell' },
  { id: 'chime', label: 'Chime' },
  { id: 'marimba', label: 'Marimba' },
  { id: 'alert', label: 'Alert (urgent)' },
];

export interface ChimeSettings {
  enabled: boolean;
  sound: ChimeSound;
  /** 0..1 */
  volume: number;
}

export const DEFAULT_CHIME: ChimeSettings = { enabled: true, sound: 'ding', volume: 0.7 };

const STORAGE_KEY = 'orderChime.settings.v1';

export function loadChimeSettings(): ChimeSettings {
  if (typeof window === 'undefined') return DEFAULT_CHIME;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CHIME;
    const parsed = JSON.parse(raw) as Partial<ChimeSettings>;
    return {
      enabled: parsed.enabled ?? DEFAULT_CHIME.enabled,
      sound: parsed.sound ?? DEFAULT_CHIME.sound,
      volume:
        typeof parsed.volume === 'number'
          ? Math.max(0, Math.min(1, parsed.volume))
          : DEFAULT_CHIME.volume,
    };
  } catch {
    return DEFAULT_CHIME;
  }
}

function persist(settings: ChimeSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private mode / storage disabled — the sound just won't be remembered.
  }
}

// --- Reactive settings store ------------------------------------------------
//
// A tiny external store so every screen that shows the sound state (the control on
// Orders/POS, the "muted" banner in the kitchen) stays in sync the instant the
// preference changes, without prop-drilling or a context provider.

const listeners = new Set<() => void>();
let cached: ChimeSettings | null = null;

/** Current settings, cached so useSyncExternalStore gets a stable snapshot. */
function current(): ChimeSettings {
  if (cached === null) cached = loadChimeSettings();
  return cached;
}

/** Update settings, persist, and notify every subscriber. */
export function setChimeSettings(patch: Partial<ChimeSettings>): void {
  cached = { ...current(), ...patch };
  persist(cached);
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** React binding: `[settings, update]`, kept in sync across all consumers. */
export function useChimeSettings(): [ChimeSettings, (patch: Partial<ChimeSettings>) => void] {
  const settings = useSyncExternalStore(subscribe, current, () => DEFAULT_CHIME);
  return [settings, setChimeSettings];
}

// --- Web Audio synthesis ----------------------------------------------------

let audioCtx: AudioContext | null = null;

/**
 * A single shared AudioContext, resumed on demand.
 *
 * Browsers refuse to play audio until the user has interacted with the page, so the
 * context starts "suspended". `unlockChimeAudio` (called from a click handler) resumes
 * it; after that, chimes triggered by a background poll play fine.
 */
function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) audioCtx = new AC();
  if (audioCtx.state === 'suspended') void audioCtx.resume();
  return audioCtx;
}

/** Call from a user gesture so later, poll-triggered chimes are allowed to sound. */
export function unlockChimeAudio(): void {
  getCtx();
}

interface Tone {
  freq: number;
  /** Seconds from the start of the chime. */
  start: number;
  /** Seconds. */
  dur: number;
  type?: OscillatorType;
}

function playTones(ctx: AudioContext, tones: Tone[], volume: number): void {
  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = Math.max(0, Math.min(1, volume));
  master.connect(ctx.destination);

  for (const t of tones) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = t.type ?? 'sine';
    osc.frequency.value = t.freq;

    // A short attack and an exponential decay — a plucked/struck note, not a beep.
    const s = now + t.start;
    gain.gain.setValueAtTime(0.0001, s);
    gain.gain.exponentialRampToValueAtTime(1, s + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, s + t.dur);

    osc.connect(gain);
    gain.connect(master);
    osc.start(s);
    osc.stop(s + t.dur + 0.03);
  }
}

const SOUND_DEFS: Record<ChimeSound, (ctx: AudioContext, volume: number) => void> = {
  ding: (c, v) => playTones(c, [{ freq: 880, start: 0, dur: 0.55 }], v),
  bell: (c, v) =>
    playTones(
      c,
      [
        { freq: 660, start: 0, dur: 0.8 },
        { freq: 990, start: 0, dur: 0.8 },
        { freq: 1320, start: 0, dur: 0.6 },
      ],
      v * 0.5,
    ),
  chime: (c, v) =>
    playTones(
      c,
      [
        { freq: 523, start: 0, dur: 0.45 },
        { freq: 659, start: 0.12, dur: 0.45 },
        { freq: 784, start: 0.24, dur: 0.6 },
      ],
      v,
    ),
  marimba: (c, v) =>
    playTones(
      c,
      [
        { freq: 587, start: 0, dur: 0.28, type: 'triangle' },
        { freq: 880, start: 0.13, dur: 0.32, type: 'triangle' },
      ],
      v,
    ),
  alert: (c, v) =>
    playTones(
      c,
      [
        { freq: 988, start: 0, dur: 0.18, type: 'square' },
        { freq: 988, start: 0.26, dur: 0.18, type: 'square' },
        { freq: 988, start: 0.52, dur: 0.24, type: 'square' },
      ],
      v * 0.45,
    ),
};

/** Play a chime now. No-op on the server or where Web Audio is unavailable. */
export function playChime(sound: ChimeSound, volume: number): void {
  const ctx = getCtx();
  if (!ctx) return;
  (SOUND_DEFS[sound] ?? SOUND_DEFS.ding)(ctx, volume);
}

// --- The hook ---------------------------------------------------------------

/**
 * Chime when a genuinely NEW incoming order appears (a PENDING one we haven't seen),
 * OR when an order already on the board GAINS items — a new round added to a running
 * dine-in tab, which the kitchen must be told about just like a fresh order.
 *
 * - The first render records the current backlog + item counts silently — reloading the
 *   screen must not blast the chime for every order already on the board.
 * - A plain status change (PENDING → PREPARING) does NOT re-chime; only a new order or
 *   more food does.
 * - Settings are re-read at play time so a change in the control takes effect at once.
 */
export function useNewOrderChime(
  orders: Array<{ id: string; status: string; items?: Array<{ quantity: number }> }> | undefined,
): void {
  // id -> item count last seen, so a growing ticket (an added round) rings too.
  const seen = useRef<Map<string, number> | null>(null);

  useEffect(() => {
    // Resume the audio context on the first interaction anywhere, so the first
    // background-poll chime isn't swallowed by the browser's autoplay policy.
    const unlock = () => unlockChimeAudio();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  useEffect(() => {
    if (!orders) return;
    const countOf = (o: { items?: Array<{ quantity: number }> }) =>
      o.items ? o.items.reduce((n, i) => n + (i.quantity ?? 1), 0) : 0;

    if (seen.current === null) {
      seen.current = new Map(orders.map((o) => [o.id, countOf(o)]));
      return;
    }

    let ring = false;
    for (const o of orders) {
      const prev = seen.current.get(o.id);
      const count = countOf(o);
      if (prev === undefined) {
        // A brand-new order — ring when it lands as a fresh (PENDING) ticket.
        if (o.status === 'PENDING') ring = true;
      } else if (count > prev) {
        // A ticket already on the board grew — a new round was added to a tab.
        ring = true;
      }
      seen.current.set(o.id, count);
    }

    if (ring) {
      const settings = current();
      if (settings.enabled) playChime(settings.sound, settings.volume);
    }
  }, [orders]);
}
