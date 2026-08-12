-- CreateTable
CREATE TABLE "Server" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "authKind" TEXT NOT NULL,
    "secretCipher" TEXT NOT NULL,
    "tokenCipher" TEXT,
    "isTarget" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "serverVersion" TEXT,
    "accountLabel" TEXT,
    "canDownload" BOOLEAN NOT NULL DEFAULT false,
    "canUpload" BOOLEAN NOT NULL DEFAULT false,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "lastVerifiedAt" DATETIME,
    "lastIndexedAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Library" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    "absId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mediaType" TEXT,
    "foldersJson" TEXT NOT NULL DEFAULT '[]',
    "included" BOOLEAN NOT NULL DEFAULT true,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "lastIndexedAt" DATETIME,
    CONSTRAINT "Library_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IndexedItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    "libraryId" TEXT NOT NULL,
    "absItemId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "authorsJson" TEXT NOT NULL DEFAULT '[]',
    "narratorsJson" TEXT NOT NULL DEFAULT '[]',
    "seriesJson" TEXT NOT NULL DEFAULT '[]',
    "asin" TEXT,
    "isbn" TEXT,
    "publishedYear" TEXT,
    "publisher" TEXT,
    "language" TEXT,
    "durationSec" REAL,
    "sizeBytes" REAL,
    "numAudioFiles" INTEGER,
    "hasAudio" BOOLEAN NOT NULL DEFAULT true,
    "hasEbook" BOOLEAN NOT NULL DEFAULT false,
    "explicit" BOOLEAN NOT NULL DEFAULT false,
    "absUpdatedAt" DATETIME,
    "normTitle" TEXT NOT NULL,
    "normAuthor" TEXT NOT NULL DEFAULT '',
    "normSeries" TEXT,
    "seenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IndexedItem_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "IndexedItem_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "Library" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IndexRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "itemsIndexed" INTEGER NOT NULL DEFAULT 0,
    "itemsRemoved" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "error" TEXT,
    CONSTRAINT "IndexRun_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SyncJob" (
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

-- CreateTable
CREATE TABLE "SeriesWatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "seriesName" TEXT NOT NULL,
    "normSeries" TEXT NOT NULL,
    "author" TEXT,
    "targetServerId" TEXT NOT NULL,
    "targetLibraryId" TEXT NOT NULL,
    "targetFolderId" TEXT NOT NULL,
    "sourceScope" TEXT NOT NULL DEFAULT 'all',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "autoEnqueue" BOOLEAN NOT NULL DEFAULT true,
    "lastCheckedAt" DATETIME,
    "lastFoundAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SeriesWatch_targetServerId_fkey" FOREIGN KEY ("targetServerId") REFERENCES "Server" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SeriesWatch_targetLibraryId_fkey" FOREIGN KEY ("targetLibraryId") REFERENCES "Library" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL DEFAULT 'info',
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "dataJson" TEXT
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Server_baseUrl_name_key" ON "Server"("baseUrl", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Library_serverId_absId_key" ON "Library"("serverId", "absId");

-- CreateIndex
CREATE INDEX "IndexedItem_libraryId_idx" ON "IndexedItem"("libraryId");

-- CreateIndex
CREATE INDEX "IndexedItem_normTitle_idx" ON "IndexedItem"("normTitle");

-- CreateIndex
CREATE INDEX "IndexedItem_normSeries_idx" ON "IndexedItem"("normSeries");

-- CreateIndex
CREATE INDEX "IndexedItem_asin_idx" ON "IndexedItem"("asin");

-- CreateIndex
CREATE UNIQUE INDEX "IndexedItem_serverId_absItemId_key" ON "IndexedItem"("serverId", "absItemId");

-- CreateIndex
CREATE INDEX "IndexRun_serverId_startedAt_idx" ON "IndexRun"("serverId", "startedAt");

-- CreateIndex
CREATE INDEX "SyncJob_status_createdAt_idx" ON "SyncJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SyncJob_sourceServerId_sourceItemId_targetServerId_idx" ON "SyncJob"("sourceServerId", "sourceItemId", "targetServerId");

-- CreateIndex
CREATE INDEX "SeriesWatch_enabled_idx" ON "SeriesWatch"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "SeriesWatch_normSeries_targetLibraryId_key" ON "SeriesWatch"("normSeries", "targetLibraryId");

-- CreateIndex
CREATE INDEX "ActivityLog_at_idx" ON "ActivityLog"("at");

-- CreateIndex
CREATE INDEX "ActivityLog_kind_at_idx" ON "ActivityLog"("kind", "at");
