import { Inject, Injectable } from "@nestjs/common";

import type { ActorContext } from "@openkt/core-context";
import {
  LLM_CONFIG_REPOSITORY,
  type LlmConfigRepository,
  type LlmConfigScopeType,
} from "@openkt/data-repositories";
import { NotFoundDomainError, ValidationDomainError } from "@openkt/core-errors";
import { requireOrgAccess, requireProjectAccess } from "@openkt/auth-authorization";
import {
  LlmGatewayService,
  LlmKeyCipher,
  type LlmProvider,
} from "@openkt/platform-llm";

import { AuditService } from "../../audit/services/audit.service";

export interface UpsertLlmConfigInput {
  scopeType: LlmConfigScopeType;
  scopeId: string;
  provider: LlmProvider;
  label: string;
  baseUrl: string | null;
  model: string | null;
  apiKey: string;
  enabled: boolean;
}

@Injectable()
export class LlmConfigsApplicationService {
  constructor(
    @Inject(LLM_CONFIG_REPOSITORY)
    private readonly llmConfigRepository: LlmConfigRepository,
    private readonly llmGatewayService: LlmGatewayService,
    private readonly auditService: AuditService,
  ) {}

  async list(context: ActorContext, scopeType: LlmConfigScopeType, scopeId: string) {
    await this.requireScopeAccess(context, scopeType, scopeId, "read");
    return this.llmConfigRepository.list(context, scopeType, scopeId);
  }

  async upsert(context: ActorContext, input: UpsertLlmConfigInput) {
    await this.requireScopeAccess(context, input.scopeType, input.scopeId, "admin");
    this.validateProviderInput(input.provider, input.baseUrl, input.model);

    const created = await this.llmConfigRepository.upsert(context, {
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      provider: input.provider,
      label: input.label,
      baseUrl: input.baseUrl,
      model: input.model,
      apiKeyCiphertext: LlmKeyCipher.encrypt(input.apiKey),
      maskedApiKey: LlmKeyCipher.mask(input.apiKey),
      enabled: input.enabled,
    });

    // org-scoped configs surface in the org audit trail; user-scoped
    // ones are stored without an orgId. We never log the plaintext key.
    await this.auditService.writeFromContext(context, {
      actorKind: "user",
      orgId: input.scopeType === "org" ? input.scopeId : null,
      action: "llm_config.created",
      resourceType: "llm_config",
      resourceId: (created as { id?: string } | undefined)?.id ?? null,
      after: {
        scope_type: input.scopeType,
        scope_id: input.scopeId,
        provider: input.provider,
        label: input.label,
        base_url: input.baseUrl,
        model: input.model,
        enabled: input.enabled,
      },
    });

    return created;
  }

  async setEnabled(context: ActorContext, id: string, enabled: boolean) {
    const existing = await this.llmConfigRepository.findById(context, id);
    if (!existing) {
      throw new NotFoundDomainError("llm_config");
    }
    await this.requireScopeAccess(context, existing.scopeType, existing.scopeId, "admin");

    const updated = await this.llmConfigRepository.setEnabled(context, id, enabled);
    if (!updated) {
      throw new NotFoundDomainError("llm_config");
    }
    return updated;
  }

  async test(context: ActorContext, id: string) {
    const existing = await this.llmConfigRepository.findById(context, id);
    if (!existing) {
      throw new NotFoundDomainError("llm_config");
    }
    await this.requireScopeAccess(context, existing.scopeType, existing.scopeId, "read");

    const response = await this.llmGatewayService.tryGenerateText({
      providerConfig: {
        provider: existing.provider,
        apiKey: LlmKeyCipher.decrypt(existing.apiKeyCiphertext),
        baseUrl: existing.baseUrl,
        model: existing.model,
      },
      messages: [
        {
          role: "user",
          content: "Reply with exactly: ok",
        },
      ],
      maxOutputTokens: 8,
      timeoutMs: 20_000,
    });

    return {
      ok: Boolean(response?.text),
      provider: response?.provider ?? existing.provider,
      model: response?.model ?? existing.model,
    };
  }

  private validateProviderInput(
    provider: LlmProvider,
    baseUrl: string | null,
    model: string | null,
  ): void {
    if (provider === "custom" && (!baseUrl || !model)) {
      throw new ValidationDomainError("custom provider requires base_url and model");
    }
  }

  private async requireScopeAccess(
    context: ActorContext,
    scopeType: LlmConfigScopeType,
    scopeId: string,
    access: "read" | "admin",
  ): Promise<void> {
    if (scopeType === "user") {
      if (context.principal.userId !== scopeId) {
        throw new ValidationDomainError("cannot access another user's LLM config");
      }
      return;
    }
    if (scopeType === "project") {
      await requireProjectAccess(context, scopeId, access);
      return;
    }
    await requireOrgAccess(context, scopeId, access);
  }
}
