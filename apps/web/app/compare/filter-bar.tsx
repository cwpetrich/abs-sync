'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';

export interface FilterBarProps {
  sources: Array<{ id: string; name: string; canDownload: boolean }>;
}

export function FilterBar({ sources }: FilterBarProps) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const [search, setSearch] = useState(params.get('q') ?? '');
  const groupBy = params.get('group') ?? 'series';
  const sort = params.get('sort') ?? 'name';
  const includeUncertain = params.get('uncertain') === '1';
  const selectedSources = params.getAll('source');

  function push(mutate: (next: URLSearchParams) => void) {
    const next = new URLSearchParams(params.toString());
    mutate(next);
    startTransition(() => {
      router.push(`/compare?${next.toString()}`);
    });
  }

  // Debounce the search box so typing does not fire a diff per keystroke.
  useEffect(() => {
    const current = params.get('q') ?? '';
    if (search === current) return;
    const timer = setTimeout(() => {
      const next = new URLSearchParams(params.toString());
      if (search) next.set('q', search);
      else next.delete('q');
      startTransition(() => {
        router.push(`/compare?${next.toString()}`);
      });
    }, 350);
    return () => clearTimeout(timer);
  }, [search, params, router]);

  function toggleSource(id: string, on: boolean) {
    push((next) => {
      const remaining = next.getAll('source').filter((value) => value !== id);
      next.delete('source');
      for (const value of remaining) next.append('source', value);
      if (on) next.append('source', id);
    });
  }

  const allSourcesActive = selectedSources.length === 0;

  return (
    <div className="card mb-4 flex flex-wrap items-end gap-4 p-4">
      <div className="min-w-56 flex-1">
        <label className="label" htmlFor="compare-search">
          Search
        </label>
        <input
          id="compare-search"
          className="field"
          placeholder="Title, author, narrator or series"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <div>
        <label className="label" htmlFor="compare-group">
          Group by
        </label>
        <select
          id="compare-group"
          className="field"
          value={groupBy}
          onChange={(event) => push((next) => next.set('group', event.target.value))}
        >
          <option value="series">Series</option>
          <option value="author">Author</option>
          <option value="none">Nothing</option>
        </select>
      </div>

      {/* Only groups get sorted, so with grouping off there is nothing to order. */}
      {groupBy === 'none' ? null : (
        <div>
          <label className="label" htmlFor="compare-sort">
            Sort {groupBy === 'author' ? 'authors' : 'series'} by
          </label>
          <select
            id="compare-sort"
            className="field"
            value={sort}
            onChange={(event) => push((next) => next.set('sort', event.target.value))}
          >
            <option value="name">Name</option>
            <option value="released">Newest release</option>
            <option value="added">Recently added to a server</option>
          </select>
        </div>
      )}

      <label className="flex items-center gap-2 pb-2 text-sm">
        <input
          type="checkbox"
          checked={includeUncertain}
          onChange={(event) =>
            push((next) => {
              if (event.target.checked) next.set('uncertain', '1');
              else next.delete('uncertain');
            })
          }
        />
        <span title="Books where your server has something similar but not clearly the same">
          Show possible duplicates
        </span>
      </label>

      <fieldset className="min-w-48">
        <legend className="label">Compare against</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {sources.map((source) => (
            <label key={source.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={allSourcesActive || selectedSources.includes(source.id)}
                onChange={(event) => toggleSource(source.id, event.target.checked)}
              />
              <span className={source.canDownload ? '' : 'text-[var(--color-warn)]'}>
                {source.name}
                {source.canDownload ? '' : ' (no download)'}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {pending ? <span className="pb-2 text-xs text-[var(--color-ink-muted)]">updating…</span> : null}
    </div>
  );
}
