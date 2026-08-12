import type { MetadataRoute } from 'next';

/**
 * Web app manifest.
 *
 * This exists for notifications rather than for app-iness: iOS only delivers
 * Web Push to a site that has been installed to the Home Screen, and a site is
 * only installable if it serves a manifest with icons. Without this file,
 * enabling notifications appears to work on an iPhone and then silently never
 * delivers.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'abs-sync',
    short_name: 'abs-sync',
    description: 'Compare Audiobookshelf libraries across servers and pull in what you are missing.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0b0e14',
    theme_color: '#0b0e14',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  };
}
