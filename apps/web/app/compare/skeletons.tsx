/**
 * Suspense fallbacks for the compare page.
 *
 * These exist so navigating to /compare commits immediately: the diff behind
 * this page takes seconds on a large library, and a page that awaits it before
 * rendering anything leaves the click looking like it did nothing.
 */

function Bar({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-[var(--color-surface-3)] ${className}`} />;
}

export function StatsSkeleton() {
  return (
    <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-hidden>
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="card p-4">
          <Bar className="h-3 w-20" />
          <Bar className="mt-3 h-7 w-16" />
          <Bar className="mt-2 h-3 w-28" />
        </div>
      ))}
    </div>
  );
}

export function FiltersSkeleton() {
  return (
    <div className="card mb-4 flex flex-wrap items-end gap-4 p-4" aria-hidden>
      <div className="min-w-56 flex-1">
        <Bar className="h-3 w-14" />
        <Bar className="mt-2 h-9 w-full" />
      </div>
      <div>
        <Bar className="h-3 w-16" />
        <Bar className="mt-2 h-9 w-32" />
      </div>
      <Bar className="mb-2 h-4 w-40" />
    </div>
  );
}

export function ResultsSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      <p className="sr-only" aria-hidden={false} role="status">
        Comparing libraries…
      </p>
      {[0, 1, 2].map((group) => (
        <div key={group} className="card p-4">
          <Bar className="h-4 w-48" />
          <div className="mt-4 flex flex-col gap-3">
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex items-center gap-3">
                <Bar className="h-14 w-14 shrink-0" />
                <div className="flex-1">
                  <Bar className="h-4 w-2/5" />
                  <Bar className="mt-2 h-3 w-1/4" />
                </div>
                <Bar className="h-8 w-20 shrink-0" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
