'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { ChefHat, LayoutDashboard, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * QRs for the people RUNNING the restaurant, not the ones eating in it.
 *
 * The customer codes above open the menu. These open the two screens staff live
 * in: the kitchen board (a tablet by the pass) and the owner's dashboard (a phone
 * in a pocket). Scan once, sign in once, pin the tab — that is the entire setup
 * of a kitchen display system, and it is the difference between "the kitchen has
 * a live order board" and "someone has to type a URL on a greasy tablet".
 *
 * Deliberately NOT access grants: each code encodes only the ADDRESS of a
 * sign-in-protected page. Anyone can scan the poster; only staff get past Clerk.
 * That's why these are safe to print and tape to a wall, and why they're rendered
 * client-side with no server state — there is nothing to steal.
 */
const TARGETS = [
  {
    path: '/dashboard/kitchen',
    label: 'Kitchen board',
    icon: ChefHat,
    hint: 'Tape it by the pass. Scan with the kitchen tablet — live orders, status buttons, new-order sound.',
  },
  {
    path: '/dashboard',
    label: 'Owner dashboard',
    icon: LayoutDashboard,
    hint: 'For your own phone. Orders, revenue, analytics — everything, from anywhere.',
  },
] as const;

export function StaffAccessQrs() {
  const [images, setImages] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;

    void Promise.all(
      TARGETS.map(async (t) => {
        const url = `${window.location.origin}${t.path}`;
        // Medium error correction and a quiet zone: these get printed on office
        // paper and laminated over, not professionally produced.
        const dataUrl = await QRCode.toDataURL(url, { width: 480, margin: 2 });
        return [t.path, dataUrl] as const;
      }),
    ).then((entries) => {
      if (!cancelled) setImages(Object.fromEntries(entries));
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const print = (label: string, path: string) => {
    const img = images[path];
    if (!img) return;

    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(
      `<html><head><title>${label}</title></head>` +
        `<body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;font-family:system-ui">` +
        `<img src="${img}" style="width:70vmin;height:70vmin" />` +
        `<h1 style="margin:16px 0 4px;font-size:28px">${label}</h1>` +
        `<p style="margin:0;color:#666">${window.location.origin}${path}</p>` +
        `</body></html>`,
    );
    w.document.close();
    w.focus();
    w.print();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Staff access</CardTitle>
        <CardDescription>
          For your team, not your customers. Each code opens a sign-in-protected screen — safe to
          print and tape to a wall, because scanning it only gets you to the login.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 sm:grid-cols-2">
        {TARGETS.map(({ path, label, icon: Icon, hint }) => (
          <div key={path} className="card-interactive space-y-3 p-4">
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-subtle text-brand">
                <Icon className="h-4 w-4" />
              </span>
              <span className="font-medium">{label}</span>
            </div>

            {images[path] ? (
              // Plain <img>, deliberately: the source is a local data URL, so
              // next/image's remote-host machinery has nothing to add but ways to fail.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={images[path]}
                alt={`QR code for the ${label}`}
                className="w-full max-w-56 rounded-xl border bg-white p-3"
              />
            ) : (
              <div className="aspect-square w-full max-w-56 animate-pulse rounded-xl bg-muted" />
            )}

            <p className="text-xs text-muted-foreground">{hint}</p>

            <Button variant="outline" size="sm" onClick={() => print(label, path)} disabled={!images[path]}>
              <Printer className="h-3.5 w-3.5" />
              Print
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
