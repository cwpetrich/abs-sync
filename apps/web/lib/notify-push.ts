import webpush, { WebPushError } from 'web-push';
import { prisma } from './db';
import { getEnv } from './env';
import type { Notification } from './notify';

/**
 * Web Push delivery to every subscribed browser.
 *
 * Payloads are encrypted to keys the browser generated, so the push service
 * (Google, Mozilla, Apple) relays ciphertext it cannot read. VAPID is what
 * identifies this server to that service; the keypair is self-generated and
 * costs nothing.
 */

let configuredFor: string | null = null;

/**
 * Applies the VAPID identity once per key, rather than on every send.
 *
 * `setVapidDetails` mutates module-level state in `web-push`, so calling it per
 * notification is both wasteful and a race when two transfers finish at once.
 */
function ensureConfigured(): boolean {
  const { vapidPublicKey, vapidPrivateKey, vapidSubject } = getEnv();
  if (!vapidPublicKey || !vapidPrivateKey) return false;
  if (configuredFor === vapidPublicKey) return true;

  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  configuredFor = vapidPublicKey;
  return true;
}

/** Push services cap payloads around 4 KB once encrypted. */
const MAX_BODY_CHARS = 1_500;

export async function sendWebPush(notification: Notification): Promise<void> {
  if (!ensureConfigured()) return;

  const subscriptions = await prisma.pushSubscription.findMany();
  if (subscriptions.length === 0) return;

  const payload = JSON.stringify({
    title: notification.title,
    body: notification.body.slice(0, MAX_BODY_CHARS),
    level: notification.level,
    url: notification.url,
  });

  const expired: string[] = [];
  const delivered: string[] = [];
  const failures: string[] = [];

  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          payload,
          // Hold it for a day if the device is offline, and let a newer digest
          // replace an undelivered one rather than stacking them up.
          { TTL: 24 * 60 * 60, urgency: notification.level === 'error' ? 'high' : 'normal' },
        );
        delivered.push(subscription.id);
      } catch (error) {
        // 404/410 mean the browser threw the subscription away — the user
        // cleared site data, or the push service rotated it. That is the only
        // signal worth acting on; a 5xx or a timeout means the service is
        // unwell, and dropping a good subscription over it would silently
        // unsubscribe someone.
        if (error instanceof WebPushError && (error.statusCode === 404 || error.statusCode === 410)) {
          expired.push(subscription.id);
        } else {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
    }),
  );

  if (expired.length > 0) {
    await prisma.pushSubscription
      .deleteMany({ where: { id: { in: expired } } })
      .catch(() => undefined);
  }
  if (delivered.length > 0) {
    await prisma.pushSubscription
      .updateMany({ where: { id: { in: delivered } }, data: { lastSentAt: new Date() } })
      .catch(() => undefined);
  }
  if (failures.length > 0 && delivered.length === 0) {
    // Only escalate when nothing at all got through: one dead device among
    // several is not worth a log line on every notification.
    throw new Error(`web push failed for all ${failures.length} subscription(s): ${failures[0]}`);
  }
}
