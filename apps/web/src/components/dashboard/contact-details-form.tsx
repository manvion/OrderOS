'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Store } from 'lucide-react';
import { toast } from 'sonner';
import { useApi, useDashboard } from './dashboard-provider';
import { ApiRequestError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/primitives';

/**
 * Name, phone, email — the identity fields.
 *
 * These were set once in the signup wizard and then editable NOWHERE. That is
 * survivable right up until something downstream validates them: Stripe rejects
 * a Connect account whose support phone is "9999999", and the owner who typed a
 * placeholder at signup is now permanently unable to take payments, staring at
 * an error naming a field no screen lets them change. This card is the way out —
 * and the way to fix a typo'd phone number three months in, which every
 * restaurant eventually needs.
 */
export function ContactDetailsForm() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { restaurant, can } = useDashboard();

  const [name, setName] = useState(restaurant?.name ?? '');
  const [phone, setPhone] = useState(restaurant?.phone ?? '');
  const [email, setEmail] = useState(restaurant?.email ?? '');

  const save = useMutation({
    mutationFn: () => api.updateCurrent({ name: name.trim(), phone: phone.trim(), email: email.trim() }),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.success('Details saved');
    },
    onError: (err) =>
      toast.error(err instanceof ApiRequestError ? err.body.message : 'Could not save'),
  });

  if (!restaurant) return null;
  const readOnly = !can('MANAGER');

  const changed =
    name !== restaurant.name || phone !== restaurant.phone || email !== restaurant.email;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Store className="h-4 w-4" />
          Business details
        </CardTitle>
        <CardDescription>
          Your name, phone and email — shown to customers, printed on receipts, and given to
          Stripe as your support contact.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="biz-name">Restaurant name</Label>
          <Input
            id="biz-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={readOnly}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="biz-phone">Phone</Label>
            <Input
              id="biz-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+1 416 555 0123"
              disabled={readOnly}
            />
            {/* Stripe validates this as a REAL number when you connect payments —
                a placeholder here is the thing that just blocked the Stripe setup. */}
            <p className="text-xs text-muted-foreground">
              A real, reachable number with country code. Stripe verifies it when you connect
              payments.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="biz-email">Email</Label>
            <Input
              id="biz-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={readOnly}
            />
          </div>
        </div>

        {!readOnly && changed && (
          <Button onClick={() => save.mutate()} disabled={save.isPending || !name.trim()}>
            {save.isPending ? 'Saving…' : 'Save details'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
