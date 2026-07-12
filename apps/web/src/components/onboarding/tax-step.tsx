'use client';

import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import {
  CA_PROVINCES,
  US_STATES,
  type TaxComponent,
  type TaxCountry,
} from '@orderos/shared';
import { Input, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/primitives';

const COUNTRY_LABEL: Record<TaxCountry, string> = {
  US: 'United States',
  CA: 'Canada',
  IN: 'India',
};

/** Indian states — the region matters for SGST attribution, not for the rate. */
const IN_STATES = [
  'Andhra Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Delhi', 'Goa', 'Gujarat',
  'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala',
  'Madhya Pradesh', 'Maharashtra', 'Odisha', 'Punjab', 'Rajasthan', 'Tamil Nadu',
  'Telangana', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
];

/**
 * Tax, per jurisdiction.
 *
 * The honest bit, which is stated to the user rather than hidden: we PRE-FILL from
 * a table and make them confirm. For Canada and India that table is reliable. For
 * the US it is the STATE base rate only — real sales tax on prepared food is state
 * + county + city, varies between neighbouring streets, and changes several times a
 * year across ~11,000 jurisdictions.
 *
 * Any product that claims to know a US restaurant's exact tax rate from its state
 * alone is lying. So we don't: we show what we filled in, say plainly that local
 * tax may be on top, and require a tick that they've checked. The tick is the
 * feature.
 */
export function TaxStep({
  country,
  region,
  components,
  indiaHotel,
  confirmed,
  onCountry,
  onRegion,
  onIndiaHotel,
  onComponents,
  onConfirm,
}: {
  country: TaxCountry;
  region: string;
  components: TaxComponent[];
  indiaHotel: boolean;
  confirmed: boolean;
  onCountry: (c: TaxCountry) => void;
  onRegion: (r: string) => void;
  onIndiaHotel: (v: boolean) => void;
  onComponents: (c: TaxComponent[]) => void;
  onConfirm: (v: boolean) => void;
}) {
  const regions =
    country === 'US' ? US_STATES : country === 'CA' ? CA_PROVINCES : IN_STATES;

  const total = components.reduce((s, c) => s + c.rateBps, 0);

  const update = (i: number, patch: Partial<TaxComponent>) =>
    onComponents(components.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));

  return (
    <div className="space-y-4 rounded-xl border border-brand-subtle bg-brand-subtle p-4">
      <div>
        <Label>Sales tax</Label>
        <p className="mt-1 text-xs text-muted-foreground">
          We add this to every order. Get it wrong and you make up the difference yourself.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">Country</Label>
          <Select
            value={country}
            onChange={(e) => onCountry(e.target.value as TaxCountry)}
            className="h-9"
          >
            {(Object.keys(COUNTRY_LABEL) as TaxCountry[]).map((c) => (
              <option key={c} value={c}>
                {COUNTRY_LABEL[c]}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">
            {country === 'CA' ? 'Province' : 'State'}
          </Label>
          <Select value={region} onChange={(e) => onRegion(e.target.value)} className="h-9">
            <option value="">Select…</option>
            {regions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {/* India's 18% rate applies only to restaurants inside hotels with room
          tariffs above ₹7,500 — a fact only they know, so we have to ask. */}
      {country === 'IN' && (
        <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border bg-background p-3 text-sm">
          <input
            type="checkbox"
            checked={indiaHotel}
            onChange={(e) => onIndiaHotel(e.target.checked)}
            className="mt-0.5 h-4 w-4"
          />
          <span>
            We&apos;re inside a hotel with room tariffs above ₹7,500
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Those restaurants charge 18% GST instead of 5%.
            </span>
          </span>
        </label>
      )}

      {/* The components. Editable — because our table is a starting point, not
          the law. */}
      {components.length > 0 ? (
        <div className="space-y-2">
          {components.map((c, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={c.name}
                onChange={(e) => update(i, { name: e.target.value })}
                className="h-9 w-32"
                placeholder="GST"
              />
              <Input
                type="number"
                step="0.001"
                min="0"
                max="30"
                value={(c.rateBps / 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}
                onChange={(e) =>
                  update(i, { rateBps: Math.round(parseFloat(e.target.value || '0') * 100) })
                }
                className="h-9 w-28"
              />
              <span className="text-sm text-muted-foreground">%</span>

              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 text-muted-foreground hover:text-destructive"
                onClick={() => onComponents(components.filter((_, idx) => idx !== i))}
                aria-label="Remove"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}

          <div className="flex items-center justify-between pt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onComponents([...components, { name: '', rateBps: 0 }])}
              disabled={components.length >= 4}
            >
              <Plus className="h-3.5 w-3.5" />
              Add a tax
            </Button>

            <span className="text-sm font-semibold tabular-nums">
              Total {(total / 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%
            </span>
          </div>
        </div>
      ) : (
        <p className="rounded-lg bg-background p-3 text-sm text-muted-foreground">
          {region
            ? 'No sales tax applies here by default. Add one if that’s wrong.'
            : 'Pick your state or province and we’ll fill this in.'}
        </p>
      )}

      {/* The honesty note. Not fine print — it's the most important thing on this
          panel, because a wrong tax rate is the restaurant's liability, not ours. */}
      {country === 'US' && components.length > 0 && (
        <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          This is your <strong>state</strong> rate. US sales tax on prepared food usually has
          county and city tax on top, and it varies street by street. Check your actual rate and
          correct it above.
        </p>
      )}

      <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border bg-background p-3 text-sm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => onConfirm(e.target.checked)}
          className="mt-0.5 h-4 w-4"
        />
        <span>
          I&apos;ve checked this is the right tax for my restaurant.
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {components.length === 0
              ? 'Including that I charge no sales tax at all.'
              : 'You can change it any time in Settings — but only future orders are affected.'}
          </span>
        </span>
      </label>
    </div>
  );
}
