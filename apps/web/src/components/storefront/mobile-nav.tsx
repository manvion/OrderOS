'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Menu, X } from 'lucide-react';

/**
 * The storefront's phone-sized navigation.
 *
 * The header's inline links are `hidden sm:block`, so on a phone they all vanish —
 * which used to leave a customer with no way to reach "My orders", "Reserve" or
 * "Catering" from the chrome (the footer is an info panel, not a nav, and the
 * account button has no links). That directly contradicts the header's own rule
 * that the way back to an in-progress order must never disappear. This hamburger
 * restores every one of those links on mobile; it renders nothing at `sm` and up,
 * where the inline links take over.
 */
export function MobileNav({ links }: { links: Array<{ href: string; label: string }> }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="sm:hidden">
      <button
        type="button"
        aria-label="Menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center rounded-lg px-2 py-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </button>

      {open && (
        <>
          {/* Tap anywhere off the menu to close it. */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default"
          />
          {/* Drops below the sticky header (its positioned ancestor), full width. */}
          <div className="absolute inset-x-0 top-full z-50 border-b border-border bg-background shadow-lifted">
            <nav className="container flex flex-col py-2">
              {links.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  prefetch
                  onClick={() => setOpen(false)}
                  className="rounded-lg px-3 py-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  {l.label}
                </Link>
              ))}
            </nav>
          </div>
        </>
      )}
    </div>
  );
}
