CREATE TABLE "nah_spans" (
	"id" text PRIMARY KEY NOT NULL,
	"trace_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"parent_id" text,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"start_time" integer NOT NULL,
	"end_time" integer,
	"status" text DEFAULT 'unset' NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"error" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cost_usd_micros" integer
);
--> statement-breakpoint
CREATE TABLE "nah_traces" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"run_id" uuid,
	"agent_id" uuid,
	"name" text NOT NULL,
	"start_time" integer NOT NULL,
	"end_time" integer,
	"root_span_id" text NOT NULL,
	"status" text DEFAULT 'unset' NOT NULL,
	"tags" text DEFAULT '[]' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" jsonb,
	"cost_usd_micros" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nah_spans" ADD CONSTRAINT "nah_spans_trace_id_nah_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."nah_traces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nah_traces" ADD CONSTRAINT "nah_traces_run_id_nah_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."nah_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nah_traces" ADD CONSTRAINT "nah_traces_agent_id_nah_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."nah_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spans_trace_idx" ON "nah_spans" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "spans_org_idx" ON "nah_spans" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "traces_org_time_idx" ON "nah_traces" USING btree ("organization_id","start_time");--> statement-breakpoint
CREATE INDEX "traces_run_idx" ON "nah_traces" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "traces_status_idx" ON "nah_traces" USING btree ("status");