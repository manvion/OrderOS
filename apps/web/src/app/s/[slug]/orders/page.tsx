'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useCustomerAuth, CLERK_ENABLED } from '@/components/storefront/customer-auth';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Loader2, Search } from 'lucide-react';
import { formatMoney } from '@orderos/shared';
import { toast } from 'sonner';
import { ApiRequestError, storefrontApi } from '@/lib/api';
import { useTenant, useTenantHref } from '@/components/storefront/tenant-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge, Label, Skeleton } from '@/components/ui/primitives';

const LIVE = ['PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'DRIVER_ASSIGNED', 'OUT_FOR_DELIVERY'];

/**
 * "Where's my order?"
 *
 * The tracking link we text is the primary route back to an order, but people
 * close tabs, delete texts, and switch phones. Without this page the only
 * remaining option is phoning a kitchen that is busy cooking their food — bad for
 * them, worse for the restaurant.
 *
 * Two doors, because there are two kinds of customer:
 *
 *  - SIGNED IN: their whole order history, one tap each.
 *  - GUEST: order number + the phone they used. Both are required — order numbers
 *    are sequential (0712-014 implies 0712-013 exists), so number-only lookup
 *    would let anyone read a stranger's order and their home address.
 */
export default function OrdersPage() {
  const restaurant = useTenant();
  const href = useTenantHref();
  const { getToken, isSignedIn } = useCustomerAuth();

  const [orderNumber, setOrderNumber] = useState('');
  const [phone, setPhone] = useState('');
  const [looking, setLooking] = useState(false);

  const { data: profile, isLoading } = useQuery({
    queryKey: ['storefront-profile', restaurant.slug],
    queryFn: async () => {
      const token = await getToken();
      if (!token) return null;
      return storefrontApi.getProfile(restaurant.slug, token);
    },
    enabled: Boolean(isSignedIn),
  });

  const lookup = async (e: React.FormEvent) => {
    e.preventDefault();
    setLooking(true);
    try {
      const order = await storefrontApi.lookupOrder(restaurant.slug, {
        orderNumber: orderNumber.trim(),
        phone: phone.trim(),
      });
      // Straight to the real tracking page — same one the SMS links to.
      window.location.href = href(`/track/${order.trackingToken}`);
    } catch (err) {
      setLooking(false);
      toast.error(
        err instanceof ApiRequestError
          ? err.body.message
          : "We couldn't find that order. Check the details and try again.",
      );
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-8 sm:px-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Your orders</h1>
        <p className="mt-1 text-muted-foreground">Track an order, or reorder a favourite.</p>
      </div>

      {/* Signed in: just show them their orders. */}
      {isSignedIn && (
        <>
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : !profile?.orders.length ? (
          <Card>
            <CardContent className="py-12 text-center">
              <p className="font-medium">No orders yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Your orders will appear here once you&apos;ve placed one.
              </p>
              <Button asChild variant="brand" className="mt-4">
                <Link href={href('/menu')}>Browse the menu</Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {profile.orders.map((order) => {
              const live = LIVE.includes(order.status);

              return (
                <Link
                  key={order.id}
                  href={href(`/track/${order.trackingToken}`)}
                  className="card-interactive flex items-center gap-4 p-5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">#{order.orderNumber}</span>
                      {live ? (
                        // The live order is why they came to this page. Make it obvious.
                        <Badge variant="success" className="gap-1.5">
                          <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-emerald-600" />
                          {order.status.replace(/_/g, ' ').toLowerCase()}
                        </Badge>
                      ) : (
                        <Badge variant="secondary">{order.status.toLowerCase()}</Badge>
                      )}
                    </div>

                    <p className="mt-1 truncate text-sm text-muted-foreground">
                      {order.items.map((i) => `${i.quantity}× ${i.name}`).join(', ')}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {new Date(order.createdAt).toLocaleDateString()} ·{' '}
                      {formatMoney(order.totalCents, order.currency)}
                    </p>
                  </div>

                  <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </Link>
              );
            })}
          </div>
        )}
        </>
      )}

      {/* Guest: look it up by order number + phone. */}
      {!isSignedIn && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Find your order</CardTitle>
            <CardDescription>
              We texted you a tracking link when you ordered. Lost it? Look it up here.
            </CardDescription>
          </CardHeader>

          <CardContent>
            <form onSubmit={lookup} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="order-number">Order number</Label>
                <Input
                  id="order-number"
                  value={orderNumber}
                  onChange={(e) => setOrderNumber(e.target.value)}
                  placeholder="0712-014"
                  required
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  It&apos;s in the text and the email we sent you.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="lookup-phone">The phone number you used</Label>
                <Input
                  id="lookup-phone"
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+1 415 555 0123"
                  required
                  autoComplete="tel"
                />
              </div>

              <Button
                type="submit"
                variant="brand"
                className="w-full"
                disabled={!orderNumber.trim() || phone.trim().length < 7 || looking}
              >
                {looking ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Finding it…
                  </>
                ) : (
                  <>
                    <Search className="h-4 w-4" />
                    Find my order
                  </>
                )}
              </Button>
            </form>

            {/* The account pitch — but only where an account is actually possible.
                Offering to "create an account" on a deployment with no auth
                configured would be a button that goes nowhere. */}
            {CLERK_ENABLED && (
              <div className="mt-6 rounded-xl bg-muted p-4 text-center">
                <p className="text-sm font-medium">Order a lot?</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Create an account and your orders are always here — no lookup, and your address
                  is saved for next time.
                </p>
                <Button asChild variant="outline" size="sm" className="mt-3">
                  <Link href="/sign-in">Create an account</Link>
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <p className="text-center text-sm text-muted-foreground">
        Still stuck?{' '}
        <a href={`tel:${restaurant.phone}`} className="font-medium underline">
          Call {restaurant.name}
        </a>
      </p>
    </div>
  );
}
