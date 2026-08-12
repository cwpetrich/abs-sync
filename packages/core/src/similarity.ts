/**
 * Dependency-free string similarity helpers. The token-set/token-sort pair
 * mirrors rapidfuzz's behaviour, which handles the two failure modes that
 * matter for audiobook titles: reordered words and one side carrying extra
 * words the other lacks ("Dune" vs "Dune: Book One of the Dune Chronicles").
 */

/** Guard against pathological O(n*m) work on junk input. */
const MAX_LEN = 512;

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length > MAX_LEN) a = a.slice(0, MAX_LEN);
  if (b.length > MAX_LEN) b = b.slice(0, MAX_LEN);
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Two-row DP; iterate over the shorter string for the inner dimension.
  if (a.length < b.length) [a, b] = [b, a];

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j]! + 1;
      const ins = curr[j - 1]! + 1;
      const sub = prev[j - 1]! + cost;
      curr[j] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/** Normalized Levenshtein similarity in 0..1. */
export function ratio(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  return 1 - levenshtein(a, b) / max;
}

function tokens(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}

/** Similarity after sorting tokens — immune to word order. */
export function tokenSortRatio(a: string, b: string): number {
  return ratio(tokens(a).sort().join(' '), tokens(b).sort().join(' '));
}

/**
 * Similarity that tolerates one side having extra tokens. Compares the shared
 * token core against each full side, so a strict subset scores 1.0.
 */
export function tokenSetRatio(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;

  const shared: string[] = [];
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  for (const t of ta) (tb.has(t) ? shared : onlyA).push(t);
  for (const t of tb) if (!ta.has(t)) onlyB.push(t);

  shared.sort();
  onlyA.sort();
  onlyB.sort();

  const t0 = shared.join(' ');
  const t1 = [...shared, ...onlyA].join(' ');
  const t2 = [...shared, ...onlyB].join(' ');

  return Math.max(ratio(t0, t1), ratio(t0, t2), ratio(t1, t2));
}

/** Dice coefficient over token sets — a stable floor when edit distance is noisy. */
export function tokenDice(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return (2 * shared) / (ta.size + tb.size);
}

/** Best-of blend used for title comparison. */
export function titleSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return Math.max(ratio(a, b), tokenSortRatio(a, b), tokenSetRatio(a, b), tokenDice(a, b));
}
