import type { NextConfig } from 'next';

/**
 * Hostnames this app is reached by, other than localhost — a LAN IP, a
 * machine name, or a reverse-proxy hostname. Comma-separated in
 * ABS_SYNC_ALLOWED_ORIGINS.
 *
 * Two separate mechanisms need this:
 *  - `allowedDevOrigins`: `next dev` blocks cross-origin requests to dev-only
 *    assets (HMR, /_next/*) from hosts it was not started with.
 *  - `serverActions.allowedOrigins`: Next compares a Server Action's Origin
 *    header against Host to prevent CSRF. This app is entirely Server Actions,
 *    so a mismatch breaks every button, not just some.
 */
const allowedOrigins = (process.env.ABS_SYNC_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source rather than a build artifact, so
  // Next has to compile them as part of the app.
  transpilePackages: ['@abs-sync/core', '@abs-sync/abs-client'],

  // better-sqlite3 is a native addon; it must stay external to the server
  // bundle. web-push is Node-only (crypto, http) and has no business being
  // traced into a client bundle.
  serverExternalPackages: ['@prisma/adapter-better-sqlite3', 'better-sqlite3', 'web-push'],

  typedRoutes: true,

  async headers() {
    return [
      {
        // A cached service worker is a stuck service worker: browsers would go
        // on running an old copy for up to 24h after a fix ships, and the
        // symptom — notifications that quietly stop matching the app — is
        // miserable to diagnose.
        source: '/sw.js',
        headers: [
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
        ],
      },
    ];
  },

  ...(allowedOrigins.length > 0
    ? {
        allowedDevOrigins: allowedOrigins,
        experimental: { serverActions: { allowedOrigins } },
      }
    : {}),
};

export default nextConfig;
