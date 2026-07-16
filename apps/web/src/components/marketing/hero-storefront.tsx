import { ShoppingCart } from 'lucide-react';

/**
 * A branded-storefront preview: a browser window showing what a restaurant's own
 * ordering site looks like — their name, a hero banner, menu cards, and a live cart.
 * Pairs with the delivery-tracking widget so the hero shows both halves of the
 * product at a glance: the customer's site, and the order moving through it.
 *
 * Uses emoji rather than image assets so it renders anywhere with no CDN/host setup.
 */
const MENU: Array<[string, string, string]> = [
  ['🍔', 'Smash burger', '14.99'],
  ['🍟', 'Truffle fries', '7.50'],
  ['🥤', 'Shake', '5.99'],
];

export function HeroStorefrontWidget() {
  return (
    <div className="card-interactive overflow-hidden rounded-3xl border bg-foreground p-0 text-background">
      {/* Browser chrome */}
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
        <div className="ml-2 flex-1 truncate rounded-md bg-white/10 px-3 py-1 text-center text-xs text-background/60">
          bellaburger.dinedirect.app
        </div>
      </div>

      <div className="p-5">
        {/* Restaurant header */}
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand text-2xl">
            🍔
          </div>
          <div>
            <p className="font-bold leading-tight">Bella Burger</p>
            <p className="text-xs text-background/60">Burgers · Toronto, ON</p>
          </div>
        </div>

        {/* Hero banner */}
        <div
          className="relative mt-4 flex items-center justify-between overflow-hidden rounded-2xl border border-white/10 p-4"
          style={{
            background:
              'linear-gradient(135deg, color-mix(in srgb, var(--brand) 30%, transparent), transparent 70%)',
          }}
        >
          <div className="text-5xl">🍔</div>
          <span className="rounded-lg bg-brand px-4 py-2 text-sm font-bold text-brand-foreground shadow-soft">
            Order now
          </span>
        </div>

        {/* Menu cards */}
        <div className="mt-4 grid grid-cols-3 gap-2.5">
          {MENU.map(([emoji, name, price]) => (
            <div key={name} className="rounded-xl border border-white/10 bg-white/5 p-2.5">
              <div className="text-xl">{emoji}</div>
              <p className="mt-1 truncate text-xs font-semibold">{name}</p>
              <p className="text-xs font-bold text-brand">${price}</p>
            </div>
          ))}
        </div>

        {/* Live cart bar */}
        <div className="mt-4 flex items-center justify-between rounded-xl bg-brand px-4 py-3 text-sm font-bold text-brand-foreground">
          <span className="flex items-center gap-2">
            <ShoppingCart className="h-4 w-4" /> 2 items in cart
          </span>
          <span className="tabular-nums">$28.48 →</span>
        </div>
      </div>
    </div>
  );
}
