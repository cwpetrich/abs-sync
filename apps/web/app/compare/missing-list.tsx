'use client';

import { formatBytes, formatDuration } from '@abs-sync/core';
import { useMemo, useState, useTransition } from 'react';
import type { CompareGroupView, MissingBookView } from '../../lib/compare';
import { quickWatchAction, syncBookAction, syncManyAction, type SyncRequestItem } from '../actions';
import { Callout, Pill } from '../components/ui';

function toRequest(book: MissingBookView, copyIndex = -1): SyncRequestItem {
  const copy = copyIndex >= 0 ? (book.copies[copyIndex] ?? book.bestCopy) : book.bestCopy;
  return {
    serverId: copy.serverId,
    itemId: copy.itemId,
    libraryId: copy.libraryId,
    title: book.title,
    author: book.authors[0] ?? null,
    series: book.series[0]?.name ?? null,
  };
}

function seriesLabel(book: MissingBookView): string | null {
  const series = book.series[0];
  if (!series) return null;
  return series.sequence ? `${series.name} #${series.sequence}` : series.name;
}

function JobPill({ job }: { job: MissingBookView['job'] }) {
  if (!job) return null;
  const tone =
    job.status === 'completed'
      ? 'ok'
      : job.status === 'failed'
        ? 'danger'
        : job.status === 'running'
          ? 'accent'
          : 'info';
  const label = job.status === 'running' ? `${job.phase}…` : job.status;
  return <Pill tone={tone}>{label}</Pill>;
}

function BookRow({
  book,
  selected,
  onSelect,
}: {
  book: MissingBookView;
  selected: boolean;
  onSelect: (id: string, on: boolean) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [chosenCopy, setChosenCopy] = useState(-1);

  const canDownload = book.copies.some((copy) => copy.canDownload);
  const alreadyHandled = book.job?.status === 'completed' || book.job?.status === 'running';

  function sync() {
    setMessage(null);
    startTransition(async () => {
      const result = await syncBookAction(toRequest(book, chosenCopy));
      if (!result.ok) {
        setMessage({ tone: 'danger', text: result.error });
        return;
      }
      setMessage({
        tone: 'ok',
        text: result.data.status === 'duplicate' ? 'Already queued' : 'Queued',
      });
    });
  }

  return (
    <li className="flex flex-wrap items-start gap-3 border-t border-[var(--color-line)] px-4 py-3 first:border-t-0">
      <input
        type="checkbox"
        className="mt-1"
        checked={selected}
        disabled={!canDownload}
        onChange={(event) => onSelect(book.id, event.target.checked)}
        aria-label={`Select ${book.title}`}
      />

      {/* eslint-disable-next-line @next/next/no-img-element -- proxied remote cover, no known dimensions */}
      <img
        src={`/api/cover/${book.bestCopy.serverId}/${book.bestCopy.itemId}`}
        alt=""
        width={40}
        height={60}
        loading="lazy"
        className="h-15 w-10 shrink-0 rounded bg-[var(--color-surface-3)] object-cover"
      />

      <div className="min-w-56 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{book.title}</span>
          {book.status === 'uncertain' ? (
            <Pill tone="warn" title={book.nearest?.reasons.join(', ')}>
              maybe a duplicate
            </Pill>
          ) : null}
          <JobPill job={book.job} />
        </div>

        <p className="text-sm text-[var(--color-ink-muted)]">
          {book.authors.join(', ') || 'Unknown author'}
          {seriesLabel(book) ? ` · ${seriesLabel(book)}` : ''}
        </p>

        <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">
          {formatDuration(book.durationSec)} · {formatBytes(book.sizeBytes)}
          {book.bestCopy.numAudioFiles ? ` · ${book.bestCopy.numAudioFiles} files` : ''}
          {book.narrators.length > 0 ? ` · read by ${book.narrators.join(', ')}` : ''}
          {book.asin ? ` · ASIN ${book.asin}` : ''}
        </p>

        {book.status === 'uncertain' && book.nearest ? (
          <p className="mt-1 text-xs text-[var(--color-warn)]">
            You may already have “{book.nearest.title}” by{' '}
            {book.nearest.authors.join(', ') || 'unknown'} ({Math.round(book.nearest.score * 100)}%
            match: {book.nearest.reasons.join(', ')})
          </p>
        ) : null}

        {message ? (
          <p
            className="mt-1 text-xs"
            style={{
              color: message.tone === 'ok' ? 'var(--color-ok)' : 'var(--color-danger)',
            }}
          >
            {message.text}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col items-end gap-1">
        {book.copies.length > 1 ? (
          <select
            className="field w-auto py-1 text-xs"
            value={chosenCopy}
            onChange={(event) => setChosenCopy(Number(event.target.value))}
            aria-label="Choose which server to pull from"
          >
            <option value={-1}>
              best: {book.bestCopy.serverName} ({formatBytes(book.bestCopy.sizeBytes)})
            </option>
            {book.copies.map((copy, index) => (
              <option key={`${copy.serverId}:${copy.itemId}`} value={index} disabled={!copy.canDownload}>
                {copy.serverName} · {formatBytes(copy.sizeBytes)}
                {copy.canDownload ? '' : ' (no download)'}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-xs text-[var(--color-ink-faint)]">
            from {book.bestCopy.serverName}
          </span>
        )}

        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={pending || !canDownload || alreadyHandled}
          onClick={sync}
          title={
            !canDownload
              ? 'No source server offering this book allows downloads'
              : alreadyHandled
                ? 'Already queued or synced'
                : undefined
          }
        >
          {pending ? 'Queueing…' : alreadyHandled ? 'Queued' : 'Sync'}
        </button>
      </div>
    </li>
  );
}

function GroupSection({
  group,
  selected,
  onSelect,
  onSelectMany,
}: {
  group: CompareGroupView;
  selected: Set<string>;
  onSelect: (id: string, on: boolean) => void;
  onSelectMany: (ids: string[], on: boolean) => void;
}) {
  const [open, setOpen] = useState(true);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const syncableIds = group.items
    .filter((book) => book.copies.some((copy) => copy.canDownload))
    .map((book) => book.id);
  const allSelected = syncableIds.length > 0 && syncableIds.every((id) => selected.has(id));

  const isSeriesGroup = group.key.startsWith('series:');
  const seriesName = group.items[0]?.series[0]?.name ?? group.label;

  function syncGroup() {
    setMessage(null);
    const items = group.items
      .filter((book) => book.copies.some((copy) => copy.canDownload))
      .map((book) => toRequest(book));
    startTransition(async () => {
      const result = await syncManyAction(items);
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      setMessage(
        `Queued ${result.data.queued}` +
          (result.data.duplicates > 0 ? `, ${result.data.duplicates} already queued` : '') +
          (result.data.failures.length > 0 ? `, ${result.data.failures.length} failed` : ''),
      );
    });
  }

  function watchSeries() {
    setMessage(null);
    startTransition(async () => {
      const result = await quickWatchAction(seriesName, group.items[0]?.authors[0] ?? null);
      setMessage(result.ok ? `Now watching “${seriesName}”` : result.error);
    });
  }

  return (
    <section className="card overflow-hidden">
      <header className="flex flex-wrap items-center gap-3 bg-[var(--color-surface-2)] px-4 py-2.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <span aria-hidden className="text-[var(--color-ink-faint)]">
            {open ? '▾' : '▸'}
          </span>
          <span className="truncate font-medium">{group.label}</span>
          <span className="text-xs text-[var(--color-ink-faint)] tabular-nums">
            {group.items.length} book{group.items.length === 1 ? '' : 's'} ·{' '}
            {formatBytes(group.totalBytes)}
          </span>
        </button>

        <div className="flex flex-wrap items-center gap-2">
          {syncableIds.length > 0 ? (
            <label className="flex items-center gap-1.5 text-xs text-[var(--color-ink-muted)]">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={(event) => onSelectMany(syncableIds, event.target.checked)}
              />
              select all
            </label>
          ) : null}
          {isSeriesGroup ? (
            <button type="button" className="btn btn-sm" disabled={pending} onClick={watchSeries}>
              Auto-sync this series
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-sm"
            disabled={pending || syncableIds.length === 0}
            onClick={syncGroup}
          >
            Sync all {syncableIds.length > 0 ? `(${syncableIds.length})` : ''}
          </button>
        </div>
      </header>

      {message ? (
        <p className="border-t border-[var(--color-line)] px-4 py-2 text-xs text-[var(--color-ink-muted)]">
          {message}
        </p>
      ) : null}

      {open ? (
        <ul>
          {group.items.map((book) => (
            <BookRow
              key={book.id}
              book={book}
              selected={selected.has(book.id)}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function MissingList({ groups }: { groups: CompareGroupView[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const byId = useMemo(() => {
    const map = new Map<string, MissingBookView>();
    for (const group of groups) for (const book of group.items) map.set(book.id, book);
    return map;
  }, [groups]);

  const selectedBytes = useMemo(() => {
    let total = 0;
    for (const id of selected) total += byId.get(id)?.sizeBytes ?? 0;
    return total;
  }, [selected, byId]);

  function onSelect(id: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function onSelectMany(ids: string[], on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  function syncSelected() {
    setMessage(null);
    const items = [...selected]
      .map((id) => byId.get(id))
      .filter((book): book is MissingBookView => Boolean(book))
      .map((book) => toRequest(book));

    startTransition(async () => {
      const result = await syncManyAction(items);
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      setSelected(new Set());
      setMessage(
        `Queued ${result.data.queued} book(s)` +
          (result.data.duplicates > 0 ? `, ${result.data.duplicates} already queued` : '') +
          (result.data.failures.length > 0 ? `. Problems: ${result.data.failures.join('; ')}` : ''),
      );
    });
  }

  return (
    <div className="space-y-4">
      {message ? <Callout tone="info">{message}</Callout> : null}

      <div className="space-y-4 pb-20">
        {groups.map((group) => (
          <GroupSection
            key={group.key}
            group={group}
            selected={selected}
            onSelect={onSelect}
            onSelectMany={onSelectMany}
          />
        ))}
      </div>

      {selected.size > 0 ? (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--color-line)] bg-[var(--color-surface-2)]/95 backdrop-blur">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
            <span className="text-sm">
              <strong className="tabular-nums">{selected.size}</strong> selected ·{' '}
              {formatBytes(selectedBytes)} to transfer
            </span>
            <div className="flex gap-2">
              <button type="button" className="btn btn-sm" onClick={() => setSelected(new Set())}>
                Clear
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={pending}
                onClick={syncSelected}
              >
                {pending ? 'Queueing…' : `Sync ${selected.size}`}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
