-- AlterTable
ALTER TABLE "IndexedItem" ADD COLUMN "absAddedAt" REAL;
ALTER TABLE "IndexedItem" ADD COLUMN "absMtimeMs" REAL;

-- CreateIndex
CREATE INDEX "IndexedItem_libraryId_absMtimeMs_idx" ON "IndexedItem"("libraryId", "absMtimeMs");

-- CreateIndex
CREATE INDEX "IndexedItem_libraryId_absAddedAt_idx" ON "IndexedItem"("libraryId", "absAddedAt");
