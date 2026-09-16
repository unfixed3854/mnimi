CREATE TABLE `creation_image_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`creation_id` text,
	`note_id` text,
	`prompt` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`draft_image_id` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`creation_id`) REFERENCES `drafts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "creation_image_attempt_owner_check" CHECK(("creation_image_attempts"."creation_id" is not null and "creation_image_attempts"."note_id" is null) or ("creation_image_attempts"."creation_id" is null and "creation_image_attempts"."note_id" is not null))
);
--> statement-breakpoint
CREATE INDEX `creation_image_attempt_status_idx` ON `creation_image_attempts` (`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `creation_image_attempt_user_idx` ON `creation_image_attempts` (`user_id`);--> statement-breakpoint
CREATE INDEX `creation_image_attempt_lease_idx` ON `creation_image_attempts` (`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `creation_save_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`creation_id` text NOT NULL,
	`save_request_id` text NOT NULL,
	`note_id` text NOT NULL,
	`deck_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deck_id`) REFERENCES `decks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `creation_save_receipt_creation_unique` ON `creation_save_receipts` (`user_id`,`creation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `creation_save_receipt_request_unique` ON `creation_save_receipts` (`user_id`,`save_request_id`);--> statement-breakpoint
CREATE TABLE `push_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`platform` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_installations_token_unique` ON `push_installations` (`token`);--> statement-breakpoint
CREATE INDEX `push_installations_user_idx` ON `push_installations` (`user_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`client_request_id` text NOT NULL,
	`deck_id` text,
	`target_deck_id` text,
	`source_text` text NOT NULL,
	`learning_goal` text,
	`routing` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`operation` text DEFAULT 'generate',
	`active_attempt_id` text,
	`classification` text,
	`attempt_cards` text NOT NULL,
	`cards` text NOT NULL,
	`undo_cards` text,
	`revision` integer DEFAULT 0 NOT NULL,
	`target_learning_goal` text,
	`adjustment_instruction` text,
	`queued_at` integer NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`image_attempt_id` text,
	`image_prompt` text,
	`image_status` text NOT NULL,
	`draft_image_id` text,
	`error_category` text,
	`error_stage` text,
	`error` text,
	`removed_at` integer,
	`undo_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deck_id`) REFERENCES `decks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`target_deck_id`) REFERENCES `decks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_drafts`(
	"id", "user_id", "client_request_id", "deck_id", "target_deck_id",
	"source_text", "learning_goal", "routing", "status", "operation",
	"active_attempt_id", "classification", "attempt_cards", "cards",
	"undo_cards", "revision", "target_learning_goal",
	"adjustment_instruction", "queued_at", "lease_owner",
	"lease_expires_at", "image_attempt_id", "image_prompt", "image_status",
	"draft_image_id", "error_category", "error_stage", "error",
	"removed_at", "undo_until", "created_at", "updated_at"
) SELECT
	"id",
	"user_id",
	'legacy:' || "id",
	"deck_id",
	NULL,
	"source_text",
	"source_text",
	NULL,
	CASE WHEN "status" = 'generating' THEN 'queued' ELSE "status" END,
	CASE WHEN "status" = 'generating' THEN 'generate' ELSE NULL END,
	NULL,
	"classification",
	'[]',
	"cards",
	NULL,
	0,
	NULL,
	NULL,
	"created_at",
	NULL,
	NULL,
	NULL,
	"image_prompt",
	"image_status",
	"draft_image_id",
	CASE WHEN "status" = 'failed' THEN 'generation_failed' ELSE NULL END,
	CASE WHEN "status" = 'failed' THEN 'cards' ELSE NULL END,
	"error",
	NULL,
	NULL,
	"created_at",
	"created_at"
FROM `drafts`;--> statement-breakpoint
DROP TABLE `drafts`;--> statement-breakpoint
ALTER TABLE `__new_drafts` RENAME TO `drafts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `drafts_user_client_request_unique` ON `drafts` (`user_id`,`client_request_id`);--> statement-breakpoint
CREATE INDEX `drafts_user_status_queue_idx` ON `drafts` (`user_id`,`status`,`queued_at`,`id`);--> statement-breakpoint
CREATE INDEX `drafts_lease_idx` ON `drafts` (`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `drafts_deck_id_idx` ON `drafts` (`deck_id`);--> statement-breakpoint
CREATE INDEX `drafts_target_deck_id_idx` ON `drafts` (`target_deck_id`);
