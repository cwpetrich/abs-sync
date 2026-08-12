'use client';

import { formatBytes, parseBytes } from '@abs-sync/core';
import { useState, useTransition } from 'react';
import { updateSettingsAction } from '../actions';
import { Callout, Pill } from '../components/ui';

/**
 * Live configuration editor.
 *
 * Each field shows where its current value came from, because the resolution
 * order — database over environment over default — is otherwise invisible, and
 * "I set that in .env and it did nothing" is the confusion this design invites
 * if the source is not on screen. Clearing a field deletes the override and
 * falls back to whatever tier is underneath, which the badge then reports.
 */

export interface SettingView {
  key: string;
  label: string;
  hint: string;
  kind: 'number' | 'bytes' | 'text' | 'boolean' | 'url' | 'secret';
  group: string;
  envVar: string;
  source: 'database' | 'environment' | 'default';
  /** Effective value; secrets arrive masked and are never sent to the client. */
  display: string;
  deferred?: boolean;
}

const GROUP_LABELS: Record<string, string> = {
  transfers: 'Transfers',
  indexing: 'Indexing and watches',
  notifications: 'Notifications',
  security: 'Security',
};

const SOURCE_TONE = {
  database: 'accent',
  environment: 'info',
  default: 'neutral',
} as const;

const SOURCE_HINT = {
  database: 'Set here. Clear the field to fall back to the environment or the default.',
  environment: `Coming from the environment. Saving a value here overrides it.`,
  default: 'Built-in default.',
} as const;

function Field({
  setting,
  value,
  onChange,
}: {
  setting: SettingView;
  value: string;
  onChange: (next: string) => void;
}) {
  const isSecret = setting.kind === 'secret';
  const hasStoredSecret = isSecret && setting.source !== 'default';

  return (
    <div className="border-t border-[var(--color-line)] px-4 py-3 first:border-t-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <label htmlFor={setting.key} className="text-sm font-medium">
          {setting.label}
        </label>
        <div className="flex items-center gap-2">
          {setting.deferred ? <Pill tone="neutral">next transfer</Pill> : null}
          <span title={SOURCE_HINT[setting.source]}>
            <Pill tone={SOURCE_TONE[setting.source]}>{setting.source}</Pill>
          </span>
        </div>
      </div>

      <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">{setting.hint}</p>

      <div className="mt-2">
        {setting.kind === 'boolean' ? (
          <select
            id={setting.key}
            className="input w-full"
            value={value}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="">— use {setting.source === 'database' ? 'environment/default' : 'current'} —</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : (
          <input
            id={setting.key}
            className="input w-full font-mono text-sm"
            type={isSecret ? 'password' : setting.kind === 'number' ? 'number' : 'text'}
            inputMode={setting.kind === 'number' ? 'numeric' : undefined}
            value={value}
            autoComplete={isSecret ? 'new-password' : 'off'}
            placeholder={
              hasStoredSecret
                ? `${setting.display} — leave blank to keep`
                : setting.display || 'not set'
            }
            onChange={(event) => onChange(event.target.value)}
          />
        )}
      </div>

      {/* Sizes echo back what was typed, resolved. "25 GB" and "25000000000"
          look equally plausible in a box and differ by 7%, so the only way to
          be sure which one you asked for is to be shown it. */}
      {setting.kind === 'bytes' && value.trim() !== '' ? (
        <p className="mt-1 text-xs">
          {parseBytes(value) === null ? (
            <span className="text-[var(--color-danger)]">
              Not a size — try 25 GB, 500 MB, or 1.5 TB
            </span>
          ) : (
            <span className="text-[var(--color-ink-muted)]">
              = {formatBytes(parseBytes(value)!)} ({parseBytes(value)!.toLocaleString()} bytes)
            </span>
          )}
        </p>
      ) : null}

      <p className="mt-1 font-mono text-[11px] text-[var(--color-ink-faint)]">{setting.envVar}</p>
    </div>
  );
}

export function SettingsForm({ settings }: { settings: SettingView[] }) {
  // Only edited fields are sent, so a blank secret means "unchanged" rather
  // than "erase" — the destructive reading of an empty box is never the one a
  // password field should get by accident.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const groups = [...new Set(settings.map((setting) => setting.group))];
  const dirty = Object.keys(edits).length > 0;

  function save() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateSettingsAction(edits);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEdits({});
      setSaved(true);
    });
  }

  function clear(key: string) {
    // An explicit empty string is what tells the server to delete the override.
    setEdits((current) => ({ ...current, [key]: '' }));
  }

  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <section key={group}>
          <h3 className="mb-2 text-sm font-medium text-[var(--color-ink-muted)]">
            {GROUP_LABELS[group] ?? group}
          </h3>
          <div className="card overflow-hidden">
            {settings
              .filter((setting) => setting.group === group)
              .map((setting) => (
                <div key={setting.key} className="relative">
                  <Field
                    setting={setting}
                    value={edits[setting.key] ?? ''}
                    onChange={(next) =>
                      setEdits((current) => ({ ...current, [setting.key]: next }))
                    }
                  />
                  {setting.source === 'database' ? (
                    <button
                      type="button"
                      className="btn btn-sm absolute bottom-3 right-4"
                      onClick={() => clear(setting.key)}
                      title="Delete the stored value and fall back to the environment or default"
                    >
                      {edits[setting.key] === '' ? 'will reset' : 'Reset'}
                    </button>
                  ) : null}
                </div>
              ))}
          </div>
        </section>
      ))}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-[var(--color-ink-faint)]">
          {dirty
            ? `${Object.keys(edits).length} change(s) not yet saved`
            : 'Changes apply immediately — no restart.'}
        </div>
        <button type="button" className="btn" onClick={save} disabled={!dirty || pending}>
          {pending ? 'Saving…' : 'Save changes'}
        </button>
      </div>

      {error ? (
        <Callout tone="danger" title="Could not save">
          {error}
        </Callout>
      ) : null}
      {saved && !dirty ? (
        <Callout tone="ok" title="Saved">
          Configuration updated and in effect now.
        </Callout>
      ) : null}
    </div>
  );
}
