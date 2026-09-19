import { Injectable, Logger } from "@nestjs/common";

import {
  getLlmCallContext,
  type LlmCallContext,
  type LlmCallRecorder,
  type LlmCallRecordInput,
  type LlmMessage,
} from "@openkt/platform-llm";

import { WorkerPgService } from "../../database/worker-pg.service";

/**
 * Worker-side recorder for the LLM gateway. The server has a richer
 * Drizzle-based implementation in `apps/server/.../observability/`,
 * but the worker can't pull that in without dragging the whole
 * server module graph along. This recorder writes the same `llm_calls`
 * row shape via the worker's plain pg pool so every gateway call
 * inside the worker (triage / synthesize / episode / member_knowledge /
 * briefing) lands in observability.
 *
 * Failure mode is "swallow + warn" — observability MUST NOT propagate
 * a write error into the LLM call path. The gateway itself already
 * has the same swallow-on-error wrapper, but we duplicate the safety
 * here so a bad SQL still leaves us with a warning in the logs.
 *
 * Migration 0025 added prompt_messages / response_text /
 * response_metadata / truncated for the trace UI. We truncate each
 * prompt message's content to 8KB before insert — full LLM prompts
 * can be massive (e.g. the synthesize stage stuffs N candidate
 * memories into the prompt body) and storing the raw text would
 * bloat llm_calls without giving the dashboard anything actionable.
 */
@Injectable()
export class WorkerLlmCallRecorder implements LlmCallRecorder {
  private readonly logger = new Logger(WorkerLlmCallRecorder.name);

  constructor(private readonly db: WorkerPgService) {}

  async record(input: LlmCallRecordInput): Promise<void> {
    const ctx = getLlmCallContext();
    try {
      await this.insert(input, ctx);
    } catch (err) {
      this.logger.warn(
        `[llm_calls] worker insert failed provider=${input.provider} status=${
          input.status
        } err=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async insert(
    input: LlmCallRecordInput,
    ctx?: LlmCallContext,
  ): Promise<void> {
    const stage = ctx?.stage ?? "manual";
    const capture = isIoCaptureEnabled();
    const truncationResult = capture
      ? truncatePromptMessages(input.promptMessages)
      : { messages: null, truncated: false };
    const responseText = capture
      ? truncateString(input.responseText ?? null, RESPONSE_TEXT_LIMIT_BYTES)
      : null;
    const responseMetadata = capture ? (input.responseMetadata ?? null) : null;
    await this.db.query(
      `insert into llm_calls (
         project_id, user_id, provider, model, stage, purpose,
         memory_id, episode_id, prompt_tokens, completion_tokens,
         cost_usd, latency_ms, status, error_reason, request_id,
         prompt_messages, response_text, response_metadata, truncated
       ) values (
         $1::uuid, $2::uuid, $3, $4, $5, $6,
         $7::uuid, $8::uuid, $9, $10,
         $11::numeric, $12, $13, $14, $15,
         $16::jsonb, $17, $18::jsonb, $19
       )`,
      [
        ctx?.projectId ?? null,
        ctx?.userId ?? null,
        input.provider,
        input.model,
        stage,
        ctx?.purpose ?? null,
        ctx?.memoryId ?? null,
        ctx?.episodeId ?? null,
        input.promptTokens,
        input.completionTokens,
        input.costUsd.toString(),
        input.latencyMs,
        input.status,
        input.errorReason ?? null,
        ctx?.requestId ?? null,
        truncationResult.messages
          ? JSON.stringify(truncationResult.messages)
          : null,
        responseText,
        responseMetadata ? JSON.stringify(responseMetadata) : null,
        truncationResult.truncated,
      ],
    );
  }
}

// 8KB per-message cap — large enough to capture the system prompt +
// a realistic untrusted-content block while keeping llm_calls writes
// bounded. The spec calls out 8KB explicitly so the prompt/response
// columns stay useful for audit without becoming an "everything log".
const PROMPT_MESSAGE_LIMIT_BYTES = 8 * 1024;
// Response text is bounded to 64KB. The trace endpoint truncates a
// further 5KB slice for display; we keep more here so admins can pull
// the full body via the llm_calls query API if they need to debug.
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
