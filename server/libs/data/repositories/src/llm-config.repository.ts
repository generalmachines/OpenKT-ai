import type { ActorContext } from "@openkt/core-context";
import type { LlmProvider } from "@openkt/platform-llm";

export type LlmConfigScopeType = "user" | "org" | "project";

export interface LlmConfigUpsertInput {
  scopeType: LlmConfigScopeType;
  scopeId: string;
  provider: LlmProvider;
  label: string;
  baseUrl: string | null;
  model: string | null;
  apiKeyCiphertext: string;
  maskedApiKey: string;
  enabled: boolean;
}

export interface LlmConfigRecord {
  id: string;
  scopeType: LlmConfigScopeType;
  scopeId: string;
  provider: LlmProvider;
  label: string;
  baseUrl: string | null;
  model: string | null;
  enabled: boolean;
  maskedApiKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface LlmConfigSecretRecord extends LlmConfigRecord {
  apiKeyCiphertext: string;
}

export interface LlmConfigRepository {
  list(context: ActorContext, scopeType: LlmConfigScopeType, scopeId: string): Promise<LlmConfigRecord[]>;
  findById(context: ActorContext, id: string): Promise<LlmConfigSecretRecord | null>;
  upsert(context: ActorContext, input: LlmConfigUpsertInput): Promise<LlmConfigRecord>;
  setEnabled(context: ActorContext, id: string, enabled: boolean): Promise<LlmConfigRecord | null>;
}
