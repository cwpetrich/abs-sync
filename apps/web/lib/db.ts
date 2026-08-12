import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '../generated/prisma/client';
import { getEnv } from './env';

/**
 * Prisma singleton.
 *
 * Next dev-mode hot reload re-evaluates modules, so the client is cached on
 * globalThis to avoid exhausting SQLite connections across reloads.
 */
const globalForPrisma = globalThis as unknown as { absSyncPrisma?: PrismaClient };

function createClient(): PrismaClient {
  const adapter = new PrismaBetterSqlite3({ url: getEnv().databaseUrl });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

export const prisma: PrismaClient = globalForPrisma.absSyncPrisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.absSyncPrisma = prisma;
}

export type { PrismaClient };
