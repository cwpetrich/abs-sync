'use client';

import { useState, useTransition } from 'react';
import { startIndexAllAction } from './actions';

export function IndexAllButton({ serverIds }: { serverIds: string[] }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        className="btn"
        disabled={pending || serverIds.length === 0}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await startIndexAllAction(serverIds);
            if (!result.ok) setError(result.error);
          })
        }
      >
        {pending ? 'Starting…' : 'Index all servers'}
      </button>
      {error ? <span className="text-xs text-[var(--color-danger)]">{error}</span> : null}
    </div>
  );
}
