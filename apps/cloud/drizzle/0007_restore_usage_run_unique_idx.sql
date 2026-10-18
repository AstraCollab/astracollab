-- 0005 dropped usage_run_unique_idx because it was never declared in
-- schema.ts, but meterRun's ON CONFLICT depends on it: without a matching
-- unique constraint every metered run throws instead of deduplicating.
-- The index is now declared in schema.ts so future generates keep it.
DELETE FROM "nah_usage" a
USING "nah_usage" b
WHERE a."run_id" = b."run_id"
  AND a."run_id" IS NOT NULL
  AND a."id" > b."id";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "usage_run_unique_idx" ON "nah_usage" USING btree ("run_id") WHERE "nah_usage"."run_id" is not null;
