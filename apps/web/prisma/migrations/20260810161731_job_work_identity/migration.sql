-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SyncJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "phase" TEXT NOT NULL DEFAULT 'pending',
    "sourceServerId" TEXT NOT NULL,
    "sourceItemId" TEXT NOT NULL,
    "sourceLibraryId" TEXT NOT NULL,
    "targetServerId" TEXT NOT NULL,
    "targetLibraryId" TEXT NOT NULL,
    "targetFolderId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT,
    "series" TEXT,
    "normTitle" TEXT NOT NULL DEFAULT '',
    "normAuthor" TEXT NOT NULL DEFAULT '',
    "totalBytes" REAL,
    "downloadedBytes" REAL NOT NULL DEFAULT 0,
    "uploadedBytes" REAL NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "error" TEXT,
    "spoolPath" TEXT,
    "resultItemId" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'manual',
    "watchId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    CONSTRAINT "SyncJob_sourceServerId_fkey" FOREIGN KEY ("sourceServerId") REFERENCES "Server" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SyncJob_targetServerId_fkey" FOREIGN KEY ("targetServerId") REFERENCES "Server" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SyncJob_targetLibraryId_fkey" FOREIGN KEY ("targetLibraryId") REFERENCES "Library" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SyncJob_watchId_fkey" FOREIGN KEY ("watchId") REFERENCES "SeriesWatch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_SyncJob" ("attempts", "author", "createdAt", "downloadedBytes", "error", "finishedAt", "id", "maxAttempts", "origin", "phase", "resultItemId", "series", "sourceItemId", "sourceLibraryId", "sourceServerId", "spoolPath", "startedAt", "status", "targetFolderId", "targetLibraryId", "targetServerId", "title", "totalBytes", "uploadedBytes", "watchId") SELECT "attempts", "author", "createdAt", "downloadedBytes", "error", "finishedAt", "id", "maxAttempts", "origin", "phase", "resultItemId", "series", "sourceItemId", "sourceLibraryId", "sourceServerId", "spoolPath", "startedAt", "status", "targetFolderId", "targetLibraryId", "targetServerId", "title", "totalBytes", "uploadedBytes", "watchId" FROM "SyncJob";
DROP TABLE "SyncJob";
ALTER TABLE "new_SyncJob" RENAME TO "SyncJob";
CREATE INDEX "SyncJob_status_createdAt_idx" ON "SyncJob"("status", "createdAt");
CREATE INDEX "SyncJob_sourceServerId_sourceItemId_targetServerId_idx" ON "SyncJob"("sourceServerId", "sourceItemId", "targetServerId");
CREATE INDEX "SyncJob_targetServerId_normTitle_normAuthor_idx" ON "SyncJob"("targetServerId", "normTitle", "normAuthor");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
