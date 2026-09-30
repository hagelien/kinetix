ALTER TABLE "users" ADD COLUMN "display_name" varchar(100);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "preferred_concentration_unit" varchar(20) DEFAULT 'µmol/L' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "notification_settings" jsonb;
