import type { ReactNode } from 'react';

// Time rendering lives in its own client module: the current time and the
// viewer's timezone cannot be known at render time on the server.
export { LocalTime, RelativeTime, formatRelative } from './relative-time';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-3xl text-sm text-[var(--color-ink-muted)]">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'ok' | 'warn' | 'danger';
}) {
  const toneColor =
    tone === 'ok'
      ? 'var(--color-ok)'
      : tone === 'warn'
        ? 'var(--color-warn)'
        : tone === 'danger'
          ? 'var(--color-danger)'
          : 'var(--color-ink)';

  return (
    <div className="card p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-[var(--color-ink-faint)]">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums" style={{ color: toneColor }}>
        {value}
      </div>
      {hint ? <div className="mt-1 text-xs text-[var(--color-ink-muted)]">{hint}</div> : null}
    </div>
  );
}

const PILL_TONES = {
  neutral: { color: 'var(--color-ink-muted)', border: 'var(--color-line-strong)' },
  ok: { color: 'var(--color-ok)', border: 'color-mix(in oklab, var(--color-ok) 45%, transparent)' },
  warn: {
    color: 'var(--color-warn)',
    border: 'color-mix(in oklab, var(--color-warn) 45%, transparent)',
  },
  danger: {
    color: 'var(--color-danger)',
    border: 'color-mix(in oklab, var(--color-danger) 45%, transparent)',
  },
  info: {
    color: 'var(--color-info)',
    border: 'color-mix(in oklab, var(--color-info) 45%, transparent)',
  },
  accent: {
    color: 'var(--color-accent)',
    border: 'color-mix(in oklab, var(--color-accent) 45%, transparent)',
  },
} as const;

export type PillTone = keyof typeof PILL_TONES;

export function Pill({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: PillTone;
  title?: string;
}) {
  const style = PILL_TONES[tone];
  return (
    <span className="pill" style={{ color: style.color, borderColor: style.border }} title={title}>
      {children}
    </span>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="card flex flex-col items-center gap-3 px-6 py-12 text-center">
      <p className="font-medium">{title}</p>
      {description ? (
        <p className="max-w-md text-sm text-[var(--color-ink-muted)]">{description}</p>
      ) : null}
      {action}
    </div>
  );
}

export function Callout({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warn' | 'danger' | 'ok';
  title?: string;
  children: ReactNode;
}) {
  const color =
    tone === 'warn'
      ? 'var(--color-warn)'
      : tone === 'danger'
        ? 'var(--color-danger)'
        : tone === 'ok'
          ? 'var(--color-ok)'
          : 'var(--color-info)';

  return (
    <div
      className="rounded-lg border px-4 py-3 text-sm"
      style={{
        borderColor: `color-mix(in oklab, ${color} 40%, transparent)`,
        backgroundColor: `color-mix(in oklab, ${color} 8%, transparent)`,
      }}
      role={tone === 'danger' ? 'alert' : undefined}
    >
      {title ? (
        <p className="mb-1 font-medium" style={{ color }}>
          {title}
        </p>
      ) : null}
      <div className="text-[var(--color-ink-muted)]">{children}</div>
    </div>
  );
}

/** Thin progress bar. `value` and `max` are in the same unit. */
export function Progress({ value, max, label }: { value: number; max: number; label?: string }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-3)]"
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? 'Progress'}
    >
      <div
        className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-500"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
