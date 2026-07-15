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
import { useApi, useDashboard, useRequireRole } from '@/components/dashboard/dashboard-provider';
import { ApiRequestError, type SetupStep } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/primitives';

/**
 * Getting live.
 *
 * The steps come from the SERVER — from the same function that decides whether
 * publishing is allowed, and the same one the platform console shows to support.
 *
 * This page used to build its own list from its own queries, which meant three
 * copies of "what is left to do" in one product: this page, the publish gate, and
 * the admin console. They had already drifted. One could tell an owner they were
 * ready while another refused to publish them, and nothing on screen said which was
 * lying.
 *
 * So: one list, one definition. If the button is disabled, the reason is on this
 * page, in the same words support will read back to them on the phone.
 */
export default function SetupPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { restaurant, can } = useDashboard();
  useRequireRole('MANAGER', '/dashboard/kitchen');

  const { data: readiness, isLoading } = useQuery({
    queryKey: ['publish-readiness', restaurant?.id],
    queryFn: () => api.getPublishReadiness(),
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

  if (!restaurant || isLoading || !readiness) {
    return <Skeleton className="h-96 w-full" />;
  }

  const required = readiness.steps.filter((s) => s.required);
  const optional = readiness.steps.filter((s) => !s.required);
  const { progress, ready } = readiness;

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">
          {restaurant.isPublished ? "You're live" : 'Get set up'}
        </h1>
        <p className="mt-1 text-muted-foreground">
          {restaurant.isPublished
            ? 'Your ordering page is open. Here are a few things worth finishing.'
            : `${progress.done} of ${progress.total} required steps done.`}
        </p>
      </div>

      {/* Progress. Concrete steps, not a vanity percentage. */}
      {!restaurant.isPublished && (
        <div className="flex gap-1.5">
          {required.map((step) => (
            <div
              key={step.id}
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
                  {readiness.storefrontUrl?.replace(/^https?:\/\//, '')}
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
          {restaurant.isPublished ? 'The essentials' : 'Before you can take an order'}
        </h2>
        {required.map((step) => (
          <StepCard key={step.id} step={step} />
        ))}
      </section>

      {optional.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Worth doing
          </h2>
          {optional.map((step) => (
            <StepCard key={step.id} step={step} />
          ))}
        </section>
      )}
    </div>
  );
}

/** Step ids come from packages/shared/src/setup.ts. Icons are this layer's business. */
const ICONS: Record<string, typeof Check> = {
  menu: UtensilsCrossed,
  stripe: CreditCard,
  fulfillment: Truck,
  qr: QrCode,
  logo: ImageIcon,
  tax: Globe,
};

function StepCard({ step }: { step: SetupStep }) {
  const Icon = ICONS[step.id] ?? Check;

  return (
    <Card className={step.done ? 'bg-muted/40' : 'card-interactive'}>
      <CardContent className="flex flex-wrap items-center gap-4 p-5">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
            step.done ? 'bg-emerald-100 text-emerald-700' : 'bg-brand-subtle text-brand'
          }`}
        >
          {step.done ? <Check className="h-5 w-5" /> : <Icon className="h-5 w-5" />}
        </div>

        <div className="min-w-0 flex-1">
          <p className={`font-semibold ${step.done ? 'text-muted-foreground' : ''}`}>
            {step.label}
          </p>
          {/* The reason. A checklist that only says WHAT is a chore list; the "why"
              is what turns "connect Stripe" into something worth doing today. */}
          {!step.done && <p className="text-sm text-muted-foreground">{step.why}</p>}
        </div>

        <Button asChild variant={step.done ? 'ghost' : 'default'} size="sm">
          <Link href={step.href}>
            {step.done ? 'Open' : 'Set up'}
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
