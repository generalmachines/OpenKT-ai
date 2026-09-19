import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";

import type { ActorContext } from "@openkt/core-context";
import type {
  LlmConfigRecord,
  LlmConfigRepository,
  LlmConfigScopeType,
  LlmConfigSecretRecord,
  LlmConfigUpsertInput,
} from "@openkt/data-repositories";
import type { LlmProvider } from "@openkt/platform-llm";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { llmProviderConfigs } from "../../../db/schema";

@Injectable()
export class DrizzleLlmConfigRepository implements LlmConfigRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async list(
    _context: ActorContext,
    scopeType: LlmConfigScopeType,
    scopeId: string,
  ): Promise<LlmConfigRecord[]> {
    const rows = await this.db
      .select()
      .from(llmProviderConfigs)
      .where(
        and(
          eq(llmProviderConfigs.scopeType, scopeType),
          eq(llmProviderConfigs.scopeId, scopeId),
        ),
      )
      .orderBy(desc(llmProviderConfigs.updatedAt));
    return rows.map(toRecord);
  }

  async findById(
    _context: ActorContext,
    id: string,
  ): Promise<LlmConfigSecretRecord | null> {
    const row = await this.db.query.llmProviderConfigs.findFirst({
      where: eq(llmProviderConfigs.id, id),
    });
    return row ? { ...toRecord(row), apiKeyCiphertext: row.apiKeyCiphertext } : null;
  }

  async upsert(
    context: ActorContext,
    input: LlmConfigUpsertInput,
  ): Promise<LlmConfigRecord> {
    const [row] = await this.db
      .insert(llmProviderConfigs)
      .values({
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        provider: input.provider,
        label: input.label,
        baseUrl: input.baseUrl,
        model: input.model,
        apiKeyCiphertext: input.apiKeyCiphertext,
        maskedApiKey: input.maskedApiKey,
        enabled: input.enabled,
        createdBy: context.principal.userId,
      })
      .onConflictDoUpdate({
        target: [
          llmProviderConfigs.scopeType,
          llmProviderConfigs.scopeId,
          llmProviderConfigs.label,
        ],
        set: {
          provider: input.provider,
          baseUrl: input.baseUrl,
          model: input.model,
          apiKeyCiphertext: input.apiKeyCiphertext,
          maskedApiKey: input.maskedApiKey,
          enabled: input.enabled,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!row) throw new Error("llm config upsert failed");
    return toRecord(row);
  }

  async setEnabled(
    _context: ActorContext,
    id: string,
    enabled: boolean,
  ): Promise<LlmConfigRecord | null> {
    const [row] = await this.db
      .update(llmProviderConfigs)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(llmProviderConfigs.id, id))
      .returning();
    return row ? toRecord(row) : null;
  }
}

function toRecord(row: typeof llmProviderConfigs.$inferSelect): LlmConfigRecord {
  return {
    id: row.id,
    scopeType: row.scopeType as LlmConfigScopeType,
    scopeId: row.scopeId,
    provider: row.provider as LlmProvider,
    label: row.label,
    baseUrl: row.baseUrl,
    model: row.model,
    enabled: row.enabled,
    maskedApiKey: row.maskedApiKey,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
