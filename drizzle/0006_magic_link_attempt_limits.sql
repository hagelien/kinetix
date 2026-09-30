ALTER TABLE "users"
ADD COLUMN "magic_link_failed_attempts" INTEGER DEFAULT 0 NOT NULL;
