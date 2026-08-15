import { describe, expect, it } from 'vitest';
import {
  diffAgainstTarget,
  groupBySeries,
  newestAddition,
  newestRelease,
  releaseOf,
  sortGroups,
  type MissingBook,
} from './diff';
import type { BookRecord } from './types';

let counter = 0;

function book(partial: Partial<BookRecord> & { title: string }): BookRecord {
  counter++;
  const serverId = partial.serverId ?? 'srv1';
  const itemId = partial.itemId ?? `item${counter}`;
  return {
    key: `${serverId}:${itemId}`,
    serverId,
    libraryId: 'lib1',
    itemId,
    title: partial.title,
    authors: partial.authors ?? [],
    narrators: partial.narrators ?? [],
    series: partial.series ?? [],
    publishedYear: partial.publishedYear ?? null,
    publishedDate: partial.publishedDate ?? null,
    addedAt: partial.addedAt ?? null,
    hasAudio: true,
    hasEbook: false,
  };
}

/** Clusters `sources` against an empty target, so every book comes back missing. */
function missingFrom(sources: BookRecord[]): MissingBook[] {
  return diffAgainstTarget(sources, []).missing;
}

const utc = (iso: string) => Date.parse(iso);

describe('releaseOf', () => {
  it('prefers a full date and reports it as exact', () => {
    expect(releaseOf(book({ title: 'A', publishedDate: '2026-03-14', publishedYear: '2026' })))
      .toEqual({ at: utc('2026-03-14'), exact: true });
  });

  it('falls back to the start of publishedYear, flagged as inexact', () => {
    expect(releaseOf(book({ title: 'A', publishedYear: '2011' })))
      .toEqual({ at: utc('2011-01-01'), exact: false });
  });

  it('does not remap two-digit years into the twentieth century', () => {
    const release = releaseOf(book({ title: 'A', publishedYear: '11' }));
    expect(new Date(release!.at).getUTCFullYear()).toBe(11);
  });

  it('treats a bare year in the date field as a year, not a precise date', () => {
    expect(releaseOf(book({ title: 'A', publishedDate: '2011' })))
      .toEqual({ at: utc('2011-01-01'), exact: false });
  });

  it('falls back to the year when the date is unparseable', () => {
    expect(releaseOf(book({ title: 'A', publishedDate: 'sometime', publishedYear: '1999' })))
      .toEqual({ at: utc('1999-01-01'), exact: false });
  });

  it('is null when the source gave neither', () => {
    expect(releaseOf(book({ title: 'A' }))).toBeNull();
  });
});

describe('newestRelease / newestAddition', () => {
  it('takes the newest across every copy of every book', () => {
    const missing = missingFrom([
      book({ title: 'Old One', publishedDate: '2001-01-01', addedAt: 500 }),
      book({ title: 'New One', publishedDate: '2020-06-01', addedAt: 100 }),
    ]);
    expect(newestRelease(missing)?.at).toBe(utc('2020-06-01'));
    expect(newestAddition(missing)).toBe(500);
  });

  it('lets a copy with richer metadata supply the date', () => {
    const missing = missingFrom([
      book({ title: 'Dune', authors: ['Frank Herbert'], serverId: 'a', publishedYear: '1965' }),
      book({
        title: 'Dune',
        authors: ['Frank Herbert'],
        serverId: 'b',
        publishedDate: '1965-08-01',
        addedAt: 42,
      }),
    ]);
    expect(missing).toHaveLength(1);
    expect(newestRelease(missing)).toEqual({ at: utc('1965-08-01'), exact: true });
    expect(newestAddition(missing)).toBe(42);
  });

  it('is null when nothing carries a date', () => {
    const missing = missingFrom([book({ title: 'Undated' })]);
    expect(newestRelease(missing)).toBeNull();
    expect(newestAddition(missing)).toBeNull();
  });
});

describe('sortGroups', () => {
  const groups = () =>
    groupBySeries(
      missingFrom([
        book({
          title: 'Old Finale',
          series: [{ name: 'Zeta Cycle', sequence: '3' }],
          publishedDate: '1998-04-02',
          addedAt: 9_000,
        }),
        book({
          title: 'Fresh Sequel',
          series: [{ name: 'Alpha Saga', sequence: '2' }],
          publishedDate: '2026-01-20',
          addedAt: 1_000,
        }),
        book({
          title: 'Alpha Saga Opener',
          series: [{ name: 'Alpha Saga', sequence: '1' }],
          publishedDate: '2019-01-01',
          addedAt: 500,
        }),
        book({ title: 'No Dates Here', series: [{ name: 'Mystery Meat' }] }),
      ]),
    );

  const labels = (sort: 'name' | 'released' | 'added') =>
    sortGroups(groups(), sort).map((group) => group.label);

  it('sorts alphabetically by name', () => {
    expect(labels('name')).toEqual(['Alpha Saga', 'Mystery Meat', 'Zeta Cycle']);
  });

  it('sorts by the newest release in each group, newest first', () => {
    expect(labels('released')).toEqual(['Alpha Saga', 'Zeta Cycle', 'Mystery Meat']);
  });

  it('sorts by the most recent addition to a server, newest first', () => {
    expect(labels('added')).toEqual(['Zeta Cycle', 'Alpha Saga', 'Mystery Meat']);
  });

  it('leaves the books inside a group in series order', () => {
    const alpha = sortGroups(groups(), 'released').find((group) => group.label === 'Alpha Saga');
    expect(alpha?.items.map((item) => item.representative.title)).toEqual([
      'Alpha Saga Opener',
      'Fresh Sequel',
    ]);
  });

  it('does not mutate the array it was given', () => {
    const original = groups();
    const before = original.map((group) => group.label);
    sortGroups(original, 'released');
    expect(original.map((group) => group.label)).toEqual(before);
  });
});
