'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Loader2, MapPin } from 'lucide-react';
import { storefrontApi, type Address, type AddressSuggestion } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/primitives';

/**
 * "Did you mean this exact address?"
 *
 * A delivery address typed free-hand is the most expensive text field in the
 * product: get it slightly wrong and the food is cooked, paid for, dispatched, and
 * handed to the wrong door. So we push the customer to PICK a real, geocoded
 * address, and we keep the coordinates the provider gave us rather than re-deriving
 * them later from a string we already know is fragile.
 *
 * It is an ACCELERANT, never a gate. If no geocoder key is configured, or the
 * provider is down, or the customer's address genuinely isn't in the index (new
 * builds, rural routes, most of the world's informal addressing), they can always
 * ignore the dropdown and type it themselves. A restaurant with no Google key must
 * still be able to take an order.
 */
export function AddressAutocomplete({
  slug,
  value,
  onChange,
  disabled,
}: {
  slug: string;
  value: Address;
  /** Called with the FULL address on pick, or a partial patch on manual typing. */
  onChange: (next: Address) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState(value.street);
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState(false);
  const [highlight, setHighlight] = useState(0);

  const wrapRef = useRef<HTMLDivElement>(null);

  /**
   * One Google Places session token per address search. Google bills a session — every
   * keystroke plus the final details call — as ONE unit; without a token it bills each
   * keystroke separately, so a 30-character address costs ~30x. Regenerated after each
   * pick, because that pick closed the session it belonged to.
   */
  const [session, setSession] = useState(() => crypto.randomUUID());

  /** Keep the visible text in step when a saved address is chosen elsewhere. */
  useEffect(() => {
    setQuery(value.street);
  }, [value.street]);

  /** Click-outside closes the dropdown, like every other combobox on earth. */
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  /**
   * Debounced lookup. 250ms is the sweet spot: short enough to feel instantaneous,
   * long enough that a normal typist fires one request per word rather than per
   * letter. Every request that reaches the provider is billable.
   */
  useEffect(() => {
    // Don't re-query the thing we just autofilled from a pick.
    if (picked) return;
    if (query.trim().length < 3) {
      setSuggestions([]);
      return;
    }

    let cancelled = false;
    setLoading(true);

    const timer = setTimeout(() => {
      void storefrontApi
        .suggestAddresses(slug, query, session)
        .then((res) => {
          // A slow response for a query the customer has already typed past must not
          // overwrite the results for what they're actually looking at now.
          if (cancelled) return;
          setSuggestions(res.suggestions);
          setHighlight(0);
          setOpen(res.suggestions.length > 0);
        })
        // Autocomplete failing is not an error the customer should ever see. They can
        // still type the address by hand, which is exactly what they'd have done
        // before this component existed.
        .catch(() => {
          if (!cancelled) setSuggestions([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      setLoading(false);
      clearTimeout(timer);
    };
  }, [query, slug, session, picked]);

  const pick = useCallback(
    async (suggestion: AddressSuggestion) => {
      setOpen(false);
      setLoading(true);

      try {
        const { address } = await storefrontApi.resolveAddress(slug, suggestion.id, session);

        if (address) {
          setPicked(true);
          setQuery(address.street);
          onChange({
            street: address.street,
            city: address.city,
            state: address.state,
            postalCode: address.postalCode,
            country: address.country,
            // The provider's own coordinates, kept verbatim. Re-geocoding this string
            // later would be strictly worse: we would be throwing away the exact point
            // the customer confirmed and guessing at it again from prose.
            ...(address.latitude != null && address.longitude != null
              ? { latitude: address.latitude, longitude: address.longitude }
              : {}),
          });
        } else {
          // The suggestion expired out of the cache. Keep what they typed — silently
          // blanking a customer's address because our cache dropped an entry would be
          // far worse than an unverified one.
          setQuery(suggestion.primary);
          onChange({ ...value, street: suggestion.primary });
        }
      } catch {
        setQuery(suggestion.primary);
        onChange({ ...value, street: suggestion.primary });
      } finally {
        setLoading(false);
        // That pick closed the billing session. The next search starts a new one.
        setSession(crypto.randomUUID());
      }
    },
    [slug, session, onChange, value],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open || suggestions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => (h + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter') {
      // Only swallow Enter when a suggestion is actually highlighted — otherwise we
      // would be blocking form submission for someone who typed their address by hand.
      e.preventDefault();
      void pick(suggestions[highlight]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  /** Everything below the street line, once we know it. */
  const confirmed = useMemo(
    () => picked && value.city && value.postalCode,
    [picked, value.city, value.postalCode],
  );

  return (
    <div className="space-y-2" ref={wrapRef}>
      <Label htmlFor="street">Street address</Label>

      <div className="relative">
        <MapPin className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />

        <Input
          id="street"
          value={query}
          disabled={disabled}
          autoComplete="off"
          placeholder="Start typing your address…"
          className="pl-9 pr-9"
          onChange={(e) => {
            setQuery(e.target.value);
            // They're editing again, so this is no longer a confirmed pick.
            setPicked(false);
            onChange({ ...value, street: e.target.value });
          }}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
          onKeyDown={onKeyDown}
          // Combobox semantics, so screen readers announce the dropdown rather than
          // leaving a blind customer typing into what sounds like a plain text field.
          role="combobox"
          aria-expanded={open}
          aria-controls="address-suggestions"
          aria-autocomplete="list"
        />

        <span className="absolute right-3 top-1/2 -translate-y-1/2">
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : confirmed ? (
            <Check className="h-4 w-4 text-emerald-600" />
          ) : null}
        </span>

        {open && suggestions.length > 0 && (
          <ul
            id="address-suggestions"
            role="listbox"
            className="absolute z-50 mt-1 w-full overflow-hidden rounded-xl border bg-popover shadow-lg"
          >
            {suggestions.map((s, i) => (
              <li key={s.id} role="option" aria-selected={i === highlight}>
                <button
                  type="button"
                  // mousedown, not click: the input's blur would close the dropdown and
                  // unmount this button before a click ever landed on it.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    void pick(s);
                  }}
                  onMouseEnter={() => setHighlight(i)}
                  className={`flex w-full items-start gap-2.5 px-3 py-2.5 text-left text-sm transition-colors ${
                    i === highlight ? 'bg-accent' : ''
                  }`}
                >
                  <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{s.primary}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {s.secondary}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {confirmed && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Check className="h-3 w-3 text-emerald-600" />
          {value.city}, {value.state} {value.postalCode}
        </p>
      )}
    </div>
  );
}
