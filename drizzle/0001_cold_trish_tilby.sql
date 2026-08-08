CREATE TABLE `ai_point_charges` (
	`request_id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`action` text NOT NULL,
	`reserved_cost` integer NOT NULL,
	`actual_cost` integer,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ai_point_charges_member_index` ON `ai_point_charges` (`member_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `point_ledger_task_id_unique` ON `point_ledger` (`task_id`) WHERE `task_id` IS NOT NULL;
