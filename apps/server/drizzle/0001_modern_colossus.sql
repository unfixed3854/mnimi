CREATE TABLE `drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`deck_id` text NOT NULL,
	`source_text` text NOT NULL,
	`status` text NOT NULL,
	`classification` text,
	`cards` text NOT NULL,
	`image_prompt` text,
	`image_status` text NOT NULL,
	`draft_image_id` text,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deck_id`) REFERENCES `decks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drafts_user_id_unique` ON `drafts` (`user_id`);