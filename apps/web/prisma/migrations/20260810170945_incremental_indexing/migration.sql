-- AlterTable
ALTER TABLE "Server" ADD COLUMN "itemSortField" TEXT;
ALTER TABLE "Server" ADD COLUMN "lastFullIndexAt" DATETIME;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_IndexRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "mode" TEXT NOT NULL DEFAULT 'full',
    "itemsIndexed" INTEGER NOT NULL DEFAULT 0,
    "itemsRemoved" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "error" TEXT,
    CONSTRAINT "IndexRun_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_IndexRun" ("error", "finishedAt", "id", "itemsIndexed", "itemsRemoved", "serverId", "startedAt", "status") SELECT "error", "finishedAt", "id", "itemsIndexed", "itemsRemoved", "serverId", "startedAt", "status" FROM "IndexRun";
DROP TABLE "IndexRun";
ALTER TABLE "new_IndexRun" RENAME TO "IndexRun";
CREATE INDEX "IndexRun_serverId_startedAt_idx" ON "IndexRun"("serverId", "startedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
