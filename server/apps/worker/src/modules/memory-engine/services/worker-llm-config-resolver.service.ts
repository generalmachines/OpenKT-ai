import { Injectable, Logger } from "@nestjs/common";
import { LlmKeyCipher, type LlmProviderConfig, type LlmProvider } from "@openkt/platform-llm";

import type { PipelineCommandMessage } from "../pipeline-message";
import { WorkerPgService } from "../../database/worker-pg.service";

interface LlmProviderConfigRow {
  provider: string;
  base_url: string | null;
  model: string | null;
  api_key_ciphertext: string;
}

@Injectable()
export class WorkerLlmConfigResolverService {
  private readonly logger = new Logger(WorkerLlmConfigResolverService.name);

  constructor(private readonly db: WorkerPgService) {}

  async resolve(message: PipelineCommandMessage): Promise<LlmProviderConfig | null> {
    const scopes: Array<{ scopeType: string; scopeId: string | null }> = [
      { scopeType: "project", scopeId: message.project_id },
      { scopeType: "org", scopeId: message.org_id },
      { scopeType: "user", scopeId: message.user_id },
    ];

    for (const scope of scopes) {
      if (!scope.scopeId) {
        continue;
      }

      const row = await this.db.one<LlmProviderConfigRow>(
        `select provider, base_url, model, api_key_ciphertext
           from llm_provider_configs
          where scope_type = $1
            and scope_id = $2
            and enabled = true
          order by updated_at desc
          limit 1`,
        [scope.scopeType, scope.scopeId],
      );

      if (!row) {
        continue;
      }

      if (!isSupportedProvider(row.provider)) {
        this.logger.warn(
          `[llm.config] unsupported provider=${row.provider} scope=${scope.scopeType}:${scope.scopeId}`,
        );
        continue;
      }

      try {
        return {
          provider: row.provider,
          apiKey: LlmKeyCipher.decrypt(row.api_key_ciphertext),
          baseUrl: row.base_url,
          model: row.model,
        };
      } catch (error) {
        this.logger.warn(
          `[llm.config] decrypt failed scope=${scope.scopeType}:${scope.scopeId} err=${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return null;
  }
}

function isSupportedProvider(value: string): value is LlmProvider {
  return value === "minimax" || value === "openai" || value === "openrouter" || value === "custom";
}
