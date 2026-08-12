'use client';

import { useRef, useState, useTransition } from 'react';
import type { PublicWatch } from '../../lib/watches';
import {
  addWatchAction,
  checkWatchNowAction,
  deleteWatchAction,
  quickWatchAction,
  setWatchEnabledAction,
} from '../actions';
import { Callout, Pill, RelativeTime } from '../components/ui';

export interface SeriesSuggestion {
  seriesName: string;
  normSeries: string;
  availableCount: number;
  serverNames: string[];
}

function WatchRow({ watch }: { watch: PublicWatch }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setMessage(result.error ?? 'Failed');
    });
  }

  function checkNow() {
    setMessage(null);
    startTransition(async () => {
      const result = await checkWatchNowAction(watch.id);
      setMessage(
        result.ok
          ? `Checked ${result.data.candidates} book(s) in this series — ${result.data.missing} missing, ${result.data.enqueued} queued`
          : result.error,
      );
    });
  }

  return (
    <li className="border-t border-[var(--color-line)] px-4 py-3 first:border-t-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-56 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{watch.seriesName}</span>
            {!watch.enabled ? <Pill tone="warn">paused</Pill> : null}
            {watch.autoEnqueue ? (
              <Pill tone="ok">auto-sync</Pill>
            ) : (
              <Pill tone="info">notify only</Pill>
            )}
            {watch.syncedCount > 0 ? (
              <Pill tone="accent">{watch.syncedCount} synced</Pill>
            ) : null}
          </div>
          <p className="text-sm text-[var(--color-ink-muted)]">
            {watch.author ? `${watch.author} · ` : ''}into {watch.targetLibraryName} · watching{' '}
            {watch.sourceScope === 'all'
              ? 'all servers'
              : watch.sourceServerNames.join(', ') || 'no servers'}
          </p>
          <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">
            Last checked <RelativeTime date={watch.lastCheckedAt} />
            {watch.lastFoundAt ? (
              <>
                {' · '}last find <RelativeTime date={watch.lastFoundAt} />
              </>
            ) : null}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-sm" disabled={pending} onClick={checkNow}>
            Check now
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={pending}
            onClick={() => run(() => setWatchEnabledAction(watch.id, !watch.enabled))}
          >
            {watch.enabled ? 'Pause' : 'Resume'}
          </button>
          {confirming ? (
            <>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                disabled={pending}
                onClick={() => run(() => deleteWatchAction(watch.id))}
              >
                Really stop
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setConfirming(false)}>
                Keep
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => setConfirming(true)}
            >
              Stop watching
            </button>
          )}
        </div>
      </div>

      {message ? (
        <p className="mt-2 text-xs text-[var(--color-ink-muted)]">{message}</p>
      ) : null}
    </li>
  );
}

function SuggestionRow({ suggestion }: { suggestion: SeriesSuggestion }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-line)] px-4 py-2.5 first:border-t-0">
      <div className="min-w-48 flex-1">
        <span className="text-sm font-medium">{suggestion.seriesName}</span>
        <p className="text-xs text-[var(--color-ink-faint)]">
          {suggestion.availableCount} book(s) on {suggestion.serverNames.join(', ')} · you have none
        </p>
      </div>
      {message ? (
        <span className="text-xs text-[var(--color-ink-muted)]">{message}</span>
      ) : (
        <button
          type="button"
          className="btn btn-sm"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await quickWatchAction(suggestion.seriesName);
              setMessage(result.ok ? 'watching' : result.error);
            })
          }
        >
          Watch
        </button>
      )}
    </li>
  );
}

export function WatchPanel({
  watches,
  suggestions,
  libraries,
  sources,
  canWatch,
}: {
  watches: PublicWatch[];
  suggestions: SeriesSuggestion[];
  libraries: Array<{ id: string; name: string }>;
  sources: Array<{ id: string; name: string }>;
  canWatch: boolean;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);

  // Not a form action: React 19 would reset the fields once it settles, losing
  // the user's input on a failed submit. Clear only on success.
  function submit() {
    const form = formRef.current;
    if (!form || !form.reportValidity()) return;

    setError(null);
    setAdded(false);
    startTransition(async () => {
      const result = await addWatchAction(new FormData(form));
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setAdded(true);
      form.reset();
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="space-y-6">
        <section>
          <h2 className="mb-2 text-sm font-medium text-[var(--color-ink-muted)]">
            Watched series ({watches.length})
          </h2>
          {watches.length === 0 ? (
            <div className="card px-4 py-8 text-center text-sm text-[var(--color-ink-muted)]">
              No series watched yet. Add one on the right, or pick from the suggestions below.
            </div>
          ) : (
            <ul className="card overflow-hidden">
              {watches.map((watch) => (
                <WatchRow key={watch.id} watch={watch} />
              ))}
            </ul>
          )}
        </section>

        {suggestions.length > 0 ? (
          <section>
            <h2 className="mb-2 text-sm font-medium text-[var(--color-ink-muted)]">
              Series on other servers you own none of
            </h2>
            <ul className="card overflow-hidden">
              {suggestions.map((suggestion) => (
                <SuggestionRow key={suggestion.normSeries} suggestion={suggestion} />
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <div className="lg:sticky lg:top-20 lg:self-start">
        <form
          ref={formRef}
          className="card space-y-4 p-5"
          onSubmit={(event) => event.preventDefault()}
        >
          <div>
            <h2 className="font-medium">Watch a series</h2>
            <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
              Every scheduled run re-checks the watched servers. Anything in this series that your
              server does not have gets queued automatically.
            </p>
          </div>

          <div>
            <label className="label" htmlFor="seriesName">
              Series name
            </label>
            <input
              id="seriesName"
              name="seriesName"
              className="field"
              placeholder="The Stormlight Archive"
              required
            />
          </div>

          <div>
            <label className="label" htmlFor="author">
              Author (optional)
            </label>
            <input
              id="author"
              name="author"
              className="field"
              placeholder="Narrows the match if two series share a name"
            />
          </div>

          <div>
            <label className="label" htmlFor="targetLibraryId">
              Sync into
            </label>
            <select id="targetLibraryId" name="targetLibraryId" className="field">
              {libraries.map((library) => (
                <option key={library.id} value={library.id}>
                  {library.name}
                </option>
              ))}
            </select>
          </div>

          {sources.length > 0 ? (
            <fieldset>
              <legend className="label">Watch which servers</legend>
              <p className="mb-1 text-xs text-[var(--color-ink-faint)]">
                Leave all unchecked to watch every enabled server.
              </p>
              <div className="space-y-1 text-sm">
                {sources.map((source) => (
                  <label key={source.id} className="flex items-center gap-2">
                    <input type="checkbox" name="sourceServerIds" value={source.id} />
                    {source.name}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="autoEnqueue" defaultChecked className="mt-1" />
            <span>
              Queue transfers automatically
              <span className="block text-xs text-[var(--color-ink-muted)]">
                Uncheck to only be notified in the activity log. Books your server might already have
                under another title are never queued automatically.
              </span>
            </span>
          </label>

          {error ? <Callout tone="danger">{error}</Callout> : null}
          {added ? <Callout tone="ok">Watch created.</Callout> : null}

          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={pending || !canWatch}
          >
            {pending ? 'Saving…' : 'Watch series'}
          </button>
          {!canWatch ? (
            <p className="text-xs text-[var(--color-warn)]">
              Set a target server with an included library first.
            </p>
          ) : null}
        </form>
      </div>
    </div>
  );
}
