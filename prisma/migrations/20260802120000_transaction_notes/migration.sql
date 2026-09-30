-- User notes on transactions.
-- Additive: `note` is nullable and MerchantNote is new, so existing rows are untouched.

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "note" TEXT;

-- CreateTable
CREATE TABLE "MerchantNote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "signature" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "MerchantNote_signature_key" ON "MerchantNote"("signature");
