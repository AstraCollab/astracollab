CREATE TABLE "nah_github_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"github_installation_id" text NOT NULL,
	"github_account_id" text NOT NULL,
	"access_token_enc" text NOT NULL,
	"refresh_token_enc" text,
	"token_expires_at" timestamp with time zone,
	"selected_repositories" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "nah_github_connections_github_installation_id_unique" UNIQUE("github_installation_id")
);
--> statement-breakpoint
DROP INDEX "usage_run_unique_idx";--> statement-breakpoint
CREATE INDEX "github_connections_org_idx" ON "nah_github_connections" USING btree ("organization_id");