ALTER TABLE `user` ADD `tts_autoplay` integer DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE `cards` ADD `audio_path` text;
--> statement-breakpoint
ALTER TABLE `cards` ADD `audio_status` text;
