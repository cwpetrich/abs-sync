'use client';

import { useState, useTransition } from 'react';
import { runSchedulerNowAction } from '../actions';

/**
 * Triggers a full scheduled pass on demand: re-index every server, then
 * evaluate every watch. Useful for verifying a watch works without waiting for
 * the interval.
 */
export function RunSchedulerButton() {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        className="btn"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setMessage(null);
            const result = await runSchedulerNowAction();
            if (!result.ok) {
              setMessage(result.error);
              return;
            }
            setMessage(
              `Indexed ${result.data.itemsIndexed.toLocaleString()} books, queued ${result.data.booksQueued}` +
                (result.data.errors.length > 0 ? ` · ${result.data.errors.length} problem(s)` : ''),
            );
          })
        }
      >
        {pending ? 'Running…' : 'Run check now'}
      </button>
      {message ? (
        <span className="max-w-xs text-right text-xs text-[var(--color-ink-muted)]">{message}</span>
      ) : null}
    </div>
  );
}
