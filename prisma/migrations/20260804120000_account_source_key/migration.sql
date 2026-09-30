DROP INDEX IF EXISTS "Account_institution_lastFour_key";
ALTER TABLE "Account" ADD COLUMN "sourceKey" TEXT;
ALTER TABLE "Account" ADD COLUMN "dedupIdentity" TEXT;
UPDATE "Account" SET "dedupIdentity" = "lastFour";
CREATE UNIQUE INDEX "Account_sourceKey_key" ON "Account"("sourceKey");
CREATE INDEX "Account_institution_lastFour_idx" ON "Account"("institution", "lastFour");
