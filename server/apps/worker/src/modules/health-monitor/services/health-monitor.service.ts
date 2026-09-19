import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";

import { WorkerPgService } from "../../database/worker-pg.service";
import {
  WorkerHealthProbeService,
  type HealthDeepSnapshot,
  type ProbeStatus,
} from "./worker-health-probe.service";

// HealthMonitor — worker-side cron (every 30s) that:
//   1. Probes every CORE service via WorkerHealthProbeService
//   2. Writes one service_health row per service per tick
//   3. Detects ok ↔ degraded/down transitions by comparing against the
//      most recent prior sample for that service
//   4. Opens / resolves rows in service_incidents
//   5. Fires the optional OPENKT_HEALTH_WEBHOOK_URL (fire-and-forget)
//   6. Prunes service_health rows older than 24h
//
// Self-scheduled via setInterval — same pattern as DailyRollupService,
// because the worker app doesn't import @nestjs/schedule yet. Disable
// for tests / migration runs with OPENKT_DISABLE_HEALTH_MONITOR=1.

const TICK_MS = 30_000;

// Match the snake_case keys the probe service emits.
const SERVICE_KEYS = [
  "rds",
  "rabbitmq",
  "memmachine",
  "supabase",
  "openai_embed",
  "openrouter",
] as const;
type ServiceKey = (typeof SERVICE_KEYS)[number];

interface PriorSample {
  status: string;
}

interface OpenIncident {
  id: string;
  severity: string;
}

@Injectable()
export class HealthMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HealthMonitorService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly pg: WorkerPgService,
    private readonly probes: WorkerHealthProbeService,
  ) {}

  onModuleInit(): void {
    if (process.env.OPENKT_DISABLE_HEALTH_MONITOR === "1") {
      this.logger.log("health monitor disabled by env");
      return;
    }
    setImmediate(() => this.runSafe());
    this.timer = setInterval(() => this.runSafe(), TICK_MS);
    this.logger.log(`health monitor scheduled (every ${TICK_MS}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async runSafe(): Promise<void> {
    try {
      await this.tick();
    } catch (err) {
      this.logger.error(
        `tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Public so tests can drive it deterministically.
  async tick(): Promise<void> {
    const snap = await this.probes.snapshot();

    // Sample writes + transition checks happen sequentially per service
    // so that the prior-sample lookup is correctly serialized against
    // the row this tick is about to insert. (We read prior first, then
    // write the new row, then resolve the transition.)
    for (const key of SERVICE_KEYS) {
      const probe = snap.services[key];
      const prior = await this.fetchPriorSample(key);
      await this.insertSample(key, snap, probe);
      await this.handleTransition(key, prior, probe);
    }

    // 24h retention — cheap one-shot DELETE.
    await this.pruneOldSamples();
  }

  private async fetchPriorSample(service: ServiceKey): Promise<PriorSample | null> {
    const rows = await this.pg.query<{ status: string }>(
      `SELECT status FROM service_health WHERE service = $1 ORDER BY at DESC LIMIT 1`,
      [service],
    );
    return rows[0] ?? null;
  }

  private async insertSample(
    service: ServiceKey,
    snap: HealthDeepSnapshot,
    probe: HealthDeepSnapshot["services"][ServiceKey],
  ): Promise<void> {
    await this.pg.query(
      `INSERT INTO service_health (service, status, latency_ms, detail, at)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [
        service,
        probe.status,
        probe.latency_ms ?? null,
        JSON.stringify(probe),
        snap.checked_at,
      ],
    );
  }

  private async handleTransition(
    service: ServiceKey,
    prior: PriorSample | null,
    probe: HealthDeepSnapshot["services"][ServiceKey],
  ): Promise<void> {
    // No prior sample → no transition yet. The first tick after boot
    // just establishes a baseline; we don't fire incidents on first
    // observation because the dashboard should reflect steady-state
    // not the cold-start glitch.
    if (!prior) return;

    const wasOk = prior.status === "ok";
    const isOk = probe.status === "ok";

    if (wasOk && !isOk) {
      // ok → degraded/down — open an incident (if not already open).
      await this.openIncident(service, probe.status as ProbeStatus, probe);
      return;
    }

    if (!wasOk && isOk) {
      // degraded/down → ok — resolve the open incident.
      await this.resolveIncident(service, probe);
    }

    // (same-state ticks and degraded ↔ down transitions are intentionally
    // not surfaced as new incidents to avoid flapping; the current
    // sample still reflects the active severity.)
  }

  private async openIncident(
    service: ServiceKey,
    severity: ProbeStatus,
    probe: unknown,
  ): Promise<void> {
    const open = await this.fetchOpenIncident(service);
    if (open) return; // dedup — one open incident per service
    await this.pg.query(
      `INSERT INTO service_incidents (service, severity, detail, started_at)
       VALUES ($1, $2, $3::jsonb, now())`,
      [service, severity, JSON.stringify(probe)],
    );
    await this.fireWebhook({
      event: "open",
      service,
      severity,
      detail: probe,
      at: new Date().toISOString(),
    });
  }

  private async resolveIncident(service: ServiceKey, probe: unknown): Promise<void> {
    const open = await this.fetchOpenIncident(service);
    if (!open) return;
    await this.pg.query(
      `UPDATE service_incidents SET resolved_at = now()
       WHERE service = $1 AND resolved_at IS NULL`,
      [service],
    );
    await this.fireWebhook({
      event: "resolve",
      service,
      severity: open.severity,
      detail: probe,
      at: new Date().toISOString(),
    });
  }

  private async fetchOpenIncident(service: ServiceKey): Promise<OpenIncident | null> {
    const rows = await this.pg.query<{ id: string; severity: string }>(
      `SELECT id, severity FROM service_incidents
       WHERE service = $1 AND resolved_at IS NULL
       ORDER BY started_at DESC LIMIT 1`,
      [service],
    );
    return rows[0] ?? null;
  }

  private async pruneOldSamples(): Promise<void> {
    await this.pg.query(
      `DELETE FROM service_health WHERE at < now() - interval '24 hours'`,
    );
  }

  // Fire-and-forget — webhook failures must not break the cron tick.
  // The operator can point OPENKT_HEALTH_WEBHOOK_URL at SNS, Slack,
  // Discord, an internal HTTP endpoint, whatever. Payload is dumb JSON.
  private async fireWebhook(payload: Record<string, unknown>): Promise<void> {
    const url = process.env.OPENKT_HEALTH_WEBHOOK_URL;
    if (!url) return;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3_000);
      try {
        await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      this.logger.warn(
        `webhook delivery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
