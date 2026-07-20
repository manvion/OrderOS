'use client';

import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { ChefHat, CreditCard, LayoutDashboard, Monitor, Printer, Store } from 'lucide-react';
import { useDashboard } from '@/components/dashboard/dashboard-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { tenantUrl } from '@/lib/tenant-url';

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
/**
 * Each code is a role-scoped door. Scan it once on the device that lives at that
 * station — the kitchen tablet, the front counter, the wall TV — and it opens
 * exactly the screen that station needs and nothing else. Access is still gated by
 * the sign-in behind the door (a line cook can't reach billing by scanning the
 * kitchen code), so these stay safe to print and tape up. The one exception is the
 * order display, which is a public read-only board with no PII and therefore no
 * login — that's the whole point of a screen customers can see.
 */
type Target = {
  /** Stable id — also the key into the generated-images map. */
  key: string;
  /** The final, absolute URL the code encodes. */
  url: string;
  label: string;
  icon: typeof ChefHat;
  hint: string;
  /** Footer line on the printout. Defaults to "staff sign-in required". */
  footer?: string;
};

export function StaffAccessQrs() {
  const { restaurant } = useDashboard();
  const [images, setImages] = useState<Record<string, string>>({});

  // Every URL is built here because they need the live slug (and the display board
  // lives on the tenant's own storefront host, not the dashboard's apex).
  const targets = useMemo<Target[]>(() => {
    if (!restaurant?.slug) return [];
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const storefront = tenantUrl(restaurant.slug);

    return [
      {
        key: 'pos',
        url: `${origin}/dashboard/pos`,
        label: 'Front desk (POS)',
        icon: Store,
        hint: 'The counter terminal, on a tablet. Ring up walk-in & phone orders, take cash or card, and send deliveries out to Uber or your own driver.',
      },
      {
        key: 'kitchen',
        url: `${origin}/dashboard/kitchen`,
        label: 'Kitchen board',
        icon: ChefHat,
        hint: 'Tape it by the pass. Scan with the kitchen tablet — live orders, status buttons, new-order sound.',
      },
      {
        key: 'display',
        url: `${storefront}/board`,
        label: 'Order display',
        icon: Monitor,
        hint: 'A wall screen showing order numbers as they’re prepared and ready. No login — safe to point a public TV at.',
        footer: 'No sign-in — a public order screen',
      },
      {
        key: 'dashboard',
        url: `${origin}/dashboard`,
        label: 'Owner / manager',
        icon: LayoutDashboard,
        hint: 'The full back office. The screen adapts to who signs in — an owner sees everything; a manager sees day-to-day operations.',
      },
      {
        key: 'app',
        url: `${origin}/get-app?r=${restaurant.slug}`,
        label: 'Payment app',
        icon: CreditCard,
        hint: 'Tap to Pay on a staff phone. Scan to install, sign in, and take card payments in person — no reader.',
      },
    ];
  }, [restaurant?.slug]);

  useEffect(() => {
    let cancelled = false;

    void Promise.all(
      targets.map(async (t) => {
        // Medium error correction and a quiet zone: these get printed on office
        // paper and laminated over, not professionally produced.
        const dataUrl = await QRCode.toDataURL(t.url, { width: 480, margin: 2 });
        return [t.key, dataUrl] as const;
      }),
    ).then((entries) => {
      if (!cancelled) setImages(Object.fromEntries(entries));
    });

    return () => {
      cancelled = true;
    };
  }, [targets]);

  /**
   * A branded page, not a bare printout -- and critically, no raw URL. The
   * old version printed `${origin}${path}` in plain text under the code,
   * which is exactly the platform's own hostname and old brand name sitting
   * in ink on a wall in the kitchen. Nothing here needs to say where it goes;
   * "staff sign-in required" tells a stranger everything they need to know
   * (don't bother scanning it) without telling them anything useful.
   */
  const print = (target: Target) => {
    const img = images[target.key];
    if (!img) return;
    const label = target.label;
    const footer = target.footer ?? 'Staff sign-in required to open';

    const w = window.open('', '_blank');
    if (!w) return;
    const primary = restaurant?.brandPrimaryColor ?? '#ea580c';
    const accent = restaurant?.brandAccentColor ?? '#0f172a';
    const name = restaurant?.name ?? '';
    const mark = restaurant?.logoUrl
      ? `<img src="${restaurant.logoUrl}" alt="" style="width:56px;height:56px;border-radius:16px;object-fit:cover" />`
      : `<div style="width:56px;height:56px;border-radius:16px;background:${primary};color:#fff;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;font-family:Georgia,serif">${(name.charAt(0) || '?').toUpperCase()}</div>`;

    w.document.write(
      `<html><head><title>${label}</title></head>` +
        `<body style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;background:#f5f5f4">` +
        `<div style="width:420px;border-radius:36px;overflow:hidden;background:#fff;box-shadow:0 8px 24px rgba(0,0,0,0.08)">` +
        `<div style="height:14px;background:linear-gradient(90deg,${primary},${accent})"></div>` +
        `<div style="padding:32px;text-align:center">` +
        `${mark}` +
        `<p style="margin:12px 0 24px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${primary}">${name}</p>` +
        `<div style="display:inline-block;padding:16px;border:2px solid ${primary};border-radius:24px">` +
        `<img src="${img}" style="width:280px;height:280px;display:block" />` +
        `</div>` +
        `<h1 style="margin:24px 0 4px;font-size:24px;font-weight:700;color:#1c1917">${label}</h1>` +
        `<p style="margin:0;font-size:13px;color:#78716c">${footer}</p>` +
        `</div></div></body></html>`,
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
        {targets.map((target) => {
          const { key, label, icon: Icon, hint, footer } = target;
          return (
          <div key={key} className="card-interactive space-y-3 p-4">
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-subtle text-brand">
                <Icon className="h-4 w-4" />
              </span>
              <span className="font-medium">{label}</span>
            </div>

            {images[key] ? (
              // Same branded frame as the print version -- a bare matrix on
              // screen just gets printed bare too, because "Print" only ever
              // captures what's already here.
              <div className="w-full max-w-56 overflow-hidden rounded-xl border bg-white">
                <div
                  className="h-2"
                  style={{
                    background: `linear-gradient(90deg, var(--brand), ${restaurant?.brandAccentColor ?? 'var(--brand)'})`,
                  }}
                />
                <div className="space-y-2 p-4 text-center">
                  <div className="flex items-center justify-center gap-2">
                    {restaurant?.logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={restaurant.logoUrl}
                        alt=""
                        className="h-6 w-6 rounded-md object-cover"
                      />
                    ) : (
                      <span className="flex h-6 w-6 items-center justify-center rounded-md bg-brand text-[10px] font-bold text-brand-foreground">
                        {(restaurant?.name.charAt(0) ?? '?').toUpperCase()}
                      </span>
                    )}
                    <span className="text-xs font-bold uppercase tracking-wide text-brand">
                      {restaurant?.name}
                    </span>
                  </div>
                  {/* Plain <img>, deliberately: the source is a local data URL, so
                      next/image's remote-host machinery has nothing to add but ways to fail. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={images[key]} alt={`QR code for the ${label}`} className="mx-auto w-full" />
                  <p className="text-[11px] text-muted-foreground">
                    {footer ?? 'Staff sign-in required'}
                  </p>
                </div>
              </div>
            ) : (
              <div className="aspect-square w-full max-w-56 animate-pulse rounded-xl bg-muted" />
            )}

            <p className="text-xs text-muted-foreground">{hint}</p>

            <Button variant="outline" size="sm" onClick={() => print(target)} disabled={!images[key]}>
              <Printer className="h-3.5 w-3.5" />
              Print
            </Button>
          </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
