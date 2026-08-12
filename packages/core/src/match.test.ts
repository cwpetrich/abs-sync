import { describe, expect, it } from 'vitest';
import { diffAgainstTarget, groupBySeries } from './diff';
import { BookIndex, isConfident, scoreIdentities, deriveIdentity } from './match';
import type { BookRecord } from './types';

let counter = 0;

function book(partial: Partial<BookRecord> & { title: string }): BookRecord {
  counter++;
  const serverId = partial.serverId ?? 'srv1';
  const itemId = partial.itemId ?? `item${counter}`;
  return {
    key: `${serverId}:${itemId}`,
    serverId,
    libraryId: partial.libraryId ?? 'lib1',
    itemId,
    title: partial.title,
    subtitle: partial.subtitle ?? null,
    authors: partial.authors ?? [],
    narrators: partial.narrators ?? [],
    series: partial.series ?? [],
    asin: partial.asin ?? null,
    isbn: partial.isbn ?? null,
    durationSec: partial.durationSec ?? null,
    sizeBytes: partial.sizeBytes ?? null,
    numAudioFiles: partial.numAudioFiles ?? null,
    hasAudio: partial.hasAudio ?? true,
    hasEbook: partial.hasEbook ?? false,
  };
}

function score(a: BookRecord, b: BookRecord) {
  return scoreIdentities(deriveIdentity(a), deriveIdentity(b));
}

describe('scoreIdentities', () => {
  it('matches on identical ASIN', () => {
    const match = score(
      book({ title: 'Dune', asin: 'B0036KWX0Y' }),
      book({ title: 'Dune (Unabridged)', asin: 'B0036KWX0Y' }),
    );
    expect(match?.tier).toBe('asin');
    expect(match?.score).toBe(1);
  });

  it('matches on equivalent ISBN-10 and ISBN-13', () => {
    const match = score(
      book({ title: 'Dune', isbn: '0-441-01359-1' }),
      book({ title: 'Dune', isbn: '9780441013593' }),
    );
    expect(match?.tier).toBe('isbn');
  });

  it('matches the same book when one server carries the subtitle', () => {
    const match = score(
      book({ title: 'Dune', authors: ['Frank Herbert'], durationSec: 75600 }),
      book({
        title: 'Dune: Book One of the Dune Chronicles',
        authors: ['Herbert, Frank'],
        durationSec: 75900,
      }),
    );
    expect(match).not.toBeNull();
    expect(isConfident(match!)).toBe(true);
  });

  it('rejects different volumes of the same release', () => {
    const match = score(
      book({ title: 'Sword of Destiny, Part 1', authors: ['Andrzej Sapkowski'] }),
      book({ title: 'Sword of Destiny, Part 2', authors: ['Andrzej Sapkowski'] }),
    );
    expect(match).toBeNull();
  });

  it('rejects different series entries even with similar titles', () => {
    const match = score(
      book({
        title: 'The Way of Kings',
        authors: ['Brandon Sanderson'],
        series: [{ name: 'The Stormlight Archive', sequence: '1' }],
      }),
      book({
        title: 'Words of Radiance',
        authors: ['Brandon Sanderson'],
        series: [{ name: 'The Stormlight Archive', sequence: '2' }],
      }),
    );
    expect(match).toBeNull();
  });

  it('rejects same-title works by different authors', () => {
    const match = score(
      book({ title: 'Beloved', authors: ['Toni Morrison'] }),
      book({ title: 'Beloved', authors: ['Corinne Michaels'] }),
    );
    expect(match === null || !isConfident(match)).toBe(true);
  });

  it('treats a wildly different duration as a weaker match', () => {
    const abridged = book({ title: 'Dune', authors: ['Frank Herbert'], durationSec: 10800 });
    const full = book({ title: 'Dune', authors: ['Frank Herbert'], durationSec: 75600 });
    const match = score(abridged, full);
    // Still the same work, but confidence must drop below the identical-length case.
    expect(match!.score).toBeLessThan(0.95);
  });

  it('withholds the duration signal when one side is an exact multiple of the other', () => {
    // Audiobookshelf reports double the real duration when media.audioFiles has
    // accumulated stale duplicate entries after a remount — measured on 88% of a
    // real 2.35.1 library. Scoring that as a length mismatch reported books the
    // target already owned as missing.
    const real = book({ title: 'Fight and Flight', authors: ['Scott Meyer'], durationSec: 37_600 });
    const doubled = book({ title: 'Fight and Flight', authors: ['Scott Meyer'], durationSec: 75_200 });

    const match = score(real, doubled);
    expect(match).not.toBeNull();
    expect(isConfident(match!)).toBe(true);
    // Withheld, not scored: no duration claim should appear in the reasons.
    expect(match!.reasons.some((reason) => reason.startsWith('duration'))).toBe(false);
  });

  it('still penalizes a length difference that is not a whole multiple', () => {
    const match = score(
      book({ title: 'Dune', authors: ['Frank Herbert'], durationSec: 40_000 }),
      book({ title: 'Dune', authors: ['Frank Herbert'], durationSec: 61_000 }),
    );
    expect(match!.reasons.some((reason) => reason.startsWith('duration'))).toBe(true);
    expect(match!.score).toBeLessThan(0.95);
  });

  it('matches possessive and non-possessive titles of the same work', () => {
    const match = score(
      book({ title: 'Alice in Wonderland', authors: ['Lewis Carroll'], durationSec: 19_440 }),
      book({ title: "Alice's Adventures in Wonderland", authors: ['Lewis Carroll'], durationSec: 19_800 }),
    );
    expect(match).not.toBeNull();
    expect(isConfident(match!)).toBe(true);
  });

  it('still separates distinct short works by the same author', () => {
    // Guard against the possessive change loosening things too far: these are
    // different Dresden Files shorts of similar length, and must not merge.
    for (const [left, right] of [
      ['Heorot', 'Backup'],
      ['Curses', 'Jury Duty'],
      ['I Was a Teenage Bigfoot', 'Day One'],
    ] as const) {
      const match = score(
        book({ title: left, authors: ['Jim Butcher'], durationSec: 3_600 }),
        book({ title: right, authors: ['Jim Butcher'], durationSec: 3_700 }),
      );
      expect(match, `${left} must not match ${right}`).toBeNull();
    }
  });

  it('boosts confidence when series position agrees', () => {
    const withSeries = score(
      book({
        title: 'The Final Empire',
        authors: ['Brandon Sanderson'],
        series: [{ name: 'Mistborn', sequence: '1' }],
      }),
      book({
        title: 'Mistborn: The Final Empire',
        authors: ['Brandon Sanderson'],
        series: [{ name: 'Mistborn', sequence: '1' }],
      }),
    );
    expect(withSeries).not.toBeNull();
    expect(isConfident(withSeries!)).toBe(true);
  });
});

describe('BookIndex', () => {
  it('finds a match across a populated index', () => {
    const index = new BookIndex([
      book({ title: 'Project Hail Mary', authors: ['Andy Weir'] }),
      book({ title: 'The Martian', authors: ['Andy Weir'] }),
      book({ title: 'Artemis', authors: ['Andy Weir'] }),
    ]);
    const found = index.findBest(book({ title: 'The Martian', authors: ['Weir, Andy'] }));
    expect(found?.candidate.title).toBe('The Martian');
  });

  it('returns null when nothing resembles the query', () => {
    const index = new BookIndex([book({ title: 'Project Hail Mary', authors: ['Andy Weir'] })]);
    expect(index.findBest(book({ title: 'Neuromancer', authors: ['William Gibson'] }))).toBeNull();
  });

  it('handles short titles that produce no long tokens', () => {
    const index = new BookIndex([book({ title: 'It', authors: ['Stephen King'] })]);
    expect(index.findBest(book({ title: 'It', authors: ['King, Stephen'] }))).not.toBeNull();
  });
});

describe('diffAgainstTarget', () => {
  const mine = [
    book({ serverId: 'mine', title: 'The Martian', authors: ['Andy Weir'], durationSec: 36000 }),
    book({ serverId: 'mine', title: 'Dune', authors: ['Frank Herbert'], durationSec: 75600 }),
  ];

  it('reports only what the target lacks', () => {
    const theirs = [
      book({ serverId: 'friend', title: 'The Martian', authors: ['Weir, Andy'], durationSec: 36100 }),
      book({ serverId: 'friend', title: 'Project Hail Mary', authors: ['Andy Weir'], sizeBytes: 500 }),
    ];
    const result = diffAgainstTarget(theirs, mine);
    expect(result.stats.present).toBe(1);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]!.representative.title).toBe('Project Hail Mary');
    expect(result.stats.missingBytes).toBe(500);
  });

  it('clusters the same missing book offered by several servers', () => {
    const theirs = [
      book({ serverId: 'friendA', title: 'Project Hail Mary', authors: ['Andy Weir'], durationSec: 58000, sizeBytes: 100 }),
      book({ serverId: 'friendB', title: 'Project Hail Mary (Unabridged)', authors: ['Weir, Andy'], durationSec: 58200, sizeBytes: 900 }),
    ];
    const result = diffAgainstTarget(theirs, mine);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]!.copies).toHaveLength(2);
    // Best copy wins on size when durations are equivalent.
    expect(result.missing[0]!.representative.serverId).toBe('friendB');
  });

  it('flags a weak match as uncertain rather than missing', () => {
    const theirs = [
      book({ serverId: 'friend', title: 'The Martian: A Novel', authors: ['Andy Weir'], durationSec: 20000 }),
    ];
    const result = diffAgainstTarget(theirs, mine);
    const statuses = result.missing.map((m) => m.status);
    expect(statuses.every((s) => s === 'uncertain') || result.stats.present === 1).toBe(true);
  });

  it('skips ebook-only items when requireAudio is set', () => {
    const theirs = [book({ serverId: 'friend', title: 'Neuromancer', hasAudio: false, hasEbook: true })];
    const result = diffAgainstTarget(theirs, mine);
    expect(result.stats.skippedNoAudio).toBe(1);
    expect(result.missing).toHaveLength(0);
  });

  it('groups missing books by series', () => {
    const theirs = [
      book({
        serverId: 'friend',
        title: 'Words of Radiance',
        authors: ['Brandon Sanderson'],
        series: [{ name: 'The Stormlight Archive', sequence: '2' }],
      }),
      book({ serverId: 'friend', title: 'Neuromancer', authors: ['William Gibson'] }),
    ];
    const result = diffAgainstTarget(theirs, mine);
    const groups = groupBySeries(result.missing);
    expect(groups.map((g) => g.label).sort()).toEqual(['Standalone', 'The Stormlight Archive']);
  });
});
