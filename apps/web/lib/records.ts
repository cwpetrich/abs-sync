import type { BookRecord, SeriesRef } from '@abs-sync/core';
import { normalizePerson, normalizeSeries, normalizeTitle } from '@abs-sync/core';
import type { IndexedItem } from '../generated/prisma/client';

function parseJsonArray<T>(raw: string | null | undefined, fallback: T[] = []): T[] {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
}

/** Converts a stored row back into the canonical record the engine works on. */
export function rowToRecord(row: IndexedItem): BookRecord {
  return {
    key: `${row.serverId}:${row.absItemId}`,
    serverId: row.serverId,
    libraryId: row.libraryId,
    itemId: row.absItemId,
    title: row.title,
    subtitle: row.subtitle,
    authors: parseJsonArray<string>(row.authorsJson),
    narrators: parseJsonArray<string>(row.narratorsJson),
    series: parseJsonArray<SeriesRef>(row.seriesJson),
    asin: row.asin,
    isbn: row.isbn,
    publishedYear: row.publishedYear,
    publishedDate: row.publishedDate,
    publisher: row.publisher,
    language: row.language,
    durationSec: row.durationSec,
    sizeBytes: row.sizeBytes,
    numAudioFiles: row.numAudioFiles,
    hasAudio: row.hasAudio,
    hasEbook: row.hasEbook,
    explicit: row.explicit,
    updatedAt: row.absUpdatedAt ? row.absUpdatedAt.getTime() : null,
    mtimeMs: row.absMtimeMs,
    addedAt: row.absAddedAt,
  };
}

/** The denormalized normalization columns used for SQL-side filtering. */
export function normalizedColumns(record: BookRecord): {
  normTitle: string;
  normAuthor: string;
  normSeries: string | null;
} {
  const title = normalizeTitle(record.title, record.subtitle ?? null);
  const firstSeries = record.series?.[0]?.name;
  return {
    normTitle: title.norm,
    normAuthor: normalizePerson(record.authors?.[0] ?? ''),
    normSeries: firstSeries ? normalizeSeries(firstSeries) || null : null,
  };
}

/** Payload for creating/updating an IndexedItem row from a record. */
export function recordToRow(record: BookRecord, libraryId: string, seenAt: Date) {
  const normalized = normalizedColumns(record);
  return {
    serverId: record.serverId,
    libraryId,
    absItemId: record.itemId,
    title: record.title,
    subtitle: record.subtitle ?? null,
    authorsJson: JSON.stringify(record.authors ?? []),
    narratorsJson: JSON.stringify(record.narrators ?? []),
    seriesJson: JSON.stringify(record.series ?? []),
    asin: record.asin ?? null,
    isbn: record.isbn ?? null,
    publishedYear: record.publishedYear ?? null,
    publishedDate: record.publishedDate ?? null,
    publisher: record.publisher ?? null,
    language: record.language ?? null,
    durationSec: record.durationSec ?? null,
    sizeBytes: record.sizeBytes ?? null,
    numAudioFiles: record.numAudioFiles ?? null,
    hasAudio: record.hasAudio,
    hasEbook: record.hasEbook,
    explicit: record.explicit ?? false,
    absUpdatedAt: record.updatedAt ? new Date(record.updatedAt) : null,
    absMtimeMs: record.mtimeMs ?? null,
    absAddedAt: record.addedAt ?? null,
    ...normalized,
    seenAt,
  };
}
