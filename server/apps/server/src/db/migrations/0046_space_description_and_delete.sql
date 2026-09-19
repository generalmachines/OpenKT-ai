-- Spaces get a description, and a space can be deleted by its owner.
--
-- `description`: what the space is for, shown to its members (POST/PATCH
-- /v1/projects). `deleted_at`: DELETE /v1/projects/:id is a soft delete —
-- the row stays (nothing a teammate saved is destroyed), but a deleted space
-- is gone from every read: access checks treat it as not found, its facts
-- are archived and its shares and join links are removed when it is deleted.
-- Additive; existing spaces keep NULL in both.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "description" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
