import { sql } from "drizzle-orm";
import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Runtime LLM provider configuration. API keys are intentionally stored
// separately from generic settings so reads can be masked and audited.
// The local dev adapter treats api_key_ciphertext as opaque ciphertext;
// production should back this with KMS/AWS Secrets Manager.
export const llmProviderConfigs = pgTable("llm_provider_configs", {
  id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
  scopeType: text("scope_type").notNull(), // user | org | project
  scopeId: uuid("scope_id").notNull(),
  provider: text("provider").notNull(), // minimax | openai | openrouter | custom
  label: text("label").notNull().default("default"),
  baseUrl: text("base_url"),
  model: text("model"),
  apiKeyCiphertext: text("api_key_ciphertext").notNull(),
  maskedApiKey: text("masked_api_key").notNull().default("****"),
  enabled: boolean("enabled").notNull().default(true),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type LlmProviderConfigRow = typeof llmProviderConfigs.$inferSelect;
export type NewLlmProviderConfig = typeof llmProviderConfigs.$inferInsert;
