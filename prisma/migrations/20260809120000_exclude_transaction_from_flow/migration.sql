-- Per-transaction "not cash-flow" override.
--
-- Additive with a false default, so every existing row keeps behaving exactly as
-- it does today and the flag only ever does something once someone sets it.

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "excludedFromFlow" BOOLEAN NOT NULL DEFAULT false;
