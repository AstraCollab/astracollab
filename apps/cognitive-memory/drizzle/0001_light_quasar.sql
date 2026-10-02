CREATE TABLE `domain_outcomes` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`domain` text NOT NULL,
	`success` integer NOT NULL,
	`failure_pattern` text,
	`strategy` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `domain_outcomes_organization_idx` ON `domain_outcomes` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `domain_outcomes_domain_idx` ON `domain_outcomes` (`organization_id`,`domain`);--> statement-breakpoint
CREATE TABLE `injection_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`api_key_id` text,
	`tokens` integer DEFAULT 0 NOT NULL,
	`truncated` integer DEFAULT false NOT NULL,
	`index_lines` integer DEFAULT 0 NOT NULL,
	`bodies` integer DEFAULT 0 NOT NULL,
	`identifiers` text DEFAULT '[]' NOT NULL,
	`reasons` text DEFAULT '{}' NOT NULL,
	`entries` text DEFAULT '[]' NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `injection_logs_organization_idx` ON `injection_logs` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `organization_settings` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`max_total_tokens` integer,
	`max_index_items` integer,
	`default_recall_limit` integer,
	`retention_days` integer DEFAULT 90 NOT NULL,
	`extraction` text DEFAULT 'auto' NOT NULL
);
