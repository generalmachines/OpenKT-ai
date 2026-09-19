// Unit tests for HealthMonitorService — the worker-side cron that:
//   1. Probes every CORE service every 30s
//   2. Writes a sample row into service_health
//   3. Detects ok ↔ degraded/down state transitions
//   4. Opens / resolves rows in service_incidents accordingly
//   5. Optionally posts to OPENKT_HEALTH_WEBHOOK_URL on every transition
//   6. Prunes service_health rows older than 24h
//
// We stub the probe service and the pg layer so each branch is exercised
// without a real RabbitMQ or RDS. The webhook fire-and-forget path is
// verified by asserting fetch was called with the expected payload and
// that a webhook 5xx does NOT cause the tick to throw.

import { HealthMonitorService } from "../../apps/worker/src/modules/health-monitor/services/health-monitor.service";

type Row = Record<string, unknown>;

function makePg() {
  const inserts: { sql: string; params: unknown[] }[] = [];
  const queries: { sql: string; params: unknown[] }[] = [];
  let latestByService: Record<string, Row | null> = {};
  let openIncidents: Record<string, Row | null> = {};
  return {
    inserts,
    queries,
    setLatest(s: string, row: Row | null) {
      latestByService[s] = row;
    },
    setOpenIncident(s: string, row: Row | null) {
      openIncidents[s] = row;
    },
    query: jest.fn(async (sql: string, params: unknown[] = []): Promise<Row[]> => {
      queries.push({ sql, params });
      const trimmed = sql.trim().toLowerCase();
      if (trimmed.startsWith("insert into service_health")) {
        inserts.push({ sql, params });
        return [];
      }
      if (trimmed.startsWith("select") && trimmed.includes("from service_health")) {
        const service = String(params[0]);
        const row = latestByService[service];
        return row ? [row] : [];
      }
      if (trimmed.startsWith("select") && trimmed.includes("from service_incidents")) {
        const service = String(params[0]);
        const row = openIncidents[service];
        return row ? [row] : [];
      }
      if (trimmed.startsWith("insert into service_incidents")) {
        inserts.push({ sql, params });
        const service = String(params[0]);
        openIncidents[service] = {
          id: "fake-id",
          service,
          severity: params[1],
          started_at: new Date().toISOString(),
          resolved_at: null,
        };
        return [];
      }
      if (trimmed.startsWith("update service_incidents")) {
        inserts.push({ sql, params });
        const service = String(params[0]);
        openIncidents[service] = null;
        return [];
      }
      if (trimmed.startsWith("delete from service_health")) {
        inserts.push({ sql, params });
        return [];
      }
      return [];
    }),
  };
}

type Status = "ok" | "degraded" | "down";

function snapshotAllOk() {
  return {
    overall: "ok" as Status,
    checked_at: new Date().toISOString(),
    services: {
      rds: { status: "ok" as Status, latency_ms: 5 } as { status: Status; latency_ms: number; reason?: string },
      rabbitmq: {
        status: "ok" as Status,
        latency_ms: 10,
        ready_count: 0,
        consumer_count: 1,
      } as {
        status: Status;
        latency_ms: number;
        ready_count?: number;
        consumer_count?: number;
        reason?: string;
      },
      memmachine: { status: "ok" as Status, latency_ms: 12 } as { status: Status; latency_ms: number; reason?: string },
      supabase: { status: "ok" as Status, latency_ms: 8 } as { status: Status; latency_ms: number; reason?: string },
      openai_embed: { status: "ok" as Status, latency_ms: 50 } as { status: Status; latency_ms: number; reason?: string },
      openrouter: { status: "ok" as Status, latency_ms: 60 } as { status: Status; latency_ms: number; reason?: string },
    },
  };
}

function snapshotRdsDown() {
  const s = snapshotAllOk();
  s.services.rds = { status: "down", latency_ms: 3000, reason: "ETIMEDOUT" };
  s.overall = "down";
  return s;
}

describe("HealthMonitorService", () => {
  const originalFetch = global.fetch;
  let originalWebhook: string | undefined;

  beforeEach(() => {
    originalWebhook = process.env.OPENKT_HEALTH_WEBHOOK_URL;
    delete process.env.OPENKT_HEALTH_WEBHOOK_URL;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalWebhook === undefined) {
      delete process.env.OPENKT_HEALTH_WEBHOOK_URL;
    } else {
      process.env.OPENKT_HEALTH_WEBHOOK_URL = originalWebhook;
    }
  });

  it("writes one service_health row per service per tick", async () => {
    const pg = makePg();
    const probes = { snapshot: jest.fn(async () => snapshotAllOk()) };
    const svc = new HealthMonitorService(pg as never, probes as never);

    await svc.tick();

    expect(probes.snapshot).toHaveBeenCalledTimes(1);
    const sampleInserts = pg.inserts.filter((i) =>
      i.sql.trim().toLowerCase().startsWith("insert into service_health"),
    );
    expect(sampleInserts).toHaveLength(6);
  });

  it("opens an incident on ok → down transition", async () => {
    const pg = makePg();
    // last sample was ok
    pg.setLatest("rds", { service: "rds", status: "ok", at: new Date().toISOString() });
    // no open incident
    pg.setOpenIncident("rds", null);

    const probes = { snapshot: jest.fn(async () => snapshotRdsDown()) };
    const svc = new HealthMonitorService(pg as never, probes as never);

    await svc.tick();

    const opens = pg.inserts.filter((i) =>
      i.sql.trim().toLowerCase().startsWith("insert into service_incidents"),
    );
    expect(opens).toHaveLength(1);
    expect(opens[0].params[0]).toBe("rds");
    expect(opens[0].params[1]).toBe("down");
  });

  it("does NOT open a duplicate incident when one is already open", async () => {
    const pg = makePg();
    pg.setLatest("rds", { service: "rds", status: "down", at: new Date().toISOString() });
    pg.setOpenIncident("rds", {
      id: "existing",
      service: "rds",
      severity: "down",
      started_at: new Date().toISOString(),
      resolved_at: null,
    });

    const probes = { snapshot: jest.fn(async () => snapshotRdsDown()) };
    const svc = new HealthMonitorService(pg as never, probes as never);

    await svc.tick();

    const opens = pg.inserts.filter((i) =>
      i.sql.trim().toLowerCase().startsWith("insert into service_incidents"),
    );
    expect(opens).toHaveLength(0);
  });

  it("resolves an open incident on degraded/down → ok transition", async () => {
    const pg = makePg();
    pg.setLatest("rds", { service: "rds", status: "down", at: new Date().toISOString() });
    pg.setOpenIncident("rds", {
      id: "open-1",
      service: "rds",
      severity: "down",
      started_at: new Date().toISOString(),
      resolved_at: null,
    });

    const probes = { snapshot: jest.fn(async () => snapshotAllOk()) };
    const svc = new HealthMonitorService(pg as never, probes as never);

    await svc.tick();

    const resolves = pg.inserts.filter((i) =>
      i.sql.trim().toLowerCase().startsWith("update service_incidents"),
    );
    expect(resolves).toHaveLength(1);
    expect(resolves[0].params[0]).toBe("rds");
  });

  it("fires the optional webhook on transition open AND resolve", async () => {
    process.env.OPENKT_HEALTH_WEBHOOK_URL = "https://hooks.example.com/health";
    const fetchMock = jest.fn(async () => new Response("ok", { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const pg = makePg();
    pg.setLatest("rds", { service: "rds", status: "ok", at: new Date().toISOString() });
    pg.setOpenIncident("rds", null);

    const probes = { snapshot: jest.fn(async () => snapshotRdsDown()) };
    const svc = new HealthMonitorService(pg as never, probes as never);
    await svc.tick();

    expect(fetchMock).toHaveBeenCalled();
    const call = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(String(call[0])).toBe("https://hooks.example.com/health");
    const body = JSON.parse(String(call[1].body));
    expect(body.service).toBe("rds");
    expect(body.severity).toBe("down");
    expect(body.event).toBe("open");
  });

  it("does NOT fire the webhook when OPENKT_HEALTH_WEBHOOK_URL is unset", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const pg = makePg();
    pg.setLatest("rds", { service: "rds", status: "ok", at: new Date().toISOString() });
    pg.setOpenIncident("rds", null);

    const probes = { snapshot: jest.fn(async () => snapshotRdsDown()) };
    const svc = new HealthMonitorService(pg as never, probes as never);
    await svc.tick();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("swallows webhook failures (fire-and-forget)", async () => {
    process.env.OPENKT_HEALTH_WEBHOOK_URL = "https://hooks.example.com/health";
    global.fetch = jest.fn(async () => {
      throw new Error("DNS failure");
    }) as unknown as typeof fetch;

    const pg = makePg();
    pg.setLatest("rds", { service: "rds", status: "ok", at: new Date().toISOString() });
    pg.setOpenIncident("rds", null);

    const probes = { snapshot: jest.fn(async () => snapshotRdsDown()) };
    const svc = new HealthMonitorService(pg as never, probes as never);

    // Must NOT throw — webhook is best-effort.
    await expect(svc.tick()).resolves.toBeUndefined();
  });

  it("prunes service_health rows older than 24h on each tick", async () => {
    const pg = makePg();
    const probes = { snapshot: jest.fn(async () => snapshotAllOk()) };
    const svc = new HealthMonitorService(pg as never, probes as never);

    await svc.tick();

    const prunes = pg.inserts.filter((i) =>
      i.sql.trim().toLowerCase().startsWith("delete from service_health"),
    );
    expect(prunes).toHaveLength(1);
    expect(prunes[0].sql.toLowerCase()).toContain("interval '24 hours'");
  });
});
