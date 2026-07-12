'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  Check,
  CreditCard,
  Globe,
  Image as ImageIcon,
  QrCode,
  Rocket,
  Truck,
  UtensilsCrossed,
} from 'lucide-react';
import { toast } from 'sonner';
import { useApi, useDashboard } from '@/components/dashboard/dashboard-provider';
import { ApiRequestError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/primitives';

/**
 * Getting live.
 *
 * The old flow scattered this across five pages and a "publish readiness" list of
 * error strings. An owner who has never used the product doesn't know that "menu"
 * and "Stripe" and "delivery" are the things standing between them and taking
 * money — they just know it isn't working, and they leave.
 *
 * So: one screen, ordered by what actually blocks a sale, with the required steps
 * separated from the nice-to-haves. It is the difference between "set this up" and
 * "here are 7 things, good luck".
 */
export default function SetupPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { restaurant, can } = useDashboard();

  const { data: readiness, isLoading } = useQuery({
    queryKey: ['publish-readiness', restaurant?.id],
    queryFn: () => api.getPublishReadiness(),
    enabled: Boolean(restaurant),
  });

  const { data: products } = useQuery({
    queryKey: ['products', restaurant?.id],
    queryFn: () => api.listProducts(),
    enabled: Boolean(restaurant),
  });

  const { data: stripe } = useQuery({
    queryKey: ['stripe', 'status', restaurant?.id],
    queryFn: () => api.getStripeStatus(),
    enabled: Boolean(restaurant),
  });

  const publish = useMutation({
    mutationFn: () => api.publish(),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.success("You're live! Your ordering page is open for business.", { duration: 8000 });
    },
    onError: (err) => {
      const blockers = err instanceof ApiRequestError ? (err.body.blockers as string[]) : undefined;
      toast.error(blockers?.[0] ?? 'Could not publish');
    },
  });

  if (!restaurant || isLoading) {
    return <Skeleton className="h-96 w-full" />;
  }

  const hasMenu = (products?.length ?? 0) > 0;
  const canTakeMoney = Boolean(stripe?.chargesEnabled);
  const hasLogo = Boolean(restaurant.logoUrl);
  const hasDelivery = restaurant.deliveryEnabled || restaurant.pickupEnabled;

  /** Required to take a single order. Everything else can wait. */
  const required = [
    {
      done: hasMenu,
      icon: UtensilsCrossed,
      title: 'Add your menu',
      body: 'At least one item. Categories, photos, and options like size and extras.',
      href: '/dashboard/menu',
      cta: hasMenu ? 'Edit menu' : 'Add your first item',
    },
    {
      done: canTakeMoney,
      icon: CreditCard,
      title: 'Connect Stripe',
      body: "Money goes straight from your customer to your bank. We never hold it.",
      href: '/dashboard/settings',
      cta: canTakeMoney ? 'Manage payments' : 'Connect Stripe',
    },
    {
      done: hasDelivery,
      icon: Truck,
      title: 'Choose how you fulfil orders',
      body: 'Pickup, delivery, dine-in — and your opening hours.',
      href: '/dashboard/settings',
      cta: 'Set it up',
    },
  ];

  /** Real value, but nothing is blocked without them. */
  const optional = [
    {
      done: hasLogo,
      icon: ImageIcon,
      title: 'Add your logo and colours',
      body: 'Your page, your brand — not a generic template.',
      href: '/dashboard/settings',
    },
    {
      done: restaurant.isPublished,
      icon: QrCode,
      title: 'Print your QR codes',
      body: "We make a counter code and a flyer code the moment you publish. Add table codes and print them all on one sheet.",
      href: '/dashboard/qr',
    },
    {
      done: false,
      icon: Globe,
      title: 'Add ordering to your existing website',
      body: 'One line of code on your WordPress, Wix or Squarespace site. Customers never leave it.',
      href: '/dashboard/website',
    },
  ];

  const doneCount = required.filter((s) => s.done).length;
  const ready = readiness?.ready ?? false;

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">
          {restaurant.isPublished ? "You're live" : 'Get set up'}
        </h1>
        <p className="mt-1 text-muted-foreground">
          {restaurant.isPublished
            ? 'Your ordering page is open. Here are a few things worth finishing.'
            : `${doneCount} of ${required.length} required steps done.`}
        </p>
      </div>

      {/* Progress. Concrete, not a vanity percentage. */}
      {!restaurant.isPublished && (
        <div className="flex gap-1.5">
          {required.map((step, i) => (
            <div
              key={i}
              className={`h-1.5 flex-1 rounded-full transition-colors ${
                step.done ? 'bg-emerald-500' : 'bg-muted'
              }`}
            />
          ))}
        </div>
      )}

      {/* The go-live card. Sits at the TOP once they're ready, because at that
          moment it is the only thing they want to do. */}
      {!restaurant.isPublished && ready && can('OWNER') && (
        <Card className="animate-rise border-brand-subtle bg-brand-subtle">
          <CardContent className="flex flex-wrap items-center justify-between gap-4 p-6">
            <div>
              <p className="flex items-center gap-2 text-lg font-bold">
                <Rocket className="h-5 w-5" />
                Everything checks out
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Your page goes live at{' '}
                <span className="font-mono font-medium text-foreground">
                  {readiness?.storefrontUrl?.replace(/^https?:\/\//, '')}
                </span>
              </p>
            </div>
            <Button size="lg" onClick={() => publish.mutate()} disabled={publish.isPending}>
              {publish.isPending ? 'Publishing…' : 'Go live'}
            </Button>
          </CardContent>
        </Card>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Required
        </h2>
        {required.map((step) => (
          <SetupStep key={step.title} {...step} />
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Worth doing
        </h2>
        {optional.map((step) => (
          <SetupStep key={step.title} {...step} cta="Open" />
        ))}
      </section>
    </div>
  );
}

function SetupStep({
  done,
  icon: Icon,
  title,
  body,
  href,
  cta,
}: {
  done: boolean;
  icon: typeof Check;
  title: string;
  body: string;
  href: string;
  cta?: string;
}) {
  return (
    <Card className={done ? 'bg-muted/40' : 'card-interactive'}>
      <CardContent className="flex flex-wrap items-center gap-4 p-5">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
            done ? 'bg-emerald-100 text-emerald-700' : 'bg-brand-subtle text-brand'
          }`}
        >
          {done ? <Check className="h-5 w-5" /> : <Icon className="h-5 w-5" />}
        </div>

        <div className="min-w-0 flex-1">
          <p className={`font-semibold ${done ? 'text-muted-foreground' : ''}`}>{title}</p>
          <p className="text-sm text-muted-foreground">{body}</p>
        </div>

        <Button asChild variant={done ? 'ghost' : 'default'} size="sm">
          <Link href={href}>
            {cta ?? 'Set up'}
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
