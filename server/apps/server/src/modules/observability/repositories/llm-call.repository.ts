import { Inject, Injectable, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";

import {
  type LlmCallContext,
  type LlmCallRecorder,
  type LlmCallRecordInput,
  type LlmMessage,
  getLlmCallContext,
} from "@openkt/platform-llm";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";

// Centralized writer for the llm_calls audit ledger.
//
// The recorder implements the LlmCallRecorder contract from the LLM
// gateway lib and pulls stage/purpose/etc. out of AsyncLocalStorage so
// the lib itself stays NestJS-agnostic and worker-compatible.
//
// Migration 0025 added prompt_messages / response_text /
// response_metadata / truncated. The repository truncates each prompt
// message's content to 8KB before insert — the spec mandates a bounded
// audit trail, not a full prompt log.

@Injectable()
export class LlmCallRepository implements LlmCallRecorder {
  private readonly logger = new Logger(LlmCallRepository.name);

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async record(input: LlmCallRecordInput): Promise<void> {
    const ctx = getLlmCallContext();
    try {
      await this.insert(input, ctx);
    } catch (err) {
      // observability writes must never poison the call path
      this.logger.warn(
        `llm_calls insert failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async insert(
    input: LlmCallRecordInput,
    ctx?: LlmCallContext,
  ): Promise<void> {
    const stage = ctx?.stage ?? "manual";
    const capture = isIoCaptureEnabled();
    const truncation = capture
      ? truncatePromptMessages(input.promptMessages)
      : { messages: null, truncated: false };
    const responseText = capture
      ? truncateString(input.responseText ?? null, RESPONSE_TEXT_LIMIT_BYTES)
      : null;
    const responseMetadata = capture ? (input.responseMetadata ?? null) : null;
    const promptMessagesJson = truncation.messages
      ? JSON.stringify(truncation.messages)
      : null;
    const responseMetadataJson = responseMetadata
      ? JSON.stringify(responseMetadata)
      : null;
    await this.db.execute(sql`
      insert into llm_calls (
        project_id, user_id, provider, model, stage, purpose,
        memory_id, episode_id, prompt_tokens, completion_tokens,
        cost_usd, latency_ms, status, error_reason, request_id,
        prompt_messages, response_text, response_metadata, truncated
      ) values (
        ${ctx?.projectId ?? null}::uuid,
        ${ctx?.userId ?? null}::uuid,
        ${input.provider},
        ${input.model},
        ${stage},
        ${ctx?.purpose ?? null},
        ${ctx?.memoryId ?? null}::uuid,
        ${ctx?.episodeId ?? null}::uuid,
        ${input.promptTokens},
        ${input.completionTokens},
        ${input.costUsd.toString()}::numeric,
        ${input.latencyMs},
        ${input.status},
        ${input.errorReason ?? null},
        ${ctx?.requestId ?? null},
        ${promptMessagesJson}::jsonb,
        ${responseText},
        ${responseMetadataJson}::jsonb,
        ${truncation.truncated}
      )
    `);
  }
}

// 8KB per-message cap — keep in sync with the worker recorder. Both
// recorders implement the same contract so a query against llm_calls
// has consistent shape regardless of which side made the call.
const PROMPT_MESSAGE_LIMIT_BYTES = 8 * 1024;
const RESPONSE_TEXT_LIMIT_BYTES = 64 * 1024;

function isIoCaptureEnabled(): boolean {
  const raw = process.env.OPENKT_LLM_IO_CAPTURE;
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  return true;
}

export function truncatePromptMessages(messages: LlmMessage[] | undefined): {
  messages: LlmMessage[] | null;
  truncated: boolean;
} {
  if (!messages || messages.length === 0) {
    return { messages: null, truncated: false };
  }
  let truncated = false;
  const out: LlmMessage[] = messages.map((m) => {
    const content = m.content ?? "";
    const limited = truncateString(content, PROMPT_MESSAGE_LIMIT_BYTES);
    if (limited !== null && limited.length < content.length) {
      truncated = true;
    }
    return { role: m.role, content: limited ?? "" };
  });
  return { messages: out, truncated };
}

export function truncateString(
  value: string | null,
  maxBytes: number,
): string | null {
  if (value === null || value === undefined) return null;
  if (value.length <= maxBytes) return value;
  return `${value.slice(0, maxBytes)}…[truncated]`;
}
