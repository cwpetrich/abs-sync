/**
 * Title/author/series normalization.
 *
 * The guiding rule: strip noise that varies between servers (edition tags,
 * punctuation, diacritics, articles) but NEVER strip information that
 * distinguishes two different works. In particular, volume/part numbers are
 * preserved as `#n` tokens rather than deleted — collapsing "Sword of Destiny,
 * Part 1" and "Part 2" into one key would silently merge distinct books and
 * cause the diff engine to report a book as already-present when it isn't.
 */

const COMBINING_MARKS = /[\u0300-\u036f]/g;

export function stripDiacritics(input: string): string {
  return input.normalize('NFKD').replace(COMBINING_MARKS, '');
}

/**
 * Edition/format noise that appears inconsistently across servers. Order
 * matters: multi-word phrases are removed before their single-word substrings.
 */
const NOISE_PHRASES = [
  'dramatized adaptation',
  'dramatised adaptation',
  'dramatic adaptation',
  'full cast dramatization',
  'full cast production',
  'graphic audio',
  'audible original',
  'audible studios',
  'audible exclusive',
  'anniversary edition',
  'special edition',
  'deluxe edition',
  'collectors edition',
  'complete and unabridged',
  'revised edition',
  'expanded edition',
  'annotated edition',
  'illustrated edition',
  'audio edition',
  'audio drama',
  'audiobook',
  'audio book',
  'unabridged',
  'abridged',
  'dramatization',
  'dramatisation',
  'a novel',
  'a novella',
  'a memoir',
  'a short story',
  'remastered',
];

const ROMAN_VALUES: Record<string, number> = {
  i: 1,
  v: 5,
  x: 10,
  l: 50,
  c: 100,
  d: 500,
  m: 1000,
};

/** Parses a lowercase roman numeral; returns null if not a valid numeral. */
export function romanToInt(raw: string): number | null {
  if (!raw || !/^[ivxlcdm]+$/.test(raw)) return null;
  let total = 0;
  let prev = 0;
  for (let i = raw.length - 1; i >= 0; i--) {
    const value = ROMAN_VALUES[raw[i]!]!;
    if (value < prev) total -= value;
    else {
      total += value;
      prev = value;
    }
  }
  // Reject nonsense like "iiii" that still sums, by round-tripping length sanity.
  return total > 0 && total < 4000 ? total : null;
}

/** Matches "book 3", "vol. IV", "part two"-style numbering phrases. */
const NUMBERING_RE =
  /\b(?:book|bk|volume|vol|part|pt|episode|ep|no|number)\s*\.?\s*(\d+(?:\.\d+)?|[ivxlcdm]+)\b/g;

const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
};

const WORD_NUMBERING_RE =
  /\b(?:book|bk|volume|vol|part|pt|episode|ep)\s*\.?\s*(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen)\b/g;

export interface NormalizedTitle {
  /** Full normalized title including subtitle and `#n` volume tokens. */
  norm: string;
  /** Normalized title with the subtitle (after `:` or ` - `) removed. */
  base: string;
  /**
   * `norm` with possessives dropped entirely ("alice's" -> "alice" rather than
   * "alices"). Catalogues disagree about whether to include the possessive at
   * all — "Alice in Wonderland" vs "Alice's Adventures in Wonderland" — and
   * comparing this variant makes those align without loosening the match gate.
   */
  noPossessive: string;
  /** Volume/part numbers found anywhere in the title. */
  numbers: number[];
}

function collapse(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function removeNoise(input: string): string {
  let out = input;
  for (const phrase of NOISE_PHRASES) {
    out = out.split(phrase).join(' ');
  }
  return out;
}

const LEADING_ARTICLE_RE = /^(?:the|a|an)\s+/;

function normalizeTitleString(raw: string): { text: string; numbers: number[] } {
  const numbers: number[] = [];

  let s = stripDiacritics(String(raw)).toLowerCase();

  // Parenthetical/bracketed qualifiers are almost always edition noise, but they
  // can carry the volume number, so harvest numbering from them before dropping.
  s = s.replace(/[([{]([^)\]}]*)[)\]}]/g, (_m, inner: string) => ` ${inner} `);

  s = s.replace(/&/g, ' and ');
  s = s.replace(/[\u2018\u2019`]/g, "'");
  s = s.replace(/[\u201c\u201d]/g, '"');

  // Spell out word-form numbering first so it survives as a `#n` token.
  s = s.replace(WORD_NUMBERING_RE, (_m, word: string) => {
    const n = WORD_NUMBERS[word];
    if (n === undefined) return ' ';
    numbers.push(n);
    return ` #${n} `;
  });

  s = s.replace(NUMBERING_RE, (_m, value: string) => {
    const n = /^\d/.test(value) ? Number.parseFloat(value) : romanToInt(value);
    if (n === null || n === undefined || Number.isNaN(n)) return ' ';
    numbers.push(n);
    return ` #${n} `;
  });

  s = removeNoise(s);

  // Drop possessive/punctuation, keeping `#` (volume marker) and digits.
  s = s.replace(/'s\b/g, 's');
  s = s.replace(/[^a-z0-9#. ]+/g, ' ');
  // A trailing period on a word is punctuation; a decimal point is data.
  s = s.replace(/\.(?!\d)/g, ' ');

  s = collapse(s);
  s = s.replace(LEADING_ARTICLE_RE, '');

  return { text: collapse(s), numbers };
}

export function normalizeTitle(raw: string | null | undefined, subtitle?: string | null): NormalizedTitle {
  if (!raw) return { norm: '', base: '', noPossessive: '', numbers: [] };

  const combined = subtitle ? `${raw}: ${subtitle}` : String(raw);
  const full = normalizeTitleString(combined);

  // Base form: everything before the first subtitle delimiter of the ORIGINAL
  // string, so we compare "dune" against "dune" when one server appends
  // "Book One of the Dune Chronicles" as a subtitle.
  const splitAt = String(raw).search(/:| - |—|–/);
  const baseSource = splitAt > 0 ? String(raw).slice(0, splitAt) : String(raw);
  const base = normalizeTitleString(baseSource);

  const numbers = [...new Set([...full.numbers, ...base.numbers])].sort((a, b) => a - b);
  const noPossessive = normalizeTitleString(stripPossessives(combined)).text;
  return { norm: full.text, base: base.text || full.text, noPossessive, numbers };
}

/** Removes possessive endings before normalization collapses them to plain "s". */
function stripPossessives(input: string): string {
  return input.replace(/[\u2019']s\b/gi, '');
}

const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'md', 'esq', 'msc', 'ba', 'ma']);

/**
 * Normalizes a person name to "first last" order, lowercase, no punctuation.
 * Handles "Last, First" (ABS stores both conventions depending on the scanner),
 * middle initials, and honorific suffixes.
 */
export function normalizePerson(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = stripDiacritics(String(raw)).toLowerCase();

  // "Sanderson, Brandon" -> "brandon sanderson". Only flip on a single comma
  // that isn't followed by a suffix, to avoid mangling "Smith, Jr.".
  const commaParts = s.split(',').map((p) => p.trim()).filter(Boolean);
  if (commaParts.length === 2) {
    const tail = commaParts[1]!.replace(/[^a-z ]/g, '').trim();
    if (!NAME_SUFFIXES.has(tail.split(' ')[0] ?? '')) {
      s = `${commaParts[1]} ${commaParts[0]}`;
    }
  }

  s = s.replace(/[^a-z0-9 ]+/g, ' ');
  const parts = collapse(s)
    .split(' ')
    .filter((p) => p && !NAME_SUFFIXES.has(p));

  // Drop single-letter middle initials: "j r r tolkien" keeps initials because
  // they're the whole forename, so only drop initials when at least two
  // multi-letter parts remain.
  const multi = parts.filter((p) => p.length > 1);
  const cleaned = multi.length >= 2 ? parts.filter((p) => p.length > 1) : parts;

  return cleaned.join(' ');
}

export function normalizePeople(raw: Iterable<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const person of raw) {
    const norm = normalizePerson(person);
    if (norm) out.add(norm);
  }
  return [...out];
}

/** Normalizes a series name for grouping and watch-matching. */
export function normalizeSeries(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = stripDiacritics(String(raw)).toLowerCase();
  s = s.replace(/&/g, ' and ');
  s = s.replace(/[^a-z0-9 ]+/g, ' ');
  s = collapse(s);
  s = s.replace(LEADING_ARTICLE_RE, '');
  // "the stormlight archive series" and "the stormlight archive" are the same.
  s = s.replace(/\s+(?:series|saga|cycle)$/, '');
  return collapse(s);
}

/** Parses ABS's free-form sequence string into a number when possible. */
export function parseSequence(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const direct = Number.parseFloat(s);
  if (!Number.isNaN(direct) && /^[\d.]/.test(s)) return direct;
  const roman = romanToInt(s.toLowerCase());
  return roman;
}

/** Uppercased ASIN if it looks like a real one, else null. */
export function normalizeAsin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim().toUpperCase();
  return /^[A-Z0-9]{10}$/.test(s) ? s : null;
}

function isbn10To13(isbn10: string): string | null {
  if (isbn10.length !== 10) return null;
  const core = `978${isbn10.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = Number(core[i]);
    if (Number.isNaN(digit)) return null;
    sum += digit * (i % 2 === 0 ? 1 : 3);
  }
  const check = (10 - (sum % 10)) % 10;
  return `${core}${check}`;
}

/** Normalizes ISBN-10/13 to a comparable ISBN-13 string, else null. */
export function normalizeIsbn(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).replace(/[^0-9xX]/g, '').toUpperCase();
  if (s.length === 13 && /^\d{13}$/.test(s)) return s;
  if (s.length === 10 && /^\d{9}[\dX]$/.test(s)) return isbn10To13(s);
  return null;
}

/** Human-friendly duration for the UI. */
export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Multipliers for `parseBytes`, matching formatBytes' 1024-based steps. */
const BYTE_UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
  t: 1024 ** 4,
  tb: 1024 ** 4,
  tib: 1024 ** 4,
};

/**
 * Reads a human-written size into bytes, or null if it is not one.
 *
 * The inverse of `formatBytes`, so what the UI prints can be typed straight
 * back in. Sizes are configuration people set by hand, and asking for
 * 26843545600 invites an off-by-one-zero that silently changes the limit by a
 * factor of ten. A bare number is still bytes, which keeps every existing
 * config value working unchanged.
 *
 * KB and KiB are accepted as synonyms: both are 1024 here, matching
 * `formatBytes` and the convention Audiobookshelf itself displays.
 */
export function parseBytes(input: string): number | null {
  const trimmed = input.trim().toLowerCase().replace(/,/g, '');
  if (!trimmed) return null;

  const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/.exec(trimmed);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;

  const unit = match[2] || 'b';
  const multiplier = BYTE_UNITS[unit];
  if (multiplier === undefined) return null;

  return Math.round(amount * multiplier);
}
