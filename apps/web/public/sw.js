/**
 * abs-sync service worker — push notifications only.
 *
 * Served from `public/` rather than bundled, so it lives at the origin root and
 * can legitimately claim the `/` scope. A worker emitted into `/_next/static/`
 * is confined to that path unless the server also sends `Service-Worker-Allowed`,
 * which is a lot of machinery for a file with no build step in it.
 *
 * There is deliberately no fetch handler: caching pages would serve stale
 * transfer state from a tool whose whole job is reporting what is happening
 * right now.
 */

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'abs-sync', body: event.data.text() };
  }

  const options = {
    body: payload.body,
    icon: '/icon-192.png',
    badge: '/badge.png',
    // Errors should persist until acknowledged; routine digests should not
    // demand a tap.
    requireInteraction: payload.level === 'error',
    // Collapse by severity, so a burst of routine digests replaces itself in
    // the tray instead of burying an error under six "7 books queued".
    tag: payload.level === 'error' ? 'abs-sync-error' : 'abs-sync-activity',
    renotify: payload.level === 'error',
    timestamp: Date.now(),
    data: { url: payload.url || '/' },
  };

  event.waitUntil(self.registration.showNotification(payload.title || 'abs-sync', options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';

  // Focus an already-open abs-sync tab rather than piling up new ones; only
  // open a window when none is there to reuse.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          if ('navigate' in client && client.url !== target) client.navigate(target).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
