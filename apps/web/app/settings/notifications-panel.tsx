'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { sendTestNotificationAction, subscribePushAction, unsubscribePushAction } from '../actions';
import { Callout, Pill } from '../components/ui';

/**
 * Browser push enrolment.
 *
 * The VAPID public key arrives as a prop from the server component rather than
 * through `NEXT_PUBLIC_*`. Next inlines those at build time, and this app is
 * built once and configured through the environment at boot — a baked-in key
 * would mean rebuilding the image to change one setting, and would silently
 * keep using the old key if you forgot.
 */

/**
 * The subscribe call wants the key as bytes, not the base64url it is stored as.
 *
 * The array is built on an explicit ArrayBuffer rather than by length: bare
 * `new Uint8Array(n)` types as `Uint8Array<ArrayBufferLike>`, which no longer
 * satisfies `BufferSource` now that it could be backed by a SharedArrayBuffer.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(normalized);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

type State =
  | { status: 'checking' }
  | { status: 'unsupported'; reason: string }
  | { status: 'off' }
  | { status: 'on'; endpoint: string }
  | { status: 'denied' };

export function NotificationsPanel({
  vapidPublicKey,
  mattermost,
  mattermostChannel,
  subscriptionCount,
}: {
  vapidPublicKey: string | null;
  /** Which Mattermost transport the config selects, or null for neither. */
  mattermost: 'api' | 'webhook' | null;
  mattermostChannel: string | null;
  subscriptionCount: number;
}) {
  const [state, setState] = useState<State>({ status: 'checking' });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const refresh = useCallback(async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      // Overwhelmingly this is a page served over plain http: both the Push API
      // and the Notification API are secure-context only, so the feature
      // detection above fails on a LAN IP even in a browser that supports it.
      setState({
        status: 'unsupported',
        reason: window.isSecureContext
          ? 'This browser does not support the Push API.'
          : 'Push notifications need a secure context. Open abs-sync over HTTPS (or on localhost) to enable them.',
      });
      return;
    }
    if (Notification.permission === 'denied') {
      setState({ status: 'denied' });
      return;
    }
    const registration = await navigator.serviceWorker.getRegistration('/');
    const existing = await registration?.pushManager.getSubscription();
    setState(existing ? { status: 'on', endpoint: existing.endpoint } : { status: 'off' });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function enable() {
    setError(null);
    setNotice(null);
    try {
      if (!vapidPublicKey) throw new Error('No VAPID public key is configured on the server.');

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? { status: 'denied' } : { status: 'off' });
        return;
      }

      // `register` resolves before the worker is active; `ready` is what
      // guarantees pushManager is usable.
      await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
      const registration = await navigator.serviceWorker.ready;

      const subscription = await registration.pushManager.subscribe({
        // Required by Chrome: every push must result in something the user
        // sees, which is exactly what this feature does anyway.
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });

      const serialized = JSON.parse(JSON.stringify(subscription)) as {
        endpoint: string;
        keys: { p256dh: string; auth: string };
      };
      const result = await subscribePushAction(serialized, navigator.userAgent);
      if (!result.ok) throw new Error(result.error);

      setState({ status: 'on', endpoint: subscription.endpoint });
      setNotice('This device will now receive notifications.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function disable() {
    setError(null);
    setNotice(null);
    try {
      const registration = await navigator.serviceWorker.getRegistration('/');
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await subscription.unsubscribe();
        await unsubscribePushAction(subscription.endpoint);
      }
      setState({ status: 'off' });
      setNotice('This device will no longer receive notifications.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function sendTest() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await sendTestNotificationAction();
      if (result.ok) setNotice('Test sent to every configured transport.');
      else setError(result.error);
    });
  }

  const anyTransport = mattermost !== null || state.status === 'on';

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-3 px-4 py-2.5">
        <div>
          <div className="text-sm font-medium">Mattermost</div>
          <div className="text-xs text-[var(--color-ink-faint)]">
            {mattermost === 'api'
              ? `Posting as the token's account${mattermostChannel ? ` to ~${mattermostChannel}` : ''}`
              : mattermost === 'webhook'
                ? 'Posting through an incoming webhook'
                : 'ABS_SYNC_MATTERMOST_URL + _TOKEN + _CHANNEL, or a _WEBHOOK_URL'}
          </div>
        </div>
        {mattermost === 'api' ? (
          <Pill tone="ok">API</Pill>
        ) : mattermost === 'webhook' ? (
          <Pill tone="ok">webhook</Pill>
        ) : (
          <Pill tone="neutral">not set</Pill>
        )}
      </div>

      <div className="flex flex-wrap items-baseline justify-between gap-3 border-t border-[var(--color-line)] px-4 py-2.5">
        <div>
          <div className="text-sm font-medium">This browser</div>
          <div className="text-xs text-[var(--color-ink-faint)]">
            Web Push — works with abs-sync closed
            {subscriptionCount > 0
              ? ` · ${subscriptionCount} device${subscriptionCount === 1 ? '' : 's'} subscribed`
              : ''}
          </div>
        </div>

        {state.status === 'checking' ? <Pill tone="neutral">checking…</Pill> : null}

        {state.status === 'on' ? (
          <div className="flex items-center gap-2">
            <Pill tone="ok">on</Pill>
            <button type="button" className="btn btn-sm" onClick={disable}>
              Turn off
            </button>
          </div>
        ) : null}

        {state.status === 'off' ? (
          <button type="button" className="btn btn-sm" onClick={enable} disabled={!vapidPublicKey}>
            Enable on this device
          </button>
        ) : null}

        {state.status === 'denied' ? <Pill tone="danger">blocked in browser</Pill> : null}
        {state.status === 'unsupported' ? <Pill tone="neutral">unavailable</Pill> : null}
      </div>

      {state.status === 'unsupported' ? (
        <div className="border-t border-[var(--color-line)] px-4 py-3">
          <Callout tone="info" title="Browser notifications unavailable here">
            {state.reason}
          </Callout>
        </div>
      ) : null}

      {state.status === 'denied' ? (
        <div className="border-t border-[var(--color-line)] px-4 py-3">
          <Callout tone="warn" title="Notifications are blocked">
            This browser is refusing notifications for abs-sync. The block lives in site settings
            (the icon beside the address bar) and cannot be lifted from the page.
          </Callout>
        </div>
      ) : null}

      {state.status === 'off' && !vapidPublicKey ? (
        <div className="border-t border-[var(--color-line)] px-4 py-3">
          <Callout tone="info" title="No VAPID keys configured">
            Generate a keypair with <code>npm run notify:keys</code>, put it in <code>.env</code> as{' '}
            <code>ABS_SYNC_VAPID_PUBLIC_KEY</code> and <code>ABS_SYNC_VAPID_PRIVATE_KEY</code>, then
            restart.
          </Callout>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-line)] px-4 py-2.5">
        <div className="text-xs text-[var(--color-ink-faint)]">
          Failures notify immediately; routine activity is batched into one message.
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={sendTest}
          disabled={pending || !anyTransport}
        >
          {pending ? 'Sending…' : 'Send test'}
        </button>
      </div>

      {error ? (
        <div className="border-t border-[var(--color-line)] px-4 py-3">
          <Callout tone="danger" title="Notification problem">
            {error}
          </Callout>
        </div>
      ) : null}
      {notice ? (
        <div className="border-t border-[var(--color-line)] px-4 py-2.5 text-xs text-[var(--color-ink-muted)]">
          {notice}
        </div>
      ) : null}
    </div>
  );
}
