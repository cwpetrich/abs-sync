'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { addServerAction, testConnectionAction } from '../actions';
import type { ConnectionTestResult } from '../../lib/servers';
import { Callout } from '../components/ui';

export function ServerForm({ hasTarget }: { hasTarget: boolean }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [authKind, setAuthKind] = useState<'apiKey' | 'password'>('apiKey');
  const [test, setTest] = useState<ConnectionTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  /**
   * Both buttons are plain buttons rather than submitters, and the form has no
   * `action`. React 19 resets uncontrolled fields once a function action
   * settles, which would wipe everything the user typed after a connection test
   * — or after a failed save, which is worse. Reading FormData off the element
   * keeps the fields intact and lets us clear them only when we mean to.
   */
  function readForm(): FormData | null {
    const form = formRef.current;
    return form ? new FormData(form) : null;
  }

  function handleTest() {
    const formData = readForm();
    if (!formData) return;

    // Testing deliberately does not require a display name, so validate only
    // what the probe actually needs instead of running full form validation.
    if (!String(formData.get('baseUrl') ?? '').trim()) {
      setTest(null);
      setError('Enter the server URL first.');
      return;
    }
    const hasCredential =
      authKind === 'apiKey'
        ? String(formData.get('apiKey') ?? '').trim().length > 0
        : String(formData.get('username') ?? '').trim().length > 0 &&
          String(formData.get('password') ?? '').length > 0;
    if (!hasCredential) {
      setTest(null);
      setError(authKind === 'apiKey' ? 'Enter the API key first.' : 'Enter a username and password.');
      return;
    }

    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await testConnectionAction(formData);
      if (!result.ok) {
        setTest(null);
        setError(result.error);
        return;
      }
      setTest(result.data);
      if (!result.data.ok) setError(result.data.error ?? 'Connection failed');
    });
  }

  function handleSave() {
    const form = formRef.current;
    const formData = readForm();
    if (!form || !formData) return;
    // Native validation for the required fields, then our own submission.
    if (!form.reportValidity()) return;

    setError(null);
    startTransition(async () => {
      const result = await addServerAction(formData);
      if (!result.ok) {
        // Keep every field so the user can correct one thing and retry.
        setError(result.error);
        return;
      }
      setSaved(true);
      setTest(null);
      form.reset();
      // The radio group is controlled, so bring it back in line with the DOM.
      setAuthKind('apiKey');
      // Ensure the newly added server appears in the list beside this form.
      router.refresh();
    });
  }

  return (
    <form ref={formRef} className="card space-y-4 p-5" onSubmit={(event) => event.preventDefault()}>
      <div>
        <h2 className="font-medium">Add a server</h2>
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          An API key is the better choice: it is revocable, has an optional expiry, and is what
          Audiobookshelf recommends for server-to-server use. Create one under{' '}
          <span className="text-[var(--color-ink)]">Settings → Users → API Keys</span> on the
          Audiobookshelf server (2.26+, admin only).
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="name">
            Display name
          </label>
          <input id="name" name="name" className="field" placeholder="Conrad's server" required />
        </div>
        <div>
          <label className="label" htmlFor="baseUrl">
            Server URL
          </label>
          <input
            id="baseUrl"
            name="baseUrl"
            className="field"
            placeholder="https://abs.example.com"
            required
          />
        </div>
      </div>

      <fieldset>
        <legend className="label">Authentication</legend>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="authKind"
              value="apiKey"
              checked={authKind === 'apiKey'}
              onChange={() => setAuthKind('apiKey')}
            />
            API key
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="authKind"
              value="password"
              checked={authKind === 'password'}
              onChange={() => setAuthKind('password')}
            />
            Username &amp; password
          </label>
        </div>
      </fieldset>

      {authKind === 'apiKey' ? (
        <div>
          <label className="label" htmlFor="apiKey">
            API key
          </label>
          <input
            id="apiKey"
            name="apiKey"
            type="password"
            className="field font-mono"
            autoComplete="off"
            placeholder="eyJhbGciOi…"
          />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="username">
              Username
            </label>
            <input id="username" name="username" className="field" autoComplete="off" />
          </div>
          <div>
            <label className="label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              className="field"
              autoComplete="off"
            />
          </div>
        </div>
      )}

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="isTarget" className="mt-1" defaultChecked={!hasTarget} />
        <span>
          This is <strong>my</strong> server — the one books get synced into.
          <span className="block text-xs text-[var(--color-ink-muted)]">
            Needs upload permission. Only one server can be the target; setting this moves it.
          </span>
        </span>
      </label>

      {error ? (
        <Callout tone="danger" title="Could not connect">
          {error}
        </Callout>
      ) : null}

      {saved ? (
        <Callout tone="ok" title="Server added">
          Run an index on it to pull in its library.
        </Callout>
      ) : null}

      {test?.ok ? (
        <Callout tone="ok" title="Connection works">
          <ul className="space-y-1">
            <li>
              Signed in as <strong>{test.accountLabel ?? 'unknown'}</strong>
              {test.isAdmin ? ' (admin)' : ''} · Audiobookshelf {test.serverVersion ?? '?'}
            </li>
            <li>
              {test.libraries.length} book librar{test.libraries.length === 1 ? 'y' : 'ies'}:{' '}
              {test.libraries.map((library) => library.name).join(', ') || 'none'}
            </li>
            <li>
              Download {test.canDownload ? '✓' : '✗'} · Upload {test.canUpload ? '✓' : '✗'}
            </li>
          </ul>
          {test.warnings.length > 0 ? (
            <ul className="mt-2 space-y-1 text-[var(--color-warn)]">
              {test.warnings.map((warning) => (
                <li key={warning}>⚠ {warning}</li>
              ))}
            </ul>
          ) : null}
        </Callout>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn" onClick={handleTest} disabled={pending}>
          {pending ? 'Working…' : 'Test connection'}
        </button>
        <button type="button" className="btn btn-primary" onClick={handleSave} disabled={pending}>
          Add server
        </button>
      </div>
    </form>
  );
}
