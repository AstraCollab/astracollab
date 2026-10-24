ALTER TABLE `memories` ADD `library_id` text;--> statement-breakpoint
CREATE INDEX `memories_library_idx` ON `memories` (`organization_id`,`library_id`);