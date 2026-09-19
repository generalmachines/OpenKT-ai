import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { WorkerPgService } from "../../database/worker-pg.service";
import { SQS_CLIENT } from "../../mq/mq.constants";

// Worker-local mirror of apps/server/.../health-deep-probe.service.ts.
//
// Why the duplication: apps/worker doesn't compile against the
// Drizzle DI surface (it uses WorkerPgService over pg.Pool directly),
// and the probe set is short and frozen. Keeping the worker copy means
// the worker app stays buildable without dragging apps/server into its
// compile graph.
//
// The contract is intentionally identical to HealthDeepProbeService —
// same snake_case service keys, same status strings, same shape — so
// the row written into service_health matches what the HTTP endpoint
// returns to callers.

export type ProbeStatus = "ok" | "degraded" | "down";

export interface ProbeResult {
  status: ProbeStatus;
  latency_ms: number;
  reason?: string;
}

export interface RabbitmqProbeResult extends ProbeResult {
  ready_count?: number;
  consumer_count?: number;
}

export interface HealthDeepSnapshot {
  overall: ProbeStatus;
  checked_at: string;
  services: {
    rds: ProbeResult;
    rabbitmq: RabbitmqProbeResult;
    memmachine: ProbeResult;
    supabase: ProbeResult;
    openai_embed: ProbeResult;
    openrouter: ProbeResult;
  };
}

const PROBE_TIMEOUT_MS = 3_000;
const DEGRADED_LATENCY_MS = 2_000;

@Injectable()
export class WorkerHealthProbeService {
  private readonly logger = new Logger(WorkerHealthProbeService.name);

  constructor(
    private readonly pg: WorkerPgService,
    private readonly config: ConfigService,
    @Inject(SQS_CLIENT) private readonly sqsClient: SQSClient | null,
  ) {}

  async snapshot(): Promise<HealthDeepSnapshot> {
    const [rds, rabbitmq, memmachine, supabase, openai_embed, openrouter] =
      await Promise.all([
        this.probeRds(),
        this.probeQueue(),
        this.probeMemmachine(),
        this.probeSupabase(),
        this.probeOpenaiEmbed(),
        this.probeOpenrouter(),
      ]);
    const services = { rds, rabbitmq, memmachine, supabase, openai_embed, openrouter };
    return {
      overall: foldOverall(Object.values(services).map((s) => s.status)),
      checked_at: new Date().toISOString(),
      services,
    };
  }

  async probeRds(): Promise<ProbeResult> {
    const started = Date.now();
    try {
      await this.pg.query("select 1");
      return classify(Date.now() - started);
    } catch (err) {
      return {
        status: "down",
        latency_ms: Date.now() - started,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async probeQueue(): Promise<RabbitmqProbeResult> {
    if (this.config.get<string>("OPENKT_QUEUE_BACKEND") === "sqs") {
      return this.probeSqs();
    }
    return this.probeRabbitmq();
  }

  async probeRabbitmq(): Promise<RabbitmqProbeResult> {
    const started = Date.now();
    const mgmtUrl = this.config.get<string>("OPENKT_RABBITMQ_MGMT_URL");
    if (!mgmtUrl) {
      return {
        status: "down",
        latency_ms: 0,
        reason: "OPENKT_RABBITMQ_MGMT_URL not configured",
      };
    }
    const user = this.config.get<string>("OPENKT_RABBITMQ_MGMT_USER");
    const pass = this.config.get<string>("OPENKT_RABBITMQ_MGMT_PASS");
    const headers: Record<string, string> = { accept: "application/json" };
    if (user && pass) {
      headers.authorization =
        "Basic " + Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
    }
    try {
      const base = mgmtUrl.replace(/\/+$/, "");
      const res = await fetchWithTimeout(`${base}/api/queues`, { headers }, PROBE_TIMEOUT_MS);
      const latency = Date.now() - started;
      if (!res.ok) {
        return { status: "down", latency_ms: latency, reason: `mgmt api status ${res.status}` };
      }
      const body = (await res.json()) as unknown;
      const { ready, consumers } = aggregateQueueStats(body);
      if (consumers < 1) {
        return {
          status: "degraded",
          latency_ms: latency,
          ready_count: ready,
          consumer_count: consumers,
          reason: "no consumers attached",
        };
      }
      const status: ProbeStatus = latency > DEGRADED_LATENCY_MS ? "degraded" : "ok";
      return {
        status,
        latency_ms: latency,
        ready_count: ready,
        consumer_count: consumers,
        ...(status === "degraded" ? { reason: "slow" } : {}),
      };
    } catch (err) {
      return {
        status: "down",
        latency_ms: Date.now() - started,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async probeSqs(): Promise<RabbitmqProbeResult> {
    const started = Date.now();
    const queueUrl = this.config.get<string>("OPENKT_SQS_COMMAND_QUEUE_URL");
    if (!this.sqsClient || !queueUrl) {
      return {
        status: "down",
        latency_ms: 0,
        reason: "SQS client or OPENKT_SQS_COMMAND_QUEUE_URL not configured",
      };
    }

    try {
      const result = await this.sqsClient.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: [
            "ApproximateNumberOfMessages",
            "ApproximateNumberOfMessagesNotVisible",
          ],
        }),
      );
      const latency = Date.now() - started;
      const ready =
        toFinite(result.Attributes?.ApproximateNumberOfMessages) ?? 0;
      const status: ProbeStatus =
        latency > DEGRADED_LATENCY_MS ? "degraded" : "ok";
      return {
        status,
        latency_ms: latency,
        ready_count: ready,
        ...(status === "degraded" ? { reason: "slow" } : {}),
      };
    } catch (err) {
      return {
        status: "down",
        latency_ms: Date.now() - started,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async probeMemmachine(): Promise<ProbeResult> {
    return this.probeHttpGet(this.config.get<string>("OPENKT_MEMMACHINE_URL"), "/healthz", {});
  }

  async probeSupabase(): Promise<ProbeResult> {
    return this.probeHttpGet(this.config.get<string>("SUPABASE_URL"), "/auth/v1/health", {});
  }

  async probeOpenaiEmbed(): Promise<ProbeResult> {
    const key = this.config.get<string>("OPENAI_API_KEY");
    if (!key) return { status: "down", latency_ms: 0, reason: "OPENAI_API_KEY not configured" };
    return this.probeHttpGet("https://api.openai.com", "/v1/models", {
      authorization: `Bearer ${key}`,
    });
  }

  async probeOpenrouter(): Promise<ProbeResult> {
    const key = this.config.get<string>("OPENKT_DEFAULT_LLM_KEY");
    if (!key)
      return { status: "down", latency_ms: 0, reason: "OPENKT_DEFAULT_LLM_KEY not configured" };
    return this.probeHttpGet("https://openrouter.ai", "/api/v1/models", {
      authorization: `Bearer ${key}`,
    });
  }

  private async probeHttpGet(
    base: string | undefined,
    path: string,
    headers: Record<string, string>,
  ): Promise<ProbeResult> {
    const started = Date.now();
    if (!base) return { status: "down", latency_ms: 0, reason: "base url not configured" };
    try {
      const url = base.replace(/\/+$/, "") + path;
      const res = await fetchWithTimeout(url, { headers }, PROBE_TIMEOUT_MS);
      const latency = Date.now() - started;
      if (!res.ok) {
        return { status: "down", latency_ms: latency, reason: `status ${res.status}` };
      }
      return classify(latency);
    } catch (err) {
      return {
        status: "down",
        latency_ms: Date.now() - started,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function classify(latencyMs: number): ProbeResult {
  if (latencyMs > DEGRADED_LATENCY_MS) {
    return { status: "degraded", latency_ms: latencyMs, reason: "slow" };
  }
  return { status: "ok", latency_ms: latencyMs };
}

function foldOverall(statuses: ProbeStatus[]): ProbeStatus {
  if (statuses.includes("down")) return "down";
  if (statuses.includes("degraded")) return "degraded";
  return "ok";
}

function aggregateQueueStats(raw: unknown): { ready: number; consumers: number } {
  if (!Array.isArray(raw)) return { ready: 0, consumers: 0 };
  let ready = 0;
  let consumers = 0;
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const q = item as Record<string, unknown>;
    ready += toFinite(q.messages_ready ?? q.messages) ?? 0;
    consumers += toFinite(q.consumers) ?? 0;
  }
  return { ready, consumers };
}

function toFinite(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchWithTimeout(
  url: string,
  init: { headers?: Record<string, string>; method?: string; body?: string },
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
