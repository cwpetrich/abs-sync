import type { BookRecord, SeriesRef } from '@abs-sync/core';
import type { AbsBookMetadata, AbsLibraryItem } from './types';

/**
 * Splits ABS's comma-joined name strings.
 *
 * This field is genuinely ambiguous: ABS joins multiple people with ", ", but a
 * single author catalogued as "Sanderson, Brandon" looks identical. The
 * heuristic: only treat commas as separators when every resulting chunk looks
 * like a whole name (contains a space). "Sanderson, Brandon" yields two
 * single-word chunks, so it is kept intact for `normalizePerson` to reorder,
 * while "Michael Kramer, Kate Reading" splits into two.
 */
function splitNames(joined: string | null | undefined): string[] {
  if (!joined) return [];
  const trimmed = joined.trim();
  if (!trimmed) return [];

  const chunks = trimmed
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (chunks.length <= 1) return chunks;

  const everyChunkIsFullName = chunks.every((chunk) => chunk.includes(' '));
  return everyChunkIsFullName ? chunks : [trimmed];
}

/**
 * Parses the minified `seriesName` field, which packs name and sequence as
 * `"Mistborn #1"` and joins multiple series with `", "`.
 */
export function parseSeriesName(joined: string | null | undefined): SeriesRef[] {
  if (!joined) return [];
  return joined
    .split(',')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const hashIndex = chunk.lastIndexOf('#');
      if (hashIndex > 0) {
        const name = chunk.slice(0, hashIndex).trim();
        const sequence = chunk.slice(hashIndex + 1).trim();
        if (name) return { name, sequence: sequence || null };
      }
      return { name: chunk, sequence: null };
    });
}

function extractAuthors(metadata: AbsBookMetadata): string[] {
  if (Array.isArray(metadata.authors) && metadata.authors.length > 0) {
    const names = metadata.authors.map((a) => a?.name).filter((n): n is string => Boolean(n));
    if (names.length > 0) return names;
  }
  return splitNames(metadata.authorName);
}

function extractNarrators(metadata: AbsBookMetadata): string[] {
  if (Array.isArray(metadata.narrators) && metadata.narrators.length > 0) {
    return metadata.narrators.filter((n): n is string => Boolean(n));
  }
  return splitNames(metadata.narratorName);
}

function extractSeries(metadata: AbsBookMetadata): SeriesRef[] {
  if (Array.isArray(metadata.series) && metadata.series.length > 0) {
    const refs = metadata.series
      .filter((s) => Boolean(s?.name))
      .map((s) => ({ name: s.name!, sequence: s.sequence ?? null }));
    if (refs.length > 0) return refs;
  }
  return parseSeriesName(metadata.seriesName);
}

function countAudioFiles(item: AbsLibraryItem): number {
  const media = item.media;
  if (!media) return 0;
  if (typeof media.numTracks === 'number' && media.numTracks > 0) return media.numTracks;
  if (typeof media.numAudioFiles === 'number' && media.numAudioFiles > 0) return media.numAudioFiles;
  if (Array.isArray(media.tracks) && media.tracks.length > 0) return media.tracks.length;
  if (Array.isArray(media.audioFiles) && media.audioFiles.length > 0) return media.audioFiles.length;
  return 0;
}

/**
 * Converts an ABS library item into our canonical record.
 * Returns null for podcasts, missing/invalid items, and anything without a title —
 * none of which can participate meaningfully in a book diff.
 */
export function absItemToBookRecord(
  serverId: string,
  item: AbsLibraryItem,
  fallbackLibraryId?: string,
): BookRecord | null {
  const itemId = item.id;
  if (!itemId) return null;
  if (item.mediaType && item.mediaType !== 'book') return null;
  if (item.isMissing || item.isInvalid) return null;

  const metadata = item.media?.metadata ?? {};
  const title = (metadata.title ?? '').trim();
  if (!title) return null;

  const libraryId = item.libraryId ?? fallbackLibraryId ?? '';
  const numAudioFiles = countAudioFiles(item);
  const duration = typeof item.media?.duration === 'number' ? item.media.duration : null;
  const hasEbook = Boolean(item.media?.ebookFile || item.media?.ebookFormat);

  return {
    key: `${serverId}:${itemId}`,
    serverId,
    libraryId,
    itemId,
    title,
    subtitle: metadata.subtitle ?? null,
    authors: extractAuthors(metadata),
    narrators: extractNarrators(metadata),
    series: extractSeries(metadata),
    asin: metadata.asin ?? null,
    isbn: metadata.isbn ?? null,
    publishedYear: metadata.publishedYear ?? null,
    publisher: metadata.publisher ?? null,
    language: metadata.language ?? null,
    durationSec: duration && duration > 0 ? duration : null,
    // `item.size` is the folder total from the filesystem scan; `media.size` is
    // summed from `media.audioFiles`, which can hold stale duplicate entries
    // after a remount and then reports double the real bytes. Prefer the
    // filesystem figure and fall back only when the server omits it.
    sizeBytes: typeof item.size === 'number' && item.size > 0 ? item.size : (item.media?.size ?? null),
    numAudioFiles: numAudioFiles || null,
    hasAudio: numAudioFiles > 0 || (duration ?? 0) > 0,
    hasEbook,
    explicit: metadata.explicit ?? false,
    updatedAt: item.updatedAt ?? null,
    mtimeMs: item.mtimeMs ?? null,
    addedAt: item.addedAt ?? null,
  };
}
