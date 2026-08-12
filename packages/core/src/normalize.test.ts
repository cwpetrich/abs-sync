import { describe, expect, it } from 'vitest';
import {
  normalizeAsin,
  normalizeIsbn,
  normalizePerson,
  normalizeSeries,
  normalizeTitle,
  parseSequence,
  romanToInt,
} from './normalize';

describe('normalizeTitle', () => {
  it('strips leading articles, punctuation and diacritics', () => {
    expect(normalizeTitle('The Wind-Up Bird Chronicle').norm).toBe('wind up bird chronicle');
    expect(normalizeTitle('Les Misérables').norm).toBe('les miserables');
    expect(normalizeTitle("Harry Potter and the Sorcerer's Stone").norm).toBe(
      'harry potter and the sorcerers stone',
    );
  });

  it('removes edition and format noise', () => {
    expect(normalizeTitle('Dune (Unabridged)').norm).toBe('dune');
    expect(normalizeTitle('Dune [Dramatized Adaptation]').norm).toBe('dune');
    expect(normalizeTitle('Educated: A Memoir').norm).toBe('educated');
  });

  it('normalizes & to and', () => {
    expect(normalizeTitle('War & Peace').norm).toBe('war and peace');
  });

  it('exposes a subtitle-free base form', () => {
    const result = normalizeTitle('Dune: Book One of the Dune Chronicles');
    expect(result.base).toBe('dune');
    expect(result.norm).toContain('dune');
  });

  it('folds an explicit subtitle argument into the full form only', () => {
    const result = normalizeTitle('Mistborn', 'The Final Empire');
    expect(result.base).toBe('mistborn');
    expect(result.norm).toBe('mistborn the final empire');
  });

  it('preserves volume numbers so distinct parts never collapse', () => {
    const part1 = normalizeTitle('Sword of Destiny, Part 1');
    const part2 = normalizeTitle('Sword of Destiny, Part 2');
    expect(part1.norm).not.toBe(part2.norm);
    expect(part1.numbers).toEqual([1]);
    expect(part2.numbers).toEqual([2]);
  });

  it('canonicalizes roman, digit and word numbering to the same token', () => {
    expect(normalizeTitle('Dune Book II').numbers).toEqual([2]);
    expect(normalizeTitle('Dune Book 2').numbers).toEqual([2]);
    expect(normalizeTitle('Dune Book Two').numbers).toEqual([2]);
    expect(normalizeTitle('Dune Book II').norm).toBe(normalizeTitle('Dune Book Two').norm);
  });

  it('exposes a possessive-free variant so cataloguing variants align', () => {
    // Real case from a live library: the same work catalogued two ways.
    const short = normalizeTitle('Alice in Wonderland');
    const long = normalizeTitle("Alice's Adventures in Wonderland");
    expect(long.norm).toBe('alices adventures in wonderland');
    expect(long.noPossessive).toBe('alice adventures in wonderland');
    // The short form is a strict token subset of the possessive-free long form.
    expect(short.noPossessive).toBe('alice in wonderland');
  });

  it('handles empty input', () => {
    expect(normalizeTitle(null)).toEqual({ norm: '', base: '', noPossessive: '', numbers: [] });
    expect(normalizeTitle('')).toEqual({ norm: '', base: '', noPossessive: '', numbers: [] });
  });
});

describe('normalizePerson', () => {
  it('flips "Last, First" order', () => {
    expect(normalizePerson('Sanderson, Brandon')).toBe('brandon sanderson');
  });

  it('keeps initial-only forenames', () => {
    expect(normalizePerson('J.R.R. Tolkien')).toBe('j r r tolkien');
  });

  it('drops middle initials when a full name remains', () => {
    expect(normalizePerson('George R. Martin')).toBe('george martin');
  });

  it('strips suffixes and diacritics', () => {
    expect(normalizePerson('Martin Luther King, Jr.')).toBe('martin luther king');
    expect(normalizePerson('Gabriel García Márquez')).toBe('gabriel garcia marquez');
  });

  it('returns empty string for missing names', () => {
    expect(normalizePerson(undefined)).toBe('');
  });
});

describe('normalizeSeries', () => {
  it('drops trailing series words and leading articles', () => {
    expect(normalizeSeries('The Stormlight Archive')).toBe('stormlight archive');
    expect(normalizeSeries('Stormlight Archive Series')).toBe('stormlight archive');
  });
});

describe('identifiers', () => {
  it('validates ASINs', () => {
    expect(normalizeAsin('b0036kwx0y')).toBe('B0036KWX0Y');
    expect(normalizeAsin('nope')).toBeNull();
  });

  it('converts ISBN-10 to ISBN-13', () => {
    // 0441013591 is Dune (Ace); the 978-prefixed form is 9780441013593.
    expect(normalizeIsbn('0-441-01359-1')).toBe('9780441013593');
    expect(normalizeIsbn('9780441013593')).toBe('9780441013593');
    expect(normalizeIsbn('garbage')).toBeNull();
  });

  it('parses sequences', () => {
    expect(parseSequence('1.5')).toBe(1.5);
    expect(parseSequence('IV')).toBe(4);
    expect(parseSequence('')).toBeNull();
    expect(parseSequence(null)).toBeNull();
  });

  it('parses roman numerals', () => {
    expect(romanToInt('xiv')).toBe(14);
    expect(romanToInt('ix')).toBe(9);
    expect(romanToInt('abc')).toBeNull();
  });
});
