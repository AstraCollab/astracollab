ALTER TABLE "nah_runs" ADD COLUMN "runner_key_id" text;--> statement-breakpoint
ALTER TABLE "nah_runs" ADD COLUMN "command_id" integer;--> statement-breakpoint
ALTER TABLE "nah_runs" ADD COLUMN "stdout_offset" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "default_repository" text;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_run_unique_idx" ON "nah_usage" USING btree ("run_id") WHERE "nah_usage"."run_id" is not null;