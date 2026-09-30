-- How much detail notifications may contain. Additive; existing installs keep
-- the current behaviour ("full").

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN "notificationDetail" TEXT NOT NULL DEFAULT 'full';
