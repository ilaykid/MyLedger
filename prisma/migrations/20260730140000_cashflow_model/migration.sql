-- Cash-flow model: salary-anchored cycles, fixed/variable classification,
-- credit-card billing days and auto-detected recurring charges.
--
-- Hand-written (rather than generated) so that the existing Category rows are
-- PRESERVED: excludeFromTotals is converted into the new `kind` field instead of
-- being dropped with its data.

-- AlterTable
ALTER TABLE "Account" ADD COLUMN "billingDay" INTEGER;

-- CreateTable
CREATE TABLE "Settings" (
    "id" INTEGER NOT NULL PRIMARY KEY DEFAULT 1,
    "cycleAnchorDay" INTEGER NOT NULL DEFAULT 1,
    "forecastLookbackCycles" INTEGER NOT NULL DEFAULT 3,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables (Category: excludeFromTotals -> kind, data carried over)
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Category" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "icon" TEXT,
    "monthlyBudget" INTEGER,
    "kind" TEXT NOT NULL DEFAULT 'variable',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Category" ("color", "createdAt", "icon", "id", "monthlyBudget", "name", "kind")
SELECT "color", "createdAt", "icon", "id", "monthlyBudget", "name",
    CASE WHEN "excludeFromTotals" THEN 'transfer' ELSE 'variable' END
FROM "Category";
DROP TABLE "Category";
ALTER TABLE "new_Category" RENAME TO "Category";
CREATE UNIQUE INDEX "Category_name_key" ON "Category"("name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateTable
CREATE TABLE "RecurringExpense" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "signature" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'expense',
    "expectedAmount" INTEGER NOT NULL,
    "expectedDay" INTEGER NOT NULL,
    "occurrences" INTEGER NOT NULL,
    "amountSpread" INTEGER NOT NULL DEFAULT 0,
    "lastSeen" DATETIME NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'monthly',
    "accountId" TEXT,
    "categoryId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "detectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecurringExpense_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "RecurringExpense_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "RecurringExpense_signature_key" ON "RecurringExpense"("signature");

-- CreateIndex
CREATE INDEX "RecurringExpense_active_idx" ON "RecurringExpense"("active");
