-- Drops Transaction.excludedFromFlow, added earlier today.
--
-- It solved a real problem - a transaction can belong to a category AND not
-- belong in the cash flow - but it did so with a second mechanism alongside the
-- `excluded` category kind, and two ways to express one idea is how a simple
-- tool stops being simple. The category is the one you already look at, so the
-- category wins and the flag goes.
--
-- Safe: only two rows ever carried it, both set during testing and both cleared.
-- SQLite needs a table rebuild to drop a column; PRAGMA foreign_keys is off
-- inside a migration transaction, so the rewrite below is the standard dance.
CREATE TABLE "Transaction_new" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "processedDate" DATETIME,
    "descriptionRaw" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "memo" TEXT,
    "note" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "originalAmount" INTEGER,
    "originalCurrency" TEXT,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "installmentNumber" INTEGER,
    "installmentTotal" INTEGER,
    "categoryId" TEXT,
    "categoryLocked" BOOLEAN NOT NULL DEFAULT false,
    "providerIdentifier" TEXT,
    "dedupHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Transaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Transaction_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "Transaction_new" (
    "id","accountId","date","processedDate","descriptionRaw","description","memo","note",
    "amount","currency","originalAmount","originalCurrency","status","installmentNumber",
    "installmentTotal","categoryId","categoryLocked","providerIdentifier","dedupHash",
    "createdAt","updatedAt"
) SELECT
    "id","accountId","date","processedDate","descriptionRaw","description","memo","note",
    "amount","currency","originalAmount","originalCurrency","status","installmentNumber",
    "installmentTotal","categoryId","categoryLocked","providerIdentifier","dedupHash",
    "createdAt","updatedAt"
FROM "Transaction";

DROP TABLE "Transaction";
ALTER TABLE "Transaction_new" RENAME TO "Transaction";

CREATE UNIQUE INDEX "Transaction_dedupHash_key" ON "Transaction"("dedupHash");
CREATE INDEX "Transaction_accountId_date_idx" ON "Transaction"("accountId", "date");
CREATE INDEX "Transaction_categoryId_idx" ON "Transaction"("categoryId");
CREATE INDEX "Transaction_status_idx" ON "Transaction"("status");
