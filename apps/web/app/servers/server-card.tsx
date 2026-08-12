'use client';

import { useState, useTransition } from 'react';
import type { PublicServer } from '../../lib/servers';
import type { IndexStatus } from '../../lib/index-manager';
import {
  cancelIndexAction,
  deleteServerAction,
  setLibraryIncludedAction,
  setServerEnabledAction,
  setTargetServerAction,
  startIndexAction,
  verifyServerAction,
} from '../actions';
import { Callout, Pill, RelativeTime } from '../components/ui';

export function ServerCard({
  server,
  indexing,
}: {
  server: PublicServer;
  indexing: IndexStatus | null;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error ?? 'Something went wrong');
    });
  }

  const capabilityWarning =
    server.isTarget && !server.canUpload
      ? 'This is your sync target but its account cannot upload — transfers into it will fail.'
      : !server.isTarget && !server.canDownload
        ? 'This account cannot download, so books cannot be pulled from this server.'
        : null;

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-medium">{server.name}</h3>
            {server.isTarget ? <Pill tone="accent">My server</Pill> : null}
            {!server.enabled ? <Pill tone="warn">Disabled</Pill> : null}
            {server.isAdmin ? <Pill tone="info">admin</Pill> : null}
          </div>
          <p className="mt-1 truncate text-sm text-[var(--color-ink-muted)]">
            <a
              href={server.baseUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="hover:underline"
            >
              {server.baseUrl}
            </a>
          </p>
          <p className="mt-1 text-xs text-[var(--color-ink-faint)]">
            {server.authKind === 'apiKey' ? 'API key' : 'Username & password'}
            {server.accountLabel ? ` · ${server.accountLabel}` : ''}
            {server.serverVersion ? ` · ABS ${server.serverVersion}` : ''}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {indexing ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={pending}
              onClick={() => run(() => cancelIndexAction(server.id))}
            >
              Stop index ({indexing.itemsIndexed.toLocaleString()})
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-sm"
                disabled={pending || !server.enabled}
                onClick={() => run(() => startIndexAction(server.id, 'auto'))}
                title="Fetches only what changed since the last index, when possible"
              >
                Index now
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={pending || !server.enabled}
                onClick={() => run(() => startIndexAction(server.id, 'full'))}
                title="Re-reads every book and reconciles anything deleted upstream"
              >
                Full re-index
              </button>
            </>
          )}
          <button
            type="button"
            className="btn btn-sm"
            disabled={pending}
            onClick={() => run(() => verifyServerAction(server.id))}
          >
            Re-verify
          </button>
          {!server.isTarget ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={pending}
              onClick={() => run(() => setTargetServerAction(server.id))}
              title="Make this the server books are synced into"
            >
              Set as mine
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-sm"
            disabled={pending}
            onClick={() => run(() => setServerEnabledAction(server.id, !server.enabled))}
          >
            {server.enabled ? 'Disable' : 'Enable'}
          </button>
          {confirmingDelete ? (
            <>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                disabled={pending}
                onClick={() => run(() => deleteServerAction(server.id))}
              >
                Really remove
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setConfirmingDelete(false)}
              >
                Keep
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => setConfirmingDelete(true)}
            >
              Remove
            </button>
          )}
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-[var(--color-ink-faint)]">Indexed books</dt>
          <dd className="tabular-nums">{server.itemCount.toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--color-ink-faint)]">Last indexed</dt>
          <dd>
            {indexing ? (
              <span className="text-[var(--color-accent)]">
                {indexing.mode === 'full' ? 'full index…' : 'indexing…'}
              </span>
            ) : (
              <RelativeTime date={server.lastIndexedAt} />
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--color-ink-faint)]">Last full reconcile</dt>
          <dd>
            <RelativeTime date={server.lastFullIndexAt} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--color-ink-faint)]">Last verified</dt>
          <dd>
            <RelativeTime date={server.lastVerifiedAt} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--color-ink-faint)]">Permissions</dt>
          <dd className="flex gap-1">
            <Pill tone={server.canDownload ? 'ok' : 'danger'}>
              {server.canDownload ? 'download' : 'no download'}
            </Pill>
            {server.isTarget ? (
              <Pill tone={server.canUpload ? 'ok' : 'danger'}>
                {server.canUpload ? 'upload' : 'no upload'}
              </Pill>
            ) : null}
          </dd>
        </div>
      </dl>

      <div className="mt-4">
        <p className="label">Libraries to compare</p>
        {server.libraries.length === 0 ? (
          <p className="text-sm text-[var(--color-ink-muted)]">
            No book libraries found. Re-verify after adding one on the server.
          </p>
        ) : (
          <ul className="space-y-1">
            {server.libraries.map((library) => (
              <li key={library.id} className="flex items-center justify-between gap-3 text-sm">
                <label className="flex min-w-0 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={library.included}
                    disabled={pending}
                    onChange={(event) =>
                      run(() => setLibraryIncludedAction(library.id, event.target.checked))
                    }
                  />
                  <span className="truncate">{library.name}</span>
                </label>
                <span className="whitespace-nowrap text-xs text-[var(--color-ink-faint)] tabular-nums">
                  {library.itemCount.toLocaleString()} books
                  {library.folders.length === 0 ? ' · no folder' : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {capabilityWarning ? (
        <div className="mt-4">
          <Callout tone="warn">{capabilityWarning}</Callout>
        </div>
      ) : null}

      {server.lastError ? (
        <div className="mt-4">
          <Callout tone="danger" title="Last error">
            {server.lastError}
          </Callout>
        </div>
      ) : null}

      {error ? (
        <div className="mt-4">
          <Callout tone="danger">{error}</Callout>
        </div>
      ) : null}
    </div>
  );
}
