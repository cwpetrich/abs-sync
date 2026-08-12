import { AbsClient, type AbsAuth, type AbsIdentity } from '@abs-sync/abs-client';
import type { Server } from '../generated/prisma/client';
import { decryptJson, encryptJson } from './crypto';
import { prisma } from './db';
import { getEnv } from './env';
import { nodeUploadTransport } from './node-upload';
import { describeError, logActivity } from './activity';

export type ServerCredentials =
  | { kind: 'apiKey'; apiKey: string }
  | { kind: 'password'; username: string; password: string };

export interface ServerFolder {
  id: string;
  fullPath: string;
}

/** Shape safe to send to the browser — no secrets. */
export interface PublicServer {
  id: string;
  name: string;
  baseUrl: string;
  authKind: string;
  accountLabel: string | null;
  isTarget: boolean;
  enabled: boolean;
  serverVersion: string | null;
  canDownload: boolean;
  canUpload: boolean;
  isAdmin: boolean;
  lastVerifiedAt: Date | null;
  lastIndexedAt: Date | null;
  lastFullIndexAt: Date | null;
  lastError: string | null;
  itemCount: number;
  libraries: Array<{
    id: string;
    absId: string;
    name: string;
    included: boolean;
    itemCount: number;
    lastIndexedAt: Date | null;
    folders: ServerFolder[];
  }>;
}

export class ServerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerValidationError';
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/** Validates and canonicalizes a user-entered server URL. */
export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new ServerValidationError('Server URL is required');

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ServerValidationError(`"${raw}" is not a valid URL`);
  }

  if (getEnv().requireHttps && url.protocol !== 'https:' && !LOCAL_HOSTS.has(url.hostname)) {
    throw new ServerValidationError(
      `${url.hostname} must be reached over https (ABS_SYNC_REQUIRE_HTTPS is enabled)`,
    );
  }

  // Preserve a path prefix (reverse proxies often mount ABS under a subpath)
  // but drop query, hash and any trailing slash.
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

function validateCredentials(credentials: ServerCredentials): void {
  if (credentials.kind === 'apiKey') {
    if (!credentials.apiKey.trim()) throw new ServerValidationError('API key is required');
    return;
  }
  if (!credentials.username.trim()) throw new ServerValidationError('Username is required');
  if (!credentials.password) throw new ServerValidationError('Password is required');
}

function toAuth(credentials: ServerCredentials): AbsAuth {
  return credentials.kind === 'apiKey'
    ? { kind: 'apiKey', apiKey: credentials.apiKey.trim() }
    : { kind: 'password', username: credentials.username.trim(), password: credentials.password };
}

/** Reads and decrypts the stored credential for a server row. */
export function credentialsFor(server: Pick<Server, 'secretCipher'>): ServerCredentials {
  return decryptJson<ServerCredentials>(server.secretCipher);
}

/**
 * Builds a client for a saved server. Password-auth tokens are cached back into
 * the database so repeated runs do not re-login on every request.
 */
export function clientFor(server: Server): AbsClient {
  const credentials = credentialsFor(server);
  const cachedToken = server.tokenCipher ? decryptJson<string>(server.tokenCipher) : undefined;

  return new AbsClient({
    baseUrl: server.baseUrl,
    auth: toAuth(credentials),
    serverKey: server.id,
    initialToken: cachedToken,
    userAgent: 'abs-sync/0.1',
    uploadTransport: nodeUploadTransport,
    onToken: (token) => {
      // Fire-and-forget: a failed cache write only costs an extra login later.
      prisma.server
        .update({ where: { id: server.id }, data: { tokenCipher: encryptJson(token) } })
        .catch((error: unknown) => {
          console.error('[abs-sync] could not cache login token:', describeError(error));
        });
    },
  });
}

/** Client built from raw form input, for the "Test connection" button. */
export function clientForInput(baseUrl: string, credentials: ServerCredentials): AbsClient {
  validateCredentials(credentials);
  return new AbsClient({
    baseUrl: normalizeServerUrl(baseUrl),
    auth: toAuth(credentials),
    serverKey: 'preview',
  });
}

export interface ConnectionTestResult {
  ok: boolean;
  serverVersion: string | null;
  accountLabel: string | null;
  isAdmin: boolean;
  canDownload: boolean;
  canUpload: boolean;
  libraries: Array<{ absId: string; name: string; mediaType: string | null; folders: ServerFolder[] }>;
  /** Problems that do not block saving but limit what sync can do. */
  warnings: string[];
  error?: string;
}

function foldersOf(library: { folders?: Array<{ id?: string; fullPath?: string }> }): ServerFolder[] {
  return (library.folders ?? [])
    .filter((folder) => Boolean(folder?.id))
    .map((folder) => ({ id: folder.id!, fullPath: folder.fullPath ?? '' }));
}

function warningsFor(identity: AbsIdentity, isTarget: boolean): string[] {
  const warnings: string[] = [];
  if (!identity.canDownload) {
    warnings.push(
      'This account cannot download items, so books cannot be pulled from this server. ' +
        'Enable the "Download" permission for the account, or use an API key tied to an admin.',
    );
  }
  if (isTarget && !identity.canUpload) {
    warnings.push(
      'This account cannot upload, so it cannot receive synced books. ' +
        'Enable the "Upload" permission on the account behind this credential.',
    );
  }
  return warnings;
}

/** Probes a server without saving anything. */
export async function testConnection(
  baseUrl: string,
  credentials: ServerCredentials,
  options: { asTarget?: boolean } = {},
): Promise<ConnectionTestResult> {
  const empty: ConnectionTestResult = {
    ok: false,
    serverVersion: null,
    accountLabel: null,
    isAdmin: false,
    canDownload: false,
    canUpload: false,
    libraries: [],
    warnings: [],
  };

  try {
    const client = clientForInput(baseUrl, credentials);
    const identity = await client.verify();
    const libraries = await client.getLibraries();

    return {
      ok: true,
      serverVersion: identity.serverVersion,
      accountLabel: identity.user.username ?? null,
      isAdmin: identity.isAdmin,
      canDownload: identity.canDownload,
      canUpload: identity.canUpload,
      libraries: libraries
        // Podcast libraries have no place in a book diff.
        .filter((library) => !library.mediaType || library.mediaType === 'book')
        .map((library) => ({
          absId: library.id!,
          name: library.name ?? library.id!,
          mediaType: library.mediaType ?? null,
          folders: foldersOf(library),
        })),
      warnings: warningsFor(identity, options.asTarget ?? false),
    };
  } catch (error) {
    return { ...empty, error: describeError(error) };
  }
}

export interface CreateServerInput {
  name: string;
  baseUrl: string;
  credentials: ServerCredentials;
  isTarget?: boolean;
}

/** Saves a new server after verifying the credential works. */
export async function createServer(input: CreateServerInput): Promise<PublicServer> {
  const name = input.name.trim();
  if (!name) throw new ServerValidationError('Name is required');
  validateCredentials(input.credentials);
  const baseUrl = normalizeServerUrl(input.baseUrl);

  const test = await testConnection(baseUrl, input.credentials, { asTarget: input.isTarget });
  if (!test.ok) {
    throw new ServerValidationError(`Could not connect: ${test.error ?? 'unknown error'}`);
  }

  const existing = await prisma.server.findFirst({ where: { baseUrl, name } });
  if (existing) {
    throw new ServerValidationError(`A server named "${name}" at ${baseUrl} already exists`);
  }

  const server = await prisma.$transaction(async (tx) => {
    if (input.isTarget) {
      await tx.server.updateMany({ where: { isTarget: true }, data: { isTarget: false } });
    }
    const created = await tx.server.create({
      data: {
        name,
        baseUrl,
        authKind: input.credentials.kind,
        secretCipher: encryptJson(input.credentials),
        isTarget: input.isTarget ?? false,
        serverVersion: test.serverVersion,
        accountLabel: test.accountLabel,
        canDownload: test.canDownload,
        canUpload: test.canUpload,
        isAdmin: test.isAdmin,
        lastVerifiedAt: new Date(),
        lastError: null,
      },
    });

    for (const library of test.libraries) {
      await tx.library.create({
        data: {
          serverId: created.id,
          absId: library.absId,
          name: library.name,
          mediaType: library.mediaType,
          foldersJson: JSON.stringify(library.folders),
        },
      });
    }
    return created;
  });

  await logActivity('server', `Added server "${name}" (${baseUrl})`, {
    data: { serverId: server.id, isTarget: input.isTarget ?? false },
  });

  return (await getServer(server.id))!;
}

export async function updateServer(
  id: string,
  changes: { name?: string; baseUrl?: string; credentials?: ServerCredentials; enabled?: boolean },
): Promise<PublicServer> {
  const server = await prisma.server.findUnique({ where: { id } });
  if (!server) throw new ServerValidationError('Server not found');

  const data: Record<string, unknown> = {};
  if (changes.name !== undefined) {
    if (!changes.name.trim()) throw new ServerValidationError('Name cannot be empty');
    data.name = changes.name.trim();
  }
  if (changes.baseUrl !== undefined) data.baseUrl = normalizeServerUrl(changes.baseUrl);
  if (changes.enabled !== undefined) data.enabled = changes.enabled;
  if (changes.credentials !== undefined) {
    validateCredentials(changes.credentials);
    data.secretCipher = encryptJson(changes.credentials);
    data.authKind = changes.credentials.kind;
    // A new credential invalidates any cached login token.
    data.tokenCipher = null;
  }

  await prisma.server.update({ where: { id }, data });
  await logActivity('server', `Updated server "${changes.name ?? server.name}"`, {
    data: { serverId: id, fields: Object.keys(data) },
  });
  return (await verifyAndRefresh(id)) ?? (await getServer(id))!;
}

export async function setTargetServer(id: string): Promise<void> {
  const server = await prisma.server.findUnique({ where: { id } });
  if (!server) throw new ServerValidationError('Server not found');
  if (!server.canUpload) {
    throw new ServerValidationError(
      `"${server.name}" cannot receive books: the account behind its credential lacks upload permission.`,
    );
  }
  await prisma.$transaction([
    prisma.server.updateMany({ where: { isTarget: true }, data: { isTarget: false } }),
    prisma.server.update({ where: { id }, data: { isTarget: true } }),
  ]);
  await logActivity('server', `"${server.name}" is now the sync target`, { data: { serverId: id } });
}

export async function deleteServer(id: string): Promise<void> {
  const server = await prisma.server.findUnique({ where: { id } });
  if (!server) return;
  // Cascades remove libraries, indexed items, runs and jobs for this server.
  await prisma.server.delete({ where: { id } });
  await logActivity('server', `Removed server "${server.name}"`, { data: { serverId: id } });
}

/** Re-verifies the credential and reconciles the library list. */
export async function verifyAndRefresh(id: string): Promise<PublicServer | null> {
  const server = await prisma.server.findUnique({ where: { id } });
  if (!server) return null;

  try {
    const client = clientFor(server);
    const identity = await client.verify();
    const libraries = await client.getLibraries();

    await prisma.$transaction(async (tx) => {
      await tx.server.update({
        where: { id },
        data: {
          serverVersion: identity.serverVersion,
          accountLabel: identity.user.username ?? null,
          canDownload: identity.canDownload,
          canUpload: identity.canUpload,
          isAdmin: identity.isAdmin,
          lastVerifiedAt: new Date(),
          lastError: null,
        },
      });

      const bookLibraries = libraries.filter(
        (library) => library.id && (!library.mediaType || library.mediaType === 'book'),
      );

      for (const library of bookLibraries) {
        const folders = JSON.stringify(foldersOf(library));
        await tx.library.upsert({
          where: { serverId_absId: { serverId: id, absId: library.id! } },
          create: {
            serverId: id,
            absId: library.id!,
            name: library.name ?? library.id!,
            mediaType: library.mediaType ?? null,
            foldersJson: folders,
          },
          update: {
            name: library.name ?? library.id!,
            mediaType: library.mediaType ?? null,
            foldersJson: folders,
          },
        });
      }

      // Drop libraries that no longer exist upstream.
      const keep = bookLibraries.map((library) => library.id!);
      await tx.library.deleteMany({
        where: { serverId: id, absId: { notIn: keep.length > 0 ? keep : ['__none__'] } },
      });
    });
  } catch (error) {
    const message = describeError(error);
    await prisma.server.update({ where: { id }, data: { lastError: message } });
    await logActivity('server', `Verification failed for "${server.name}": ${message}`, {
      level: 'error',
      data: { serverId: id },
    });
  }

  return getServer(id);
}

function toPublic(
  server: Server & {
    libraries: Array<{
      id: string;
      absId: string;
      name: string;
      included: boolean;
      itemCount: number;
      lastIndexedAt: Date | null;
      foldersJson: string;
    }>;
  },
): PublicServer {
  const libraries = server.libraries.map((library) => {
    let folders: ServerFolder[] = [];
    try {
      folders = JSON.parse(library.foldersJson) as ServerFolder[];
    } catch {
      folders = [];
    }
    return {
      id: library.id,
      absId: library.absId,
      name: library.name,
      included: library.included,
      itemCount: library.itemCount,
      lastIndexedAt: library.lastIndexedAt,
      folders,
    };
  });

  return {
    id: server.id,
    name: server.name,
    baseUrl: server.baseUrl,
    authKind: server.authKind,
    accountLabel: server.accountLabel,
    isTarget: server.isTarget,
    enabled: server.enabled,
    serverVersion: server.serverVersion,
    canDownload: server.canDownload,
    canUpload: server.canUpload,
    isAdmin: server.isAdmin,
    lastVerifiedAt: server.lastVerifiedAt,
    lastIndexedAt: server.lastIndexedAt,
    lastFullIndexAt: server.lastFullIndexAt,
    lastError: server.lastError,
    itemCount: libraries.reduce((sum, library) => sum + library.itemCount, 0),
    libraries,
  };
}

export async function getServer(id: string): Promise<PublicServer | null> {
  const server = await prisma.server.findUnique({
    where: { id },
    include: { libraries: { orderBy: { name: 'asc' } } },
  });
  return server ? toPublic(server) : null;
}

export async function listServers(): Promise<PublicServer[]> {
  const servers = await prisma.server.findMany({
    orderBy: [{ isTarget: 'desc' }, { name: 'asc' }],
    include: { libraries: { orderBy: { name: 'asc' } } },
  });
  return servers.map(toPublic);
}

export async function getTargetServer(): Promise<PublicServer | null> {
  const server = await prisma.server.findFirst({
    where: { isTarget: true },
    include: { libraries: { orderBy: { name: 'asc' } } },
  });
  return server ? toPublic(server) : null;
}

export async function setLibraryIncluded(libraryId: string, included: boolean): Promise<void> {
  await prisma.library.update({ where: { id: libraryId }, data: { included } });
}
