CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`action` text NOT NULL,
	`object_type` text NOT NULL,
	`object_id` text NOT NULL,
	`detail_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_workspace_created` ON `audit_logs` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `import_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`object_type` text NOT NULL,
	`file_name` text NOT NULL,
	`file_key` text NOT NULL,
	`row_count` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_import_jobs_workspace_created` ON `import_jobs` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `import_rows` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`source_row` integer NOT NULL,
	`record_json` text NOT NULL,
	`validation_status` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `import_jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_import_rows_job` ON `import_rows` (`job_id`);