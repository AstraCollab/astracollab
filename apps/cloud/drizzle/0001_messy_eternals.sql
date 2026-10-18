CREATE TABLE "nah_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"title" text DEFAULT 'New conversation' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nah_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nah_agents" ADD COLUMN "instructions" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "nah_conversations" ADD CONSTRAINT "nah_conversations_agent_id_nah_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."nah_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nah_messages" ADD CONSTRAINT "nah_messages_conversation_id_nah_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."nah_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nah_messages" ADD CONSTRAINT "nah_messages_run_id_nah_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."nah_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_agent_idx" ON "nah_conversations" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "conversations_org_idx" ON "nah_conversations" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_conv_seq_idx" ON "nah_messages" USING btree ("conversation_id","sequence");--> statement-breakpoint
CREATE INDEX "messages_conv_idx" ON "nah_messages" USING btree ("conversation_id");