-- The personal space is ONE marked project per person, never "some org-less
-- space you own". Before this, a person who owned more than one org-less space
-- (a team space made with POST /v1/projects defaults to visibility
-- `personal`) could get a TEAM space back as their personal one, and every
-- save or session with no project filed "personal" notes where teammates
-- recall them (QA S0, PR #94).
--
-- Backfill: the space sign-up creates is org-less, visibility `personal`,
-- slug `personal`; per owner the oldest such project is the personal one. A
-- person with none gets a fresh one on first use (ProjectScopeService).
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "is_personal" boolean NOT NULL DEFAULT false;--> statement-breakpoint

UPDATE "projects" p
   SET "is_personal" = true
  FROM (
    SELECT DISTINCT ON ("owner_user_id") "id"
      FROM "projects"
     WHERE "org_id" IS NULL AND "visibility" = 'personal' AND "slug" = 'personal'
     ORDER BY "owner_user_id", "created_at" ASC, "id" ASC
  ) pick
 WHERE p."id" = pick."id"
   AND NOT EXISTS (
     SELECT 1 FROM "projects" q WHERE q."owner_user_id" = p."owner_user_id" AND q."is_personal"
   );--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "projects_one_personal_per_owner"
  ON "projects" ("owner_user_id") WHERE "is_personal";
