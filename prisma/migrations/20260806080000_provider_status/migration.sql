-- Remember the outcome of each provider's last scrape attempt.
-- Purely additive: a new table, no changes to existing rows. Until the next
-- scrape populates it, the health checks fall back to age-based staleness.

-- CreateTable
CREATE TABLE "ProviderStatus" (
    "company" TEXT NOT NULL PRIMARY KEY,
    "lastAttemptAt" DATETIME NOT NULL,
    "lastSuccessAt" DATETIME,
    "lastError" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
