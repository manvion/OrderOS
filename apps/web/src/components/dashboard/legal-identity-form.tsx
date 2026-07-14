'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, Landmark } from 'lucide-react';
import { toast } from 'sonner';
import { getCountry, isValidTaxId, needsTaxIdForReceipts } from '@dinedirect/shared';
import { useApi, useDashboard } from './dashboard-provider';
import { ApiRequestError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

/**
 * Who the restaurant is to a tax authority.
 *
 * This exists because a receipt is a tax document, and in Canada, India, the UK and
 * Australia it is not a VALID one unless it names the issuing entity and carries that
 * entity's tax number. A restaurant that never fills this in is sending invalid
 * invoices to every customer and will not find out until an audit — so where the
 * country requires a number and we don't have one, this screen says so in red rather
 * than sitting quietly with an empty optional field.
 *
 * Every label here comes from the country. Nobody in Bengaluru is looking for a field
 * called "Tax ID"; they are looking for GSTIN.
 */
export function LegalIdentityForm() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { restaurant } = useDashboard();

  const country = getCountry(restaurant?.country ?? 'US');
  const spec = country.taxId;

  const [legalName, setLegalName] = useState(restaurant?.legalName ?? '');
  const [taxId, setTaxId] = useState(restaurant?.taxId ?? '');
  const [businessNumber, setBusinessNumber] = useState(restaurant?.businessNumber ?? '');

  const save = useMutation({
    mutationFn: () =>
      api.updateCurrent({
        // Empty string means "I don't have one", which is a legitimate answer and must
        // clear the field rather than store "".
        legalName: legalName.trim() || null,
        taxId: taxId.trim() || null,
        businessNumber: businessNumber.trim() || null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['restaurant'] });
      toast.success('Saved. This will appear on your receipts.');
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not save'),
  });

  if (!restaurant) return null;

  // Shape check only, and the copy never claims more than that. A tick that implies
  // "verified with the tax authority" is a lie the restaurant would rely on.
  const looksWrong = taxId.trim().length > 0 && !isValidTaxId(restaurant.country, taxId);
  const missingRequired = needsTaxIdForReceipts(restaurant.country, restaurant.taxId);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Landmark className="h-4 w-4" />
          Legal &amp; tax
        </CardTitle>
        <CardDescription>
          What goes on your receipts. A receipt is a tax document — in {country.name} it must
          say who issued it.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {missingRequired && (
          <p className="flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-sm font-medium text-destructive">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Without your {spec.label}, the receipts you send are not valid tax invoices in{' '}
              {country.name}. Your customers cannot claim them.
            </span>
          </p>
        )}

        <div>
          <label className="text-sm font-medium" htmlFor="legalName">
            Legal business name
          </label>
          <Input
            id="legalName"
            value={legalName}
            onChange={(e) => setLegalName(e.target.value)}
            placeholder={`e.g. 1187456 ${country.regionLabel === 'Province' ? 'Ontario' : ''} Inc.`.replace(
              /\s+/g,
              ' ',
            )}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            The company that issues the invoice, if it differs from &ldquo;{restaurant.name}
            &rdquo;. Leave blank if they are the same.
          </p>
        </div>

        <div>
          <label className="text-sm font-medium" htmlFor="taxId">
            {spec.label}
          </label>
          <Input
            id="taxId"
            value={taxId}
            onChange={(e) => setTaxId(e.target.value.toUpperCase())}
            placeholder={spec.placeholder}
            className={looksWrong ? 'border-destructive' : undefined}
            aria-invalid={looksWrong}
          />
          <p
            className={`mt-1 text-xs ${looksWrong ? 'font-medium text-destructive' : 'text-muted-foreground'}`}
          >
            {looksWrong
              ? `That doesn't look like a ${spec.label} — expected something like ${spec.placeholder}.`
              : spec.help}
          </p>
        </div>

        <div>
          <label className="text-sm font-medium" htmlFor="businessNumber">
            Company registration number{' '}
            <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <Input
            id="businessNumber"
            value={businessNumber}
            onChange={(e) => setBusinessNumber(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Never shown to customers. Kept because your accountant will ask for it.
          </p>
        </div>

        <Button onClick={() => save.mutate()} disabled={save.isPending || looksWrong}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </CardContent>
    </Card>
  );
}
