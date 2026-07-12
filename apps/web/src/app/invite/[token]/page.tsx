'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SignIn, useAuth } from '@clerk/nextjs';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { ApiRequestError, createDashboardApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

interface InvitePreview {
  email: string;
  role: string;
  restaurantName: string;
  restaurantLogoUrl: string | null;
}

/**
 * Accept a staff invitation.
 *
 * The tricky bit is that the invitee usually has NO account yet. So: show them
 * what they're being invited to first (without requiring a login — the token is
 * the authorisation for that), then make them sign in, then accept.
 *
 * Showing the preview before the sign-in wall matters. "Sign in to see what this
 * link is" is how invitations get ignored.
 */
export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const router = useRouter();

  const [invite, setInvite] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/invites/${token}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body.message ?? 'This invitation is not valid');
        setInvite(body);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [token]);

  const accept = async () => {
    setAccepting(true);
    try {
      const api = createDashboardApi(getToken);
      const result = await api.call<{ restaurantName: string }>(`/invites/${token}/accept`, {
        method: 'POST',
      });
      toast.success(`Welcome to ${result.restaurantName}!`);
      router.push('/dashboard');
    } catch (err) {
      setAccepting(false);
      // The most common failure by far: they signed in with the wrong email. The
      // API says exactly which address the invite was for, so pass that through.
      toast.error(
        err instanceof ApiRequestError ? err.body.message : 'Could not accept the invitation',
      );
    }
  };

  if (error) {
    return (
      <Centered>
        <p className="text-lg font-semibold">This invitation isn&apos;t valid</p>
        <p className="mt-2 text-sm text-muted-foreground">{error}</p>
        <p className="mt-4 text-sm text-muted-foreground">
          Ask whoever invited you to send a new one.
        </p>
      </Centered>
    );
  }

  if (!invite || !isLoaded) {
    return (
      <Centered>
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </Centered>
    );
  }

  return (
    <Centered>
      <div className="w-full max-w-md">
        <Card>
          <CardContent className="space-y-5 p-8 text-center">
            {invite.restaurantLogoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={invite.restaurantLogoUrl}
                alt=""
                className="mx-auto h-14 w-14 rounded-xl object-cover"
              />
            ) : (
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl bg-primary text-xl font-bold text-primary-foreground">
                {invite.restaurantName.charAt(0)}
              </div>
            )}

            <div>
              <h1 className="text-xl font-bold tracking-tight">
                Join {invite.restaurantName}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                You&apos;ve been invited as{' '}
                <strong className="text-foreground">{invite.role.toLowerCase()}</strong>.
              </p>
            </div>

            {isSignedIn ? (
              <>
                <Button
                  size="lg"
                  className="w-full"
                  onClick={accept}
                  disabled={accepting}
                >
                  {accepting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Joining…
                    </>
                  ) : (
                    'Accept invitation'
                  )}
                </Button>
                <p className="text-xs text-muted-foreground">
                  This invitation was sent to <strong>{invite.email}</strong>. You must be signed in
                  with that address for it to work.
                </p>
              </>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Sign in with <strong className="text-foreground">{invite.email}</strong> to accept.
                </p>
                {/* Clerk returns them here after auth, and the accept button appears. */}
                <SignIn
                  routing="hash"
                  fallbackRedirectUrl={`/invite/${token}`}
                  signUpFallbackRedirectUrl={`/invite/${token}`}
                />
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-muted/30 p-4 text-center">
      {children}
    </div>
  );
}
