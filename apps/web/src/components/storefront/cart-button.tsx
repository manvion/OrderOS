'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ShoppingBag } from 'lucide-react';
import { useCart } from '@/lib/cart-store';
import { useTenantHref } from './tenant-provider';
import { Button } from '@/components/ui/button';

export function CartButton() {
  const itemCount = useCart((s) => s.itemCount());
  const href = useTenantHref();

  // The cart lives in localStorage, so the server renders an empty one and the
  // client renders the real one. Waiting for mount avoids a hydration mismatch
  // (and the badge briefly flashing "0").
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <Button asChild variant="brand" size="sm" className="relative">
      <Link href={href('/cart')}>
        <ShoppingBag className="h-4 w-4" />
        <span className="hidden sm:inline">Cart</span>
        {mounted && itemCount > 0 && (
          <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-foreground px-1 text-xs font-bold text-background">
            {itemCount}
          </span>
        )}
      </Link>
    </Button>
  );
}
