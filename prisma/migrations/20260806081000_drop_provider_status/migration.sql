-- Drops ProviderStatus, added minutes earlier in 20260806080000.
--
-- It was redundant: SyncRun already records every scrape attempt with its
-- status and error, so "did this provider fail last night" is answerable from
-- data the runner has always written. Two tables holding the same truth is how
-- they drift apart.
--
-- Safe: the table was never written to.
DROP TABLE IF EXISTS "ProviderStatus";
