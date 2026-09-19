import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// llm_calls — every outbound LLM call (server + worker) gets one row.
//
// The middleware that wraps LlmGatewayService inserts rows here on both
// success and failure paths. Token counts are denormalized from the
// provider response; cost_usd is computed against a static price table
// so dashboards can rollup without rehydrating provider bodies.
export const llmCalls = pgTable(
  "llm_calls",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuid_generate_v4()`),
    projectId: uuid("project_id"),
    userId: uuid("user_id"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    stage: text("stage").notNull(),
    purpose: text("purpose"),
    memoryId: uuid("memory_id"),
    episodeId: uuid("episode_id"),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    // totalTokens is a Postgres generated column (prompt + completion).
    // Drizzle's `integer().generatedAlwaysAs(...)` is not portable across
    // older drizzle-kit; treat it as read-only by typing it as integer
    // and not setting it on insert. The migration owns the GENERATED
    // ALWAYS AS clause.
    totalTokens: integer("total_tokens"),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
    latencyMs: integer("latency_ms").notNull().default(0),
    status: text("status").notNull(),
    errorReason: text("error_reason"),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Migration 0025 — full I/O capture for the trace endpoint.
    // promptMessages is jsonb[] (an array of {role, content}) with each
    // content truncated to 8KB by the recorder before insert.
    // responseText is the raw text the provider returned (chat
    // completions: choices[0].message.content). responseMetadata holds
    // the provider response's usage/finish_reason/model/id object.
    // `truncated` flips true when at least one prompt message was
    // shortened to fit the 8KB cap.
    promptMessages: jsonb("prompt_messages"),
    responseText: text("response_text"),
    responseMetadata: jsonb("response_metadata"),
    truncated: boolean("truncated").notNull().default(false),
  },
  (t) => ({
    projectCreatedIdx: index("llm_calls_project_created_idx").on(t.projectId, t.createdAt),
    userCreatedIdx: index("llm_calls_user_created_idx").on(t.userId, t.createdAt),
    providerCreatedIdx: index("llm_calls_provider_created_idx").on(t.provider, t.createdAt),
    stageCreatedIdx: index("llm_calls_stage_created_idx").on(t.stage, t.createdAt),
    memoryIdIdx: index("llm_calls_memory_id_idx").on(t.memoryId, t.createdAt),
  }),
);

// user_quotas — usage windows per (user, provider, period_kind).
// commitUsage() upserts the matching window; checkAndReserve() reads it.
export const userQuotas = pgTable(
  "user_quotas",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuid_generate_v4()`),
    userId: uuid("user_id").notNull(),
    provider: text("provider").notNull(),
    periodKind: text("period_kind").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    tokensUsed: bigint("tokens_used", { mode: "number" }).notNull().default(0),
    tokensLimit: bigint("tokens_limit", { mode: "number" }).notNull(),
    costUsdUsed: numeric("cost_usd_used", { precision: 10, scale: 4 }).notNull().default("0"),
    costUsdLimit: numeric("cost_usd_limit", { precision: 10, scale: 4 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    periodUnique: unique("user_quotas_period_unique").on(
      t.userId,
      t.provider,
      t.periodKind,
      t.periodStart,
    ),
  }),
);

export type LlmCall = typeof llmCalls.$inferSelect;
export type NewLlmCall = typeof llmCalls.$inferInsert;
export type UserQuota = typeof userQuotas.$inferSelect;
export type NewUserQuota = typeof userQuotas.$inferInsert;
