-- Existing users opted into Telegram before the privacy levels existed. Move
-- the unsafe implicit default to totals-only; they can explicitly choose more.
UPDATE "Settings" SET "notificationDetail" = 'minimal' WHERE "notificationDetail" = 'full';
