import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import {
  stageFromJobType,
  type PipelineCommandMessage,
  type PipelineStage,
} from "../pipeline-message";
import { WorkerPgService } from "../../database/worker-pg.service";

interface LedgerRow {
  id: string;
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  attempts: number;
  max_attempts: number;
  started_at: string | null;
}

@Injectable()
export class JobLedgerService {
  private readonly logger = new Logger(JobLedgerService.name);
  private readonly runningStaleMs = 5 * 60_000;

  constructor(
    private readonly db: WorkerPgService,
    private readonly config: ConfigService,
  ) {}

  async begin(
    message: PipelineCommandMessage,
  ): Promise<{
    jobId: string;
    stage: PipelineStage;
    shouldRun: boolean;
    skipReason?: "done" | "in_progress";
  }> {
    const stage = stageFromJobType(message.job_type);
    const jobKey = this.jobKeyFor(message);
    const now = new Date().toISOString();
    const source =
      this.config.get<"rabbitmq" | "sqs">("OPENKT_QUEUE_BACKEND") ??
      "rabbitmq";

    const existing = await this.db.one<LedgerRow>(
      `select id, status, attempts, max_attempts, started_at::text
         from agentic_jobs
        where job_key = $1`,
      [jobKey],
    );

    const memoryId = message.aggregate_type === "memory" ? message.aggregate_id : null;
    const current = existing ?? null;

    if (current?.status === "done") {
      return {
        jobId: current.id,
        stage,
        shouldRun: false,
        skipReason: "done",
      };
    }

    if (
      current?.status === "running" &&
      current.started_at &&
      Date.now() - Date.parse(current.started_at) < this.runningStaleMs
    ) {
      return {
        jobId: current.id,
        stage,
        shouldRun: false,
        skipReason: "in_progress",
      };
    }

    if (current) {
      const nextAttempts = Math.min(current.attempts + 1, current.max_attempts);
      const updated = await this.db.one<{ id: string }>(
        `update agentic_jobs
            set kind = $2,
                stage = $2,
                source = $13,
                status = 'running',
                started_at = $3,
                completed_at = null,
                next_attempt_at = $3,
                error = null,
                last_error_at = null,
                result = null,
                attempts = $4,
                correlation_id = $5,
                causation_id = $6,
                project_id = $7,
                org_id = $8,
                user_id = $9,
                memory_id = $10,
                version_token = $11,
                payload = $12::jsonb
          where id = $1
          returning id`,
        [
          current.id,
          stage,
          now,
          nextAttempts,
          message.correlation_id,
          message.causation_id,
          message.project_id,
          message.org_id,
          message.user_id,
          memoryId,
          message.version_token,
          JSON.stringify(message.payload),
          source,
        ],
      );

      if (!updated) throw new Error("agentic_jobs begin update failed");

      return { jobId: updated.id, stage, shouldRun: true };
    }

    const created = await this.db.one<{ id: string }>(
      `insert into agentic_jobs (
         job_key, kind, stage, source, status, attempts, max_attempts,
         started_at, next_attempt_at, correlation_id, causation_id,
         project_id, org_id, user_id, memory_id, version_token, payload
       )
       values (
         $1, $2, $2, $12, 'running', 1, 5,
         $3, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb
       )
       returning id`,
      [
        jobKey,
        stage,
        now,
        message.correlation_id,
        message.causation_id,
        message.project_id,
        message.org_id,
        message.user_id,
        memoryId,
        message.version_token,
        JSON.stringify(message.payload),
        source,
      ],
    );

    if (!created) throw new Error("agentic_jobs begin insert failed");

    return { jobId: created.id, stage, shouldRun: true };
  }

  async markDone(
    jobId: string,
    result: Record<string, unknown>,
    message?: PipelineCommandMessage,
  ): Promise<void> {
    const completedAt = new Date().toISOString();
    const data = await this.db.one<{ started_at: string | null }>(
      `update agentic_jobs
          set status = 'done',
              result = $2::jsonb,
              completed_at = $3
        where id = $1
        returning started_at::text`,
      [jobId, JSON.stringify(result), completedAt],
    );

    if (message) {
      await this.recordInvocation({
        message,
        status: "ok",
        startedAt: data?.started_at ?? null,
        completedAt,
        result,
      });
    }
  }

  async markFailed(
    jobId: string,
    errorMessage: string,
    message?: PipelineCommandMessage,
  ): Promise<void> {
    const now = new Date().toISOString();
    const data = await this.db.one<{ started_at: string | null }>(
      `update agentic_jobs
          set status = 'failed',
              error = $2,
              last_error_at = $3,
              completed_at = $3
        where id = $1
        returning started_at::text`,
      [jobId, truncateError(errorMessage), now],
    );

    if (message) {
      await this.recordInvocation({
        message,
        status: "error",
        startedAt: data?.started_at ?? null,
        completedAt: now,
        errorMessage,
      });
    }
  }

  /**
   * Mirror the agentic_jobs row onto `tool_invocations` so the existing
   * observability surface (the dashboard's `/api/observability/*` and
   * the future `/v1/observability/*`) sees the MQ pipeline runs.
   *
   * The two tables serve different jobs:
   *   - `agentic_jobs` is the state machine: idempotency, retries,
   *     "is this stage done for this version_token".
   *   - `tool_invocations` is the audit/timeline: a flat list of "what
   *     ran for this memory / project / user" with duration + status.
   *
   * Rows are written once per stage completion (ok or error). The
   * `tool_name` follows the seeded catalog: `mq.<job_type>`. We swallow
   * write failures here — the canonical state lives in agentic_jobs;
   * losing an invocation row is a degraded observability outcome, not
   * a correctness failure.
   *
   * Caveat: `tool_invocations.org_id` is NOT NULL with a FK to
   * `public.orgs`. Personal-scope memory writes have org_id=null on
   * the message, so they cannot be recorded here without a schema
   * change. Until that schema change lands they stay observable via
   * `agentic_jobs` only — logged as a debug line so it's not silent.
   */
  private async recordInvocation(args: {
    message: PipelineCommandMessage;
    status: "ok" | "error";
    startedAt: string | null;
    completedAt: string;
    result?: Record<string, unknown>;
    errorMessage?: string;
  }): Promise<void> {
    const { message, status, startedAt, completedAt, result, errorMessage } = args;

    if (!message.org_id) {
      this.logger.debug?.(
        `[mq.observability] skipping tool_invocations row for personal-scope job ` +
          `job_type=${message.job_type} aggregate_id=${message.aggregate_id} ` +
          `(org_id=null; agentic_jobs row still recorded)`,
      );
      return;
    }

    const durationMs = startedAt
      ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt))
      : null;
    const memoryId =
      message.aggregate_type === "memory" ? message.aggregate_id : null;

    try {
      await this.db.query(
        `insert into tool_invocations (
           org_id, project_id, user_id, tool_name, args, result_summary,
           status, error_message, duration_ms, session_id, agent_identity, invoked_at
         )
         values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, null, 'worker', $10)`,
        [
          message.org_id,
          message.project_id,
          message.user_id,
          `mq.${message.job_type}`,
          JSON.stringify({
            correlation_id: message.correlation_id,
            causation_id: message.causation_id,
            aggregate_type: message.aggregate_type,
            aggregate_id: message.aggregate_id,
            memory_id: memoryId,
            version_token: message.version_token,
          }),
          JSON.stringify(result ?? {}),
          status,
          errorMessage ? truncateError(errorMessage) : null,
          durationMs,
          startedAt ?? completedAt,
        ],
      );
    } catch (error) {
      this.logger.warn(
        `[mq.observability] tool_invocations insert failed ` +
          `job_type=${message.job_type} aggregate_id=${message.aggregate_id} ` +
          `err=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private jobKeyFor(message: PipelineCommandMessage): string {
    switch (message.job_type) {
      case "project.briefing":
        return `briefing:${message.project_id}:${message.version_token}`;
      case "memory.preprocess":
        return `preprocess:${message.aggregate_id}:${message.version_token}`;
      case "memory.embed":
        return `embed:${message.aggregate_id}:${message.version_token}`;
      case "memory.triage":
        return `triage:${message.aggregate_id}:${message.version_token}`;
      case "memory.episode":
        return `episode:${message.aggregate_id}:${message.version_token}`;
      case "memory.synthesize":
        return `synthesize:${message.aggregate_id}:${message.version_token}`;
      case "memory.member_knowledge":
        return `member_knowledge:${message.project_id}:${message.aggregate_id}:${message.version_token}`;
    }
  }
}

function truncateError(message: string): string {
  return message.length > 1000 ? `${message.slice(0, 997)}...` : message;
}
