import crypto from "node:crypto";

export type PipelineJobType =
  | "memory.preprocess"
  | "memory.embed"
  | "memory.triage"
  | "memory.episode"
  | "memory.synthesize"
  | "memory.member_knowledge"
  | "project.briefing";

// `neighbors` is no longer a worker-side stage — neighbors are computed
// lazily on first recall in the server (see MemoryRecallService) and
// cached for 24h in `memory_neighbors`. We removed `answer`/`repair`
// here because they were never implemented; the orchestrator only ever
// returned `{ skipped: true }`. Migration 0028 dropped them from the
// `agentic_jobs.kind` allow-list.
export type PipelineStage =
  | "preprocess"
  | "embed"
  | "triage"
  | "episode"
  | "synthesize"
  | "member_knowledge_synthesis"
  | "briefing";

export interface PipelineCommandMessage {
  message_id: string;
  correlation_id: string;
  causation_id: string | null;
  job_type: PipelineJobType;
  aggregate_type: string;
  aggregate_id: string;
  project_id: string;
  org_id: string | null;
  user_id: string;
  version_token: string;
  payload: Record<string, unknown>;
  published_at: string;
}

export interface StageExecutionResult {
  result: Record<string, unknown>;
  commands?: PipelineCommandMessage[];
  eventRoutingKey?: string;
}

export interface NextCommandInput {
  jobType: PipelineJobType;
  aggregateType?: string;
  aggregateId?: string;
  projectId?: string;
  orgId?: string | null;
  userId?: string;
  versionToken?: string;
  payload?: Record<string, unknown>;
}

export function stageFromJobType(jobType: PipelineJobType): PipelineStage {
  switch (jobType) {
    case "memory.preprocess":
      return "preprocess";
    case "memory.embed":
      return "embed";
    case "memory.triage":
      return "triage";
    case "memory.episode":
      return "episode";
    case "memory.synthesize":
      return "synthesize";
    case "memory.member_knowledge":
      return "member_knowledge_synthesis";
    case "project.briefing":
      return "briefing";
  }
}

export function routingKeyForCommand(message: PipelineCommandMessage): string {
  return message.job_type === "project.briefing" ||
    message.job_type === "memory.member_knowledge"
    ? message.project_id
    : message.aggregate_id;
}

// version_token is the memory's `updated_at` at the moment the outbox event
// was enqueued. The API serializes it via `Date.toISOString()` (millisecond
// precision, e.g. `2026-05-08T13:51:43.587Z`) but Postgres `updated_at::text`
// returns microsecond precision (`2026-05-08 13:51:43.587833+00`). String
// equality always failed; instead compare the parsed wall-clock value at
// millisecond precision (which is what `toISOString` truncates to anyway).
export function isSameVersion(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = Date.parse(a);
  const pb = Date.parse(b);
  return Number.isFinite(pa) && Number.isFinite(pb) && pa === pb;
}

export function nextCommand(
  source: PipelineCommandMessage,
  input: NextCommandInput,
): PipelineCommandMessage {
  return {
    message_id: crypto.randomUUID(),
    correlation_id: source.correlation_id,
    causation_id: source.message_id,
    job_type: input.jobType,
    aggregate_type: input.aggregateType ?? source.aggregate_type,
    aggregate_id: input.aggregateId ?? source.aggregate_id,
    project_id: input.projectId ?? source.project_id,
    org_id: input.orgId ?? source.org_id,
    user_id: input.userId ?? source.user_id,
    version_token: input.versionToken ?? source.version_token,
    payload: input.payload ?? source.payload,
    published_at: new Date().toISOString(),
  };
}
