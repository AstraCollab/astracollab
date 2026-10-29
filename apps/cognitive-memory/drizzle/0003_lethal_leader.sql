ALTER TABLE `domain_outcomes` ADD `project_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE `domain_outcomes` ADD `agent_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE INDEX `domain_outcomes_organization_project_idx` ON `domain_outcomes` (`organization_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `domain_outcomes_organization_project_agent_idx` ON `domain_outcomes` (`organization_id`,`project_id`,`agent_id`);--> statement-breakpoint
ALTER TABLE `injection_logs` ADD `project_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE `injection_logs` ADD `agent_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE INDEX `injection_logs_organization_project_idx` ON `injection_logs` (`organization_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `injection_logs_organization_project_agent_idx` ON `injection_logs` (`organization_id`,`project_id`,`agent_id`);--> statement-breakpoint
ALTER TABLE `memories` ADD `project_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE `memories` ADD `agent_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE `memories` ADD `agent_type` text;--> statement-breakpoint
CREATE INDEX `memories_organization_project_idx` ON `memories` (`organization_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `memories_organization_project_agent_idx` ON `memories` (`organization_id`,`project_id`,`agent_id`);--> statement-breakpoint
CREATE INDEX `memories_organization_agent_type_idx` ON `memories` (`organization_id`,`agent_type`);--> statement-breakpoint
ALTER TABLE `tensions` ADD `project_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE `tensions` ADD `agent_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE INDEX `tensions_organization_project_idx` ON `tensions` (`organization_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `tensions_organization_project_agent_idx` ON `tensions` (`organization_id`,`project_id`,`agent_id`);--> statement-breakpoint
ALTER TABLE `usage_events` ADD `project_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `agent_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE INDEX `usage_events_organization_project_idx` ON `usage_events` (`organization_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `usage_events_organization_project_agent_idx` ON `usage_events` (`organization_id`,`project_id`,`agent_id`);