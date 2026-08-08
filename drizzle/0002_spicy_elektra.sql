CREATE TABLE `member_asset_items` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`project_name` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`object_key` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`source_task_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
