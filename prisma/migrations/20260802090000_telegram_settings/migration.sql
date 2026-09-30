-- Telegram credentials, stored alongside the other settings.
-- Purely additive: existing rows keep working with both columns NULL.

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN "telegramToken" TEXT;

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN "telegramChatId" TEXT;
