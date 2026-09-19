CREATE EXTENSION IF NOT EXISTS "uuid-ossp";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pg_trgm";--> statement-breakpoint
CREATE TYPE "public"."memory_kind" AS ENUM('decision', 'pattern', 'incident', 'skill', 'context', 'anti-pattern', 'debug-recipe', 'environment', 'note', 'fact', 'other');--> statement-breakpoint
CREATE TYPE "public"."memory_visibility" AS ENUM('personal', 'project', 'org');--> statement-breakpoint
CREATE TYPE "public"."project_visibility" AS ENUM('personal', 'org', 'public');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"password_hash" text,
	"display_name" text,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sign_in_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"email" text,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_members" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"invited_by" uuid,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_members_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"plan" text DEFAULT 'free',
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orgs_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"org_id" uuid,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"visibility" "project_visibility" DEFAULT 'org' NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_org_slug_unique" UNIQUE("org_id","slug")
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"org_id" uuid,
	"project_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"content" text NOT NULL,
	"kind" "memory_kind" NOT NULL,
	"category" varchar(64),
	"visibility" "memory_visibility" NOT NULL,
	"confidence" real NOT NULL,
	"importance" real DEFAULT 0.5 NOT NULL,
	"decay_lambda" real DEFAULT 0.01 NOT NULL,
	"importance_at" timestamp with time zone DEFAULT now() NOT NULL,
	"access_count" integer DEFAULT 0 NOT NULL,
	"last_accessed_at" timestamp with time zone,
	"source_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"superseded_by" uuid,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recall_count" integer DEFAULT 0 NOT NULL,
	"last_recall_at" timestamp with time zone,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"tier" text,
	"sub_points" text[] DEFAULT '{}'::text[] NOT NULL,
	"contributors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scores" jsonb,
	"rolls_up_memory_count" integer DEFAULT 1 NOT NULL,
	"confidence_history" integer[] DEFAULT '{}'::integer[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_accesses" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"memory_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"surface" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_tags" (
	"memory_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_tags_memory_id_tag_id_pk" PRIMARY KEY("memory_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"org_id" uuid,
	"owner_user_id" uuid,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"use_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_briefings" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"project_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"generated_by" uuid,
	"briefing_md" text NOT NULL,
	"model" text NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"source_memory_count_at_generation" integer NOT NULL,
	"source_memory_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_pulse_events" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"project_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor" text NOT NULL,
	"actor_role" text NOT NULL,
	"verb" text NOT NULL,
	"target" text NOT NULL,
	"target_ref" text,
	"body" text,
	"badges" text[] DEFAULT '{}'::text[] NOT NULL,
	"related_insight_id" uuid,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_code_graphs" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"graph_json" jsonb NOT NULL,
	"node_count" integer DEFAULT 0 NOT NULL,
	"edge_count" integer DEFAULT 0 NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"indexed_by" uuid,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"share_token" text,
	"shared_at" timestamp with time zone
);
