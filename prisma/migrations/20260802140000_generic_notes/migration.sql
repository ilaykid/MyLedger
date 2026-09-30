-- Generalise MerchantNote into Note, so a note can also cover one instalment
-- purchase (all of its payments) and not just a merchant.
--
-- Existing merchant notes are CARRIED OVER as scope='merchant' rather than
-- dropped, so nothing the user wrote is lost.

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Carry over anything already written
INSERT INTO "Note" ("id", "scope", "key", "displayName", "note", "createdAt", "updatedAt")
SELECT "id", 'merchant', "signature", "displayName", "note", "createdAt", "updatedAt"
FROM "MerchantNote";

-- DropTable
DROP TABLE "MerchantNote";

-- CreateIndex
CREATE UNIQUE INDEX "Note_scope_key_key" ON "Note"("scope", "key");

-- CreateIndex
CREATE INDEX "Note_scope_idx" ON "Note"("scope");
