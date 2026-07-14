'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, Info, MapPin, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  COUNTRIES,
  deriveLocaleDefaults,
  getCountry,
  type TaxComponent,
} from '@dinedirect/shared';
import { useApi, useDashboard } from './dashboard-provider';
import { ApiRequestError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { Label } from '@/components/ui/primitives';

/**
 * Where the restaurant physically is — and everything that follows from it.
 *
 * This screen did not exist. Country, region, timezone, currency and tax could be set
 * exactly once, in the signup wizard, and never again: the settings page had a tax
 * PERCENTAGE box and nothing else. So a restaurant that picked the wrong country at
 * signup, or moved, or was created before the country picker existed, was stuck being
 * a US business priced in dollars on New York time, with no way to say otherwise.
 *
 * The organising idea is that an address is not five text boxes — it DECIDES things:
 *
 *   country  -> currency (not a choice: a Toronto restaurant is paid in CAD)
 *            -> the timezone list, and the default within it
 *            -> the tax regime and its pre-filled rates
 *            -> what the region and postal fields are even CALLED
 *            -> whether Stripe can pay them at all
 *
 * So changing the country here re-derives all of it in front of the owner, before they
 * save, rather than leaving them to discover the consequences one bug at a time.
 */
export function BusinessLocationForm() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { restaurant, can } = useDashboard();

  const [countryCode, setCountryCode] = useState(restaurant?.country ?? 'US');
  const [street, setStreet] = useState(restaurant?.street ?? '');
  const [city, setCity] = useState(restaurant?.city ?? '');
  const [region, setRegion] = useState(restaurant?.state ?? '');
  const [postalCode, setPostalCode] = useState(restaurant?.postalCode ?? '');
  const [timezone, setTimezone] = useState(restaurant?.timezone ?? 'America/New_York');
  const [tax, setTax] = useState<TaxComponent[]>(restaurant?.taxComponents ?? []);

  const country = getCountry(countryCode);

  /**
   * Changing the country invalidates almost everything below it. A province from the
   * old country is not a province of the new one, and a timezone from the old country
   * is not offered in the new one — carrying either across is how you end up with a
   * restaurant in "Ontario, Australia" on Toronto time.
   *
   * So: wipe the region, and re-derive the timezone and tax from the new country.
   */
  function changeCountry(code: string) {
    const next = deriveLocaleDefaults(code, '');
    setCountryCode(code);
    setRegion('');
    setTimezone(next.timezone);
    setTax(next.taxComponents);
  }

  /** A new region within the same country changes the tax, and nothing else. */
  function changeRegion(value: string) {
    setRegion(value);
    setTax(deriveLocaleDefaults(countryCode, value).taxComponents);
  }

  const save = useMutation({
    mutationFn: () =>
      api.updateCurrent({
        address: { street, city, state: region, postalCode, country: countryCode },
        timezone,
        taxComponents: tax,
        // Only meaningful where we model the regime. Elsewhere the components stand
        // on their own and there is nothing to resolve them against.
        ...(country.taxRegime ? { taxCountry: country.taxRegime, taxRegion: region } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.success(`Saved. Prices are in ${country.currency}, on ${timezone} time.`);
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not save'),
  });

  if (!restaurant) return null;
  const readOnly = !can('MANAGER');

  const combinedBps = tax.reduce((sum, c) => sum + c.rateBps, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MapPin className="h-4 w-4" />
          Where you are
        </CardTitle>
        <CardDescription>
          Your address sets your currency, your opening times and your tax. Get this right and
          the rest follows.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        <div>
          <Label htmlFor="country">Country</Label>
          <Select
            id="country"
            value={countryCode}
            onChange={(e) => changeCountry(e.target.value)}
            disabled={readOnly}
          >
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>

        {/*
          Stripe does not pay out to every country we otherwise support — India is the
          big one. Saying so HERE, next to the country picker, is the difference between
          an informed choice and a restaurant that finishes onboarding, uploads a menu,
          prints QR codes, and only then discovers it cannot be paid.
        */}
        {!country.stripeSupported && (
          <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Stripe cannot pay out to businesses in {country.name} yet. You can still take
              orders, print QR codes and run your kitchen — but online card payments will be
              unavailable, so you would be collecting cash on delivery or at the counter.
            </span>
          </p>
        )}

        <div>
          <Label htmlFor="street">Street address</Label>
          <Input
            id="street"
            value={street}
            onChange={(e) => setStreet(e.target.value)}
            disabled={readOnly}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <Label htmlFor="city">City</Label>
            <Input
              id="city"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              disabled={readOnly}
            />
          </div>

          {/* The label is the country's word for it. Nobody in Toronto is looking for a
              field called "State", and nobody in London is looking for one at all. */}
          <div>
            <Label htmlFor="region">{country.regionLabel}</Label>
            {country.regions.length > 0 ? (
              <Select
                id="region"
                value={region}
                onChange={(e) => changeRegion(e.target.value)}
                disabled={readOnly}
              >
                <option value="">Select…</option>
                {country.regions.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                id="region"
                value={region}
                onChange={(e) => changeRegion(e.target.value)}
                disabled={readOnly}
              />
            )}
          </div>

          <div>
            <Label htmlFor="postalCode">{country.postalLabel}</Label>
            <Input
              id="postalCode"
              value={postalCode}
              onChange={(e) => setPostalCode(e.target.value)}
              disabled={readOnly}
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="timezone">Timezone</Label>
            {/* A country with one timezone gets no picker. Asking someone in Bengaluru to
                choose between one option is a form asking a question it knows the answer to. */}
            {country.timezones.length > 1 ? (
              <Select
                id="timezone"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                disabled={readOnly}
              >
                {country.timezones.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz.replace(/_/g, ' ').replace('/', ' — ')}
                  </option>
                ))}
              </Select>
            ) : (
              <p className="flex h-10 items-center text-sm text-muted-foreground">
                {timezone.replace(/_/g, ' ').replace('/', ' — ')}
              </p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              Your opening hours are read in this timezone.
            </p>
          </div>

          <div>
            <Label>Currency</Label>
            <p className="flex h-10 items-center gap-1.5 text-sm font-medium">
              {country.currencySymbol} {country.currency}
            </p>
            {/* Deliberately not editable. Letting a Toronto restaurant pick USD does not
                convert their menu — it just relabels every price, at a 35% discount. */}
            <p className="mt-1 text-xs text-muted-foreground">
              Set by your country. Your menu prices are in {country.currency}.
            </p>
          </div>
        </div>

        {/* ---------------------------------------------------------------- Tax */}
        <div className="space-y-3 rounded-lg border p-4">
          <div>
            <p className="text-sm font-medium">Tax</p>
            <p className="text-xs text-muted-foreground">
              {country.taxRegime
                ? `Pre-filled for ${region || country.name}. Check it — you are the one who has to remit it.`
                : `We don't model ${country.name} tax. Enter the rate you charge.`}
            </p>
          </div>

          {/*
            The US is the honest special case. There are ~11,000 sales-tax jurisdictions
            and the rate depends on the county and the city, not just the state — so the
            number we pre-fill is the STATE BASE and it is very likely not what they
            actually charge. Saying so is the only defensible thing to do; a silent
            pre-fill here would have restaurants under-collecting and finding out later.
          */}
          {country.taxRegime === 'US' && (
            <p className="flex items-start gap-2 rounded-lg bg-muted p-3 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                This is the {region || 'state'} base rate only. US sales tax also has county and
                city components that we cannot know — check your actual combined rate and
                correct it here.
              </span>
            </p>
          )}

          {tax.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No tax charged. If that&rsquo;s wrong, add a line.
            </p>
          )}

          {tax.map((component, i) => (
            <div key={i} className="flex items-end gap-2">
              <div className="flex-1">
                <Label htmlFor={`tax-name-${i}`} className="text-xs">
                  Name on receipt
                </Label>
                <Input
                  id={`tax-name-${i}`}
                  value={component.name}
                  placeholder="VAT"
                  onChange={(e) =>
                    setTax(tax.map((c, j) => (i === j ? { ...c, name: e.target.value } : c)))
                  }
                  disabled={readOnly}
                />
              </div>
              <div className="w-28">
                <Label htmlFor={`tax-rate-${i}`} className="text-xs">
                  Rate %
                </Label>
                <Input
                  id={`tax-rate-${i}`}
                  type="number"
                  step="0.001"
                  value={(component.rateBps / 100).toString()}
                  onChange={(e) =>
                    setTax(
                      tax.map((c, j) =>
                        i === j
                          ? // Basis points, because Quebec's QST is 9.975% and a percentage
                            // field that rounds to 9.98 overcharges every order in the province.
                            { ...c, rateBps: Math.round(parseFloat(e.target.value || '0') * 100) }
                          : c,
                      ),
                    )
                  }
                  disabled={readOnly}
                />
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove ${component.name || 'tax line'}`}
                onClick={() => setTax(tax.filter((_, j) => j !== i))}
                disabled={readOnly}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}

          {tax.length < 4 && !readOnly && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setTax([...tax, { name: '', rateBps: 0 }])}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add a tax line
            </Button>
          )}

          {/* Two lines that each look right can still add up to a rate that is obviously
              wrong, and the combined number is the one the owner actually recognises. */}
          {tax.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Customers pay <strong>{(combinedBps / 100).toFixed(3).replace(/\.?0+$/, '')}%</strong>{' '}
              tax in total
              {tax.length > 1 && `, printed as ${tax.length} separate lines on their receipt`}.
            </p>
          )}
        </div>

        {!readOnly && (
          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending || !street.trim() || !city.trim()}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
