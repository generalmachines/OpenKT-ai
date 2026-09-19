import { pgEnum } from "drizzle-orm/pg-core";

// Mirror the live Postgres enums. Keep ordering aligned so drizzle-kit
// produces no-op migrations on existing databases. New values append.

export const memoryKind = pgEnum("memory_kind", [
  "decision",
  "pattern",
  "incident",
  "skill",
  "context",
  "anti-pattern",
  "debug-recipe",
  "environment",
  "note",
  "fact",
  "other",
]);

export const memoryVisibility = pgEnum("memory_visibility", ["personal", "project", "org"]);

export const projectVisibility = pgEnum("project_visibility", ["personal", "org", "public"]);
