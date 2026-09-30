CREATE TABLE "SyncRun" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "company" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "trigger" TEXT NOT NULL,
  "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" DATETIME,
  "inserted" INTEGER NOT NULL DEFAULT 0,
  "updated" INTEGER NOT NULL DEFAULT 0,
  "skipped" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT
);
CREATE INDEX "SyncRun_company_startedAt_idx" ON "SyncRun"("company", "startedAt");
CREATE INDEX "SyncRun_status_startedAt_idx" ON "SyncRun"("status", "startedAt");
