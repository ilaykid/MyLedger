-- Recognise a lump sum across several months in the cash-flow view.
-- Purely additive: a new table with no changes to existing rows, so a database
-- without any spread plans behaves exactly as before.

-- CreateTable
CREATE TABLE "SpreadPlan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "transactionId" TEXT NOT NULL,
    "months" INTEGER NOT NULL,
    "offsetMonths" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SpreadPlan_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "SpreadPlan_transactionId_key" ON "SpreadPlan"("transactionId");
