import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql } from "drizzle-orm";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";

// Deep health probes — one fast call per CORE service, hard-bounded by a
// per-probe timeout so the aggregate endpoint always returns within ~3s
// even when half the world is on fire.
//
// Status semantics:
//   * ok       — responsive AND meets SLA (latency under DEGRADED_LATENCY_MS,
//                consumers attached for rabbitmq, etc.)
//   * degraded — responsive but slow / partial (e.g. queue with no consumer)
//   * down     — timeout, error, non-2xx, or required env unset
//
// Each probe is wrapped so an unexpected throw still produces a "down"
// row instead of bubbling — the endpoint must never 5xx.

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

// 3s is the contract — every probe must either resolve or be aborted by
// this deadline. The aggregate runs probes in parallel so worst-case
// wall time is bounded by this constant, not the sum.
const PROBE_TIMEOUT_MS = 3_000;

// Latency over this threshold flips an otherwise-ok probe to "degraded".
// Tuned so the dashboard reports actually-slow services (>2s) without
// being noisy about normal cold starts.
const DEGRADED_LATENCY_MS = 2_000;

@Injectable()
export class HealthDeepProbeService {
  private readonly logger = new Logger(HealthDeepProbeService.name);

  constructor(
    private readonly config: ConfigService,
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
  ) {}

  // ── aggregate snapshot ──────────────────────────────────────────

  async snapshot(): Promise<HealthDeepSnapshot> {
    // All probes run in parallel — they're independent and the wall
    // time we care about is the max, not the sum.
    const [rds, rabbitmq, memmachine, supabase, openai_embed, openrouter] =
      await Promise.all([
        this.probeRds(),
        this.probeRabbitmq(),
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

  // ── individual probes ───────────────────────────────────────────

  async probeRds(): Promise<ProbeResult> {
    const started = Date.now();
    try {
      await this.db.execute(sql`select 1`);
      return classify(Date.now() - started);
    } catch (err) {
      return {
        status: "down",
        latency_ms: Date.now() - started,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async probeRabbitmq(): Promise<RabbitmqProbeResult> {
    const started = Date.now();
    const mgmtUrl = this.config.get<string>("OPENKT_RABBITMQ_MGMT_URL");
    if (!mgmtUrl) {
      return {
        status: "down",
        latency_ms: Date.now() - started,
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
      const res = await fetchWithTimeout(
        `${base}/api/queues`,
        { headers },
        PROBE_TIMEOUT_MS,
      );
      const latency = Date.now() - started;
      if (!res.ok) {
        return {
          status: "down",
          latency_ms: latency,
          reason: `mgmt api status ${res.status}`,
        };
      }
      const body = (await res.json()) as unknown;
      const { ready, consumers } = aggregateQueueStats(body);
      // We require >=1 consumer somewhere in the topology to call the
      // broker "ok". A reachable broker with zero consumers means the
      // worker isn't attached — the pipeline is silently dead.
      if (consumers < 1) {
        return {
          status: "degraded",
          latency_ms: latency,
          ready_count: ready,
          consumer_count: consumers,
          reason: "no consumers attached",
        };
      }
      const status: ProbeStatus =
        latency > DEGRADED_LATENCY_MS ? "degraded" : "ok";
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

  async probeMemmachine(): Promise<ProbeResult> {
    const base = this.config.get<string>("OPENKT_MEMMACHINE_URL");
    return this.probeHttpGet(base, "/healthz", {});
  }

  async probeSupabase(): Promise<ProbeResult> {
    const base = this.config.get<string>("SUPABASE_URL");
    return this.probeHttpGet(base, "/auth/v1/health", {});
  }

  async probeOpenaiEmbed(): Promise<ProbeResult> {
    const key = this.config.get<string>("OPENAI_API_KEY");
    if (!key) {
      return { status: "down", latency_ms: 0, reason: "OPENAI_API_KEY not configured" };
    }
    // /v1/models is a free GET that exercises the same auth path as
    // /v1/embeddings without spending tokens. Good enough to detect
    // key rotation / outage / network blocks.
    return this.probeHttpGet("https://api.openai.com", "/v1/models", {
      authorization: `Bearer ${key}`,
    });
  }

  async probeOpenrouter(): Promise<ProbeResult> {
    const key = this.config.get<string>("OPENKT_DEFAULT_LLM_KEY");
    if (!key) {
      return {
        status: "down",
        latency_ms: 0,
        reason: "OPENKT_DEFAULT_LLM_KEY not configured",
      };
    }
    return this.probeHttpGet("https://openrouter.ai", "/api/v1/models", {
      authorization: `Bearer ${key}`,
    });
  }

  // ── helpers ─────────────────────────────────────────────────────

  private async probeHttpGet(
    base: string | undefined,
    path: string,
    headers: Record<string, string>,
  ): Promise<ProbeResult> {
    const started = Date.now();
    if (!base) {
      return { status: "down", latency_ms: 0, reason: "base url not configured" };
    }
    try {
      const url = base.replace(/\/+$/, "") + path;
      const res = await fetchWithTimeout(url, { headers }, PROBE_TIMEOUT_MS);
      const latency = Date.now() - started;
      if (!res.ok) {
        return {
          status: "down",
          latency_ms: latency,
          reason: `status ${res.status}`,
        };
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

// ── shared helpers (module-private) ──────────────────────────────

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

function aggregateQueueStats(
  raw: unknown,
): { ready: number; consumers: number } {
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
