import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import { NavLink } from './components/nav-link';

export const metadata: Metadata = {
  title: 'abs-sync',
  description: 'Compare and sync Audiobookshelf libraries between servers',
};

const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/compare', label: 'Compare' },
  { href: '/watches', label: 'Watched series' },
  { href: '/jobs', label: 'Transfers' },
  { href: '/servers', label: 'Servers' },
  { href: '/settings', label: 'Settings' },
] as const;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="min-h-screen">
          <header className="sticky top-0 z-20 border-b border-[var(--color-line)] bg-[var(--color-surface-1)]/95 backdrop-blur">
            <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
              <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
                <span aria-hidden className="text-lg">
                  🎧
                </span>
                abs-sync
              </Link>
              <nav className="flex flex-1 flex-wrap gap-1" aria-label="Main">
                {NAV.map((item) => (
                  <NavLink key={item.href} href={item.href}>
                    {item.label}
                  </NavLink>
                ))}
              </nav>
            </div>
          </header>
          <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">{children}</main>
        </div>
      </body>
    </html>
  );
}
