import { formatBytes, type GroupSort } from '@abs-sync/core';
import Link from 'next/link';
import { Suspense } from 'react';
import { compare, compareSources } from '../../lib/compare';
import { Callout, EmptyState, PageHeader, RelativeTime, Stat } from '../components/ui';
import { FilterBar } from './filter-bar';
import { MissingList } from './missing-list';
import { FiltersSkeleton, ResultsSkeleton, StatsSkeleton } from './skeletons';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

function firstString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function allStrings(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

const SORTS: GroupSort[] = ['name', 'released', 'added'];

/** Anything unrecognised falls back to the default rather than to no groups. */
function sortParam(value: string | string[] | undefined): GroupSort {
  const first = firstString(value);
  return SORTS.find((sort) => sort === first) ?? 'name';
}

/**
 * The page shell renders synchronously so a click on "Compare" commits at once.
 * Everything that needs data sits behind its own Suspense boundary and streams
 * in as it resolves: the filter controls are a couple of cheap queries, while
 * the diff below them takes seconds on a large library.
 */
export default function ComparePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  return (
    <>
      <PageHeader
        title="Compare"
        description={
          <>
            What other servers have that yours does not. Matching uses ASIN and ISBN first, then
            title, author and duration — the same book from several servers is collapsed into one
            row.
          </>
        }
      />

      <Suspense fallback={<FiltersSkeleton />}>
        <CompareFilters searchParams={searchParams} />
      </Suspense>

      <Suspense
        fallback={
          <>
            <StatsSkeleton />
            <ResultsSkeleton />
          </>
        }
      >
        <CompareResults searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function CompareFilters({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const { sources } = await compareSources(allStrings(params.source));
  if (sources.length === 0) return null;
  return <FilterBar sources={sources} />;
}

async function CompareResults({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const sourceIds = allStrings(params.source);
  const sort = sortParam(params.sort);

  const result = await compare({
    ...(sourceIds.length > 0 ? { sourceServerIds: sourceIds } : {}),
    ...(firstString(params.q) ? { search: firstString(params.q) } : {}),
    includeUncertain: firstString(params.uncertain) === '1',
    groupBy: (firstString(params.group) as 'series' | 'author' | 'none') ?? 'series',
    sort,
  });

  if (result.problem) {
    return (
      <EmptyState
        title="Not ready to compare yet"
        description={result.problem}
        action={
          <Link href="/servers" className="btn btn-primary">
            Go to servers
          </Link>
        }
      />
    );
  }

  const totalItems = result.groups.reduce((sum, group) => sum + group.items.length, 0);

  return (
    <>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Missing"
          value={result.stats.missing.toLocaleString()}
          hint={`${formatBytes(result.stats.missingBytes)} to pull`}
          tone="ok"
        />
        <Stat
          label="Possible duplicates"
          value={result.stats.uncertain.toLocaleString()}
          hint="close matches worth a look"
          tone="warn"
        />
        <Stat
          label="Already yours"
          value={result.stats.present.toLocaleString()}
          hint={`of ${result.stats.sourceTotal.toLocaleString()} books on other servers`}
        />
        <Stat
          label="Your library"
          value={(result.target?.itemCount ?? 0).toLocaleString()}
          hint={result.target?.name}
        />
      </div>

      {result.stats.skippedNoAudio > 0 ? (
        <div className="mb-4">
          <Callout tone="info">
            Skipped {result.stats.skippedNoAudio.toLocaleString()} ebook-only item(s) — abs-sync only
            transfers items that have audio files.
          </Callout>
        </div>
      ) : null}

      {totalItems === 0 ? (
        <EmptyState
          title={
            result.stats.missing === 0 && result.stats.uncertain === 0
              ? 'Nothing missing'
              : 'Nothing matches these filters'
          }
          description={
            result.stats.missing === 0 && result.stats.uncertain === 0
              ? `${result.target?.name} already has every book on the servers you are comparing against.`
              : 'Try clearing the search box, or turn on “Show possible duplicates”.'
          }
        />
      ) : (
        <MissingList groups={result.groups} sort={sort} />
      )}

      {result.diff ? (
        <p className="mt-4 text-xs text-[var(--color-ink-faint)]">
          Comparison computed <RelativeTime date={result.diff.computedAt} /> in{' '}
          {(result.diff.computeMs / 1000).toFixed(1)}s
          {result.diff.fromCache ? ' and reused since' : ''}. Re-index a server to refresh it.
        </p>
      ) : null}
    </>
  );
}
