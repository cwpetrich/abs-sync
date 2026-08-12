/**
 * Generates the VAPID keypair browser push needs.
 *
 * The keypair identifies this server to the push services; it is not a secret
 * shared with anyone and costs nothing to mint. Rotating it invalidates every
 * existing subscription, so devices have to re-enable notifications — which is
 * why the output goes to stdout for you to paste, rather than being written
 * into .env automatically over whatever is already there.
 */
// Imported straight from web-push rather than through lib/notify-push, which
// reaches the database and the validated config on load. This command is the
// one you run *before* any of that exists.
import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

process.stdout.write(
  [
    '# Add these to apps/web/.env, then restart abs-sync.',
    '# Changing them later unsubscribes every device that had notifications on.',
    `ABS_SYNC_VAPID_PUBLIC_KEY="${publicKey}"`,
    `ABS_SYNC_VAPID_PRIVATE_KEY="${privateKey}"`,
    '',
    '# Push services want a way to contact you about a misbehaving server:',
    '# ABS_SYNC_VAPID_SUBJECT="mailto:you@example.com"',
    '',
  ].join('\n'),
);
