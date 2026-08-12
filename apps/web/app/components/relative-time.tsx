'use client';

import { useEffect, useState } from 'react';

/**
 * Time display that survives hydration.
 *
 * Two things here are unavoidably environment-dependent: the current time (so
 * "20 seconds ago" differs between the server render and hydration) and the
 * timezone (this app's server runs in UTC while the browser is wherever you
 * are). Neither can match by construction, so instead of pretending otherwise:
 *
 *  - the markup is emitted with `suppressHydrationWarning`, since a mismatch
 *    here is expected rather than a bug to be fixed;
 *  - an effect recomputes the text and the tooltip in the *browser's* clock and
 *    timezone after mount, so what you finally read is local and correct;
 *  - a timer keeps it fresh, so an open tab does not sit on "just now" forever.
 *
 * `dateTime` is always the ISO string, which is timezone-unambiguous and what
 * assistive tech and scrapers read.
 */
export function RelativeTime({ date }: { date: Date | string | null }) {
  const iso = date === null ? null : typeof date === 'string' ? date : date.toISOString();
  const [display, setDisplay] = useState<{ text: string; title: string } | null>(null);

  useEffect(() => {
    if (!iso) return;
    const value = new Date(iso);
    const update = () => {
      setDisplay({ text: formatRelative(value), title: value.toLocaleString() });
    };
    update();
    // Cheap: one timer per rendered timestamp, only while mounted.
    const timer = setInterval(update, 30_000);
    return () => clearInterval(timer);
  }, [iso]);

  if (!iso) return <span className="text-[var(--color-ink-faint)]">never</span>;

  const value = new Date(iso);
  return (
    <time
      dateTime={iso}
      title={display?.title ?? iso}
      suppressHydrationWarning
    >
      {display?.text ?? formatRelative(value)}
    </time>
  );
}

/** Absolute date/time in the viewer's locale, hydration-safe. */
export function LocalTime({ date }: { date: Date | string | null }) {
  const iso = date === null ? null : typeof date === 'string' ? date : date.toISOString();
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (!iso) return;
    setText(new Date(iso).toLocaleString());
  }, [iso]);

  if (!iso) return <span className="text-[var(--color-ink-faint)]">—</span>;

  return (
    <time dateTime={iso} suppressHydrationWarning>
      {/* Before mount, show the unambiguous ISO form rather than a server-local
          string that would silently be in the wrong timezone. */}
      {text ?? iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}
    </time>
  );
}

export function formatRelative(date: Date): string {
  const deltaMs = Date.now() - date.getTime();
  const future = deltaMs < 0;
  const seconds = Math.abs(deltaMs) / 1000;

  const units: Array<[number, string]> = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
    [4.35, 'week'],
    [12, 'month'],
  ];

  let value = seconds;
  let unit = 'second';
  for (const [factor, nextUnit] of units) {
    if (value < factor) break;
    value /= factor;
    unit = nextUnit;
  }
  if (unit === 'second' && value < 10) return future ? 'in a moment' : 'just now';

  const rounded = Math.round(value);
  const plural = rounded === 1 ? '' : 's';
  return future ? `in ${rounded} ${unit}${plural}` : `${rounded} ${unit}${plural} ago`;
}
