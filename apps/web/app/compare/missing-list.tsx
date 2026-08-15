'use client';

import { formatBytes, formatDuration, type CopyChoiceReason, type GroupSort } from '@abs-sync/core';
import { useMemo, useState, useTransition } from 'react';
import type { CompareGroupView, MissingBookView, MissingCopyView } from '../../lib/compare';
import { quickWatchAction, syncBookAction, syncManyAction, type SyncRequestItem } from '../actions';
import { Callout, Pill, RelativeTime } from '../components/ui';

/** Per-book copy selection, keyed by book id. Absent means nothing chosen yet. */
type CopyChoices = Map<string, number>;

/**
 * The copy a sync would pull, or null when the user still has to decide.
 *
 * Copies of a single recording are interchangeable, so defaulting to the best
 * one is a convenience. Copies of *different* recordings are not, so there is
 * deliberately no default — an unmade choice stays unmade rather than quietly
 * becoming whichever edition sorted first.
 */
function resolveCopy(book: MissingBookView, choice: number | undefined): MissingCopyView | null {
  if (choice !== undefined && choice >= 0) return book.copies[choice] ?? null;
  if (book.editionsDiffer) return null;
  return book.bestCopy;
}

/** As `resolveCopy`, but also null when the resolved copy cannot be downloaded. */
function syncableCopy(book: MissingBookView, choice: number | undefined): MissingCopyView | null {
  const copy = resolveCopy(book, choice);
  return copy?.canDownload ? copy : null;
}

function toRequest(book: MissingBookView, copy: MissingCopyView): SyncRequestItem {
  return {
    serverId: copy.serverId,
    itemId: copy.itemId,
    libraryId: copy.libraryId,
    title: book.title,
    author: book.authors[0] ?? null,
    series: book.series[0]?.name ?? null,
  };
}

const CHOICE_REASON: Record<CopyChoiceReason, string> = {
  only: 'only copy',
  longest: 'longest',
  largest: 'largest',
  'most-files': 'most files',
  tie: 'first of equals',
};

/** Everything that distinguishes one copy from another, for the picker. */
function copyLabel(copy: MissingCopyView): string {
  const parts = [copy.serverName, formatDuration(copy.durationSec), formatBytes(copy.sizeBytes)];
  if (copy.narrators.length > 0) parts.push(`read by ${copy.narrators.join(', ')}`);
  if (!copy.canDownload) parts.push('no download');
  return parts.join(' · ');
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
  choice,
  onChoose,
  onSelect,
}: {
  book: MissingBookView;
  selected: boolean;
  choice: number | undefined;
  onChoose: (id: string, index: number) => void;
  onSelect: (id: string, on: boolean) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);

  const offered = book.copies.some((copy) => copy.canDownload);
  const chosen = syncableCopy(book, choice);
  const shown = resolveCopy(book, choice);
  const needsChoice = offered && !chosen && Boolean(book.editionsDiffer);
  const alreadyHandled = book.job?.status === 'completed' || book.job?.status === 'running';

  function sync() {
    if (!chosen) return;
    setMessage(null);
    startTransition(async () => {
      const result = await syncBookAction(toRequest(book, chosen));
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
        disabled={!chosen}
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
          {book.editionsDiffer ? (
            <Pill tone="warn" title={book.editionsDiffer}>
              {book.copies.length} editions
            </Pill>
          ) : null}
          <JobPill job={book.job} />
        </div>

        <p className="text-sm text-[var(--color-ink-muted)]">
          {book.authors.join(', ') || 'Unknown author'}
          {seriesLabel(book) ? ` · ${seriesLabel(book)}` : ''}
        </p>

        {/*
          Describes the copy that would actually be pulled, never the cluster's
          representative. With divergent editions the representative's runtime
          and narrator belong to one reading among several, so printing them as
          the book's own facts states something untrue of the other copies.
        */}
        <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">
          {shown ? (
            <>
              {formatDuration(shown.durationSec)} · {formatBytes(shown.sizeBytes)}
              {shown.numAudioFiles ? ` · ${shown.numAudioFiles} files` : ''}
              {shown.narrators.length > 0 ? ` · read by ${shown.narrators.join(', ')}` : ''}
            </>
          ) : (
            <>{book.copies.length} editions to choose between</>
          )}
          {book.asin ? ` · ASIN ${book.asin}` : ''}
        </p>

        {needsChoice ? (
          <p className="mt-1 text-xs text-[var(--color-warn)]">
            These copies are not the same recording — {book.editionsDiffer}. Pick the one you want.
          </p>
        ) : null}

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
            value={choice === undefined ? (book.editionsDiffer ? '' : '-1') : String(choice)}
            onChange={(event) => onChoose(book.id, Number(event.target.value))}
            aria-label={
              book.editionsDiffer ? 'Choose which edition to sync' : 'Choose which server to pull from'
            }
            aria-invalid={needsChoice || undefined}
          >
            {book.editionsDiffer ? (
              // No pre-selected default: the whole point is that these copies
              // are not interchangeable, so one has to be picked on purpose.
              <option value="" disabled>
                Choose an edition…
              </option>
            ) : (
              <option value="-1">
                best ({CHOICE_REASON[book.chosenBy]}): {book.bestCopy.serverName} ·{' '}
                {formatBytes(book.bestCopy.sizeBytes)}
              </option>
            )}
            {book.copies.map((copy, index) => (
              <option key={`${copy.serverId}:${copy.itemId}`} value={index} disabled={!copy.canDownload}>
                {copyLabel(copy)}
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
          disabled={pending || !chosen || alreadyHandled}
          onClick={sync}
          title={
            !offered
              ? 'No source server offering this book allows downloads'
              : needsChoice
                ? 'Pick which edition to pull first'
                : !chosen
                  ? 'The chosen copy cannot be downloaded'
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

/**
 * The date the current sort ordered this group by, or null when sorting by
 * name. Shown next to the book count so the order can be checked rather than
 * trusted — and so a group that sorted last for want of any date says so.
 */
function GroupSortKey({ group, sort }: { group: CompareGroupView; sort: GroupSort }) {
  if (sort === 'released') {
    return (
      <span className="whitespace-nowrap text-xs text-[var(--color-ink-faint)]">
        · {group.newestRelease ? `newest released ${group.newestRelease.label}` : 'no release date'}
      </span>
    );
  }
  if (sort === 'added') {
    return (
      <span className="whitespace-nowrap text-xs text-[var(--color-ink-faint)]">
        ·{' '}
        {group.newestAddedAt !== null ? (
          <>
            added <RelativeTime date={new Date(group.newestAddedAt)} />
          </>
        ) : (
          'no added date'
        )}
      </span>
    );
  }
  return null;
}

function GroupSection({
  group,
  sort,
  selected,
  choices,
  onChoose,
  onSelect,
  onSelectMany,
}: {
  group: CompareGroupView;
  sort: GroupSort;
  selected: Set<string>;
  choices: CopyChoices;
  onChoose: (id: string, index: number) => void;
  onSelect: (id: string, on: boolean) => void;
  onSelectMany: (ids: string[], on: boolean) => void;
}) {
  const [open, setOpen] = useState(true);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const syncableIds = group.items
    .filter((book) => syncableCopy(book, choices.get(book.id)))
    .map((book) => book.id);
  const allSelected = syncableIds.length > 0 && syncableIds.every((id) => selected.has(id));

  // Books held back because their copies are different recordings and nobody
  // has said which one they want. Counting them keeps a bulk sync honest about
  // what it is skipping instead of quietly transferring an arbitrary edition.
  const awaitingChoice = group.items.filter(
    (book) =>
      book.editionsDiffer &&
      !syncableCopy(book, choices.get(book.id)) &&
      book.copies.some((copy) => copy.canDownload),
  ).length;

  const isSeriesGroup = group.key.startsWith('series:');
  const seriesName = group.items[0]?.series[0]?.name ?? group.label;

  function syncGroup() {
    setMessage(null);
    const items = group.items
      .map((book) => {
        const copy = syncableCopy(book, choices.get(book.id));
        return copy ? toRequest(book, copy) : null;
      })
      .filter((item): item is SyncRequestItem => item !== null);
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
          <GroupSortKey group={group} sort={sort} />
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
            title={
              awaitingChoice > 0
                ? `${awaitingChoice} book${awaitingChoice === 1 ? '' : 's'} skipped until an edition is chosen`
                : undefined
            }
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
              choice={choices.get(book.id)}
              onChoose={onChoose}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function MissingList({ groups, sort }: { groups: CompareGroupView[]; sort: GroupSort }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Choices live here rather than in each row so that "sync selected" and
  // "sync all" transfer what the user actually picked. Held in the row, the
  // choice was visible but unreachable, and every bulk path silently fell back
  // to the best copy.
  const [choices, setChoices] = useState<CopyChoices>(new Map());
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const byId = useMemo(() => {
    const map = new Map<string, MissingBookView>();
    for (const group of groups) for (const book of group.items) map.set(book.id, book);
    return map;
  }, [groups]);

  const selectedBytes = useMemo(() => {
    let total = 0;
    for (const id of selected) {
      const book = byId.get(id);
      if (!book) continue;
      // The chosen copy's size, not the representative's — they differ whenever
      // the user picked something other than the default.
      total += resolveCopy(book, choices.get(id))?.sizeBytes ?? book.sizeBytes ?? 0;
    }
    return total;
  }, [selected, byId, choices]);

  function onChoose(id: string, index: number) {
    setChoices((current) => new Map(current).set(id, index));
  }

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
      .map((book) => {
        const copy = syncableCopy(book, choices.get(book.id));
        return copy ? toRequest(book, copy) : null;
      })
      .filter((item): item is SyncRequestItem => item !== null);

    if (items.length === 0) {
      setMessage('Nothing to sync — pick an edition for the selected books first.');
      return;
    }

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
            sort={sort}
            selected={selected}
            choices={choices}
            onChoose={onChoose}
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
