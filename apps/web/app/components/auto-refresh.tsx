'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useTransition } from 'react';

/**
 * Periodically refreshes server-rendered data on the current route.
 *
 * Used while indexing or a transfer is in flight. Pauses when the tab is hidden
 * so a backgrounded tab is not polling a SQLite database forever.
 *
 * Each refresh runs inside a transition and the next tick is skipped while one
 * is still in flight. Without that guard, a route slower than the poll interval
 * accumulates overlapping refreshes, and because `router.refresh()` clears the
 * client cache for the current route it also competes with a navigation the user
 * has started — clicking through to a slow page could be restarted repeatedly
 * and never arrive.
 */
export function AutoRefresh({ intervalMs = 4000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // Read through a ref so the interval is not torn down and restarted every
  // time the pending flag flips.
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (pendingRef.current) return;
      startTransition(() => {
        router.refresh();
      });
    }, intervalMs);
    return () => clearInterval(timer);
  }, [router, intervalMs]);

  return null;
}
