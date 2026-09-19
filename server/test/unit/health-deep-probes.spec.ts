// Unit tests for HealthDeepProbeService.
//
// The probe service is the shared core consumed by:
//   * GET /v1/internal/health-deep (apps/server)
//   * the HealthMonitorService cron (apps/worker)
//
// Each probe must:
//   * run with a 3s timeout and never throw
//   * return `status: "ok" | "degraded" | "down"` + `latency_ms`
//   * fold into an `overall` summary (down > degraded > ok)
//
// We mock global.fetch + the Drizzle DB to exercise the happy/degraded/
// down branches deterministically.

import { HealthDeepProbeService } from "../../apps/server/src/modules/health-deep/services/health-deep-probe.service";

function fakeConfig(values: Record<string, string | undefined>) {
  return {
    get: (key: string) => values[key],
  } as unknown as import("@nestjs/config").ConfigService;
}

function fakeDb(impl: () => unknown) {
  return {
    execute: jest.fn(async () => impl()),
  };
}

describe("HealthDeepProbeService", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  // ── rds ───────────────────────────────────────────────────────────

  it("rds probe returns ok when SELECT 1 resolves", async () => {
    const db = fakeDb(() => ({ rows: [{ "?column?": 1 }] }));
    const svc = new HealthDeepProbeService(
      fakeConfig({}),
      db as never,
    );

    const result = await svc.probeRds();
    expect(result.status).toBe("ok");
    expect(typeof result.latency_ms).toBe("number");
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("rds probe returns down when the query throws", async () => {
    const db = {
      execute: jest.fn(async () => {
        throw new Error("connection refused");
      }),
    };
    const svc = new HealthDeepProbeService(fakeConfig({}), db as never);

    const result = await svc.probeRds();
    expect(result.status).toBe("down");
    expect(result.reason).toMatch(/connection refused/i);
  });

  // ── rabbitmq ──────────────────────────────────────────────────────

  it("rabbitmq probe returns ok when mgmt api reports consumers>=1", async () => {
    global.fetch = jest.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/api/queues")) {
        return new Response(
          JSON.stringify([
            { name: "q.memory.embed", messages_ready: 3, consumers: 1 },
            { name: "q.memory.triage", messages_ready: 0, consumers: 2 },
          ]),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const svc = new HealthDeepProbeService(
      fakeConfig({
        OPENKT_RABBITMQ_MGMT_URL: "https://broker.example.com",
        OPENKT_RABBITMQ_MGMT_USER: "guest",
        OPENKT_RABBITMQ_MGMT_PASS: "guest",
      }),
      fakeDb(() => ({ rows: [] })) as never,
    );

    const result = await svc.probeRabbitmq();
    expect(result.status).toBe("ok");
    expect(result.ready_count).toBe(3);
    expect(result.consumer_count).toBe(3);
  });

  it("rabbitmq probe returns degraded when no consumers are attached", async () => {
    global.fetch = jest.fn(async () => {
      return new Response(
        JSON.stringify([
          { name: "q.memory.embed", messages_ready: 7, consumers: 0 },
        ]),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const svc = new HealthDeepProbeService(
      fakeConfig({
        OPENKT_RABBITMQ_MGMT_URL: "https://broker.example.com",
      }),
      fakeDb(() => ({ rows: [] })) as never,
    );

    const result = await svc.probeRabbitmq();
    expect(result.status).toBe("degraded");
    expect(result.consumer_count).toBe(0);
  });

  it("rabbitmq probe returns down when mgmt url is missing", async () => {
    const svc = new HealthDeepProbeService(
      fakeConfig({}),
      fakeDb(() => ({ rows: [] })) as never,
    );

    const result = await svc.probeRabbitmq();
    expect(result.status).toBe("down");
    expect(result.reason).toMatch(/not configured/i);
  });

  it("rabbitmq probe returns down on fetch error", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const svc = new HealthDeepProbeService(
      fakeConfig({
        OPENKT_RABBITMQ_MGMT_URL: "https://broker.example.com",
      }),
      fakeDb(() => ({ rows: [] })) as never,
    );

    const result = await svc.probeRabbitmq();
    expect(result.status).toBe("down");
  });

  // ── memmachine ───────────────────────────────────────────────────

  it("memmachine probe returns ok on 2xx", async () => {
    global.fetch = jest.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const svc = new HealthDeepProbeService(
      fakeConfig({ OPENKT_MEMMACHINE_URL: "http://memmachine:8080" }),
      fakeDb(() => ({ rows: [] })) as never,
    );
    const r = await svc.probeMemmachine();
    expect(r.status).toBe("ok");
  });

  it("memmachine probe returns down when not configured", async () => {
    const svc = new HealthDeepProbeService(
      fakeConfig({}),
      fakeDb(() => ({ rows: [] })) as never,
    );
    const r = await svc.probeMemmachine();
    expect(r.status).toBe("down");
  });

  it("memmachine probe returns down on 5xx", async () => {
    global.fetch = jest.fn(
      async () => new Response("err", { status: 503 }),
    ) as unknown as typeof fetch;
    const svc = new HealthDeepProbeService(
      fakeConfig({ OPENKT_MEMMACHINE_URL: "http://memmachine:8080" }),
      fakeDb(() => ({ rows: [] })) as never,
    );
    const r = await svc.probeMemmachine();
    expect(r.status).toBe("down");
  });

  // ── supabase ─────────────────────────────────────────────────────

  it("supabase probe returns ok on 2xx", async () => {
    global.fetch = jest.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const svc = new HealthDeepProbeService(
      fakeConfig({ SUPABASE_URL: "https://abc.supabase.co" }),
      fakeDb(() => ({ rows: [] })) as never,
    );
    const r = await svc.probeSupabase();
    expect(r.status).toBe("ok");
  });

  it("supabase probe returns down when SUPABASE_URL missing", async () => {
    const svc = new HealthDeepProbeService(
      fakeConfig({}),
      fakeDb(() => ({ rows: [] })) as never,
    );
    const r = await svc.probeSupabase();
    expect(r.status).toBe("down");
  });

  // ── openai embed ─────────────────────────────────────────────────

  it("openai_embed probe returns ok on /v1/models 2xx", async () => {
    global.fetch = jest.fn(async () => new Response("[]", { status: 200 })) as unknown as typeof fetch;
    const svc = new HealthDeepProbeService(
      fakeConfig({ OPENAI_API_KEY: "sk-test" }),
      fakeDb(() => ({ rows: [] })) as never,
    );
    const r = await svc.probeOpenaiEmbed();
    expect(r.status).toBe("ok");
  });

  it("openai_embed probe returns down on 401", async () => {
    global.fetch = jest.fn(async () => new Response("unauth", { status: 401 })) as unknown as typeof fetch;
    const svc = new HealthDeepProbeService(
      fakeConfig({ OPENAI_API_KEY: "sk-bad" }),
      fakeDb(() => ({ rows: [] })) as never,
    );
    const r = await svc.probeOpenaiEmbed();
    expect(r.status).toBe("down");
  });

  // ── openrouter ───────────────────────────────────────────────────

  it("openrouter probe returns ok on 2xx", async () => {
    global.fetch = jest.fn(async () => new Response("[]", { status: 200 })) as unknown as typeof fetch;
    const svc = new HealthDeepProbeService(
      fakeConfig({ OPENKT_DEFAULT_LLM_KEY: "sk-or-test" }),
      fakeDb(() => ({ rows: [] })) as never,
    );
    const r = await svc.probeOpenrouter();
    expect(r.status).toBe("ok");
  });

  // ── snapshot ─────────────────────────────────────────────────────

  it("snapshot aggregates probes with overall=ok when every probe is ok", async () => {
    global.fetch = jest.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/api/queues")) {
        return new Response(
          JSON.stringify([
            { name: "q.memory.embed", messages_ready: 0, consumers: 1 },
          ]),
          { status: 200 },
        );
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const svc = new HealthDeepProbeService(
      fakeConfig({
        OPENKT_RABBITMQ_MGMT_URL: "https://broker.example.com",
        OPENKT_MEMMACHINE_URL: "http://memmachine:8080",
        SUPABASE_URL: "https://abc.supabase.co",
        OPENAI_API_KEY: "sk-test",
        OPENKT_DEFAULT_LLM_KEY: "sk-or-test",
      }),
      fakeDb(() => ({ rows: [{ "?column?": 1 }] })) as never,
    );
    const snap = await svc.snapshot();
    expect(snap.overall).toBe("ok");
    expect(snap.services.rds.status).toBe("ok");
    expect(snap.services.rabbitmq.status).toBe("ok");
    expect(snap.services.memmachine.status).toBe("ok");
    expect(snap.services.supabase.status).toBe("ok");
    expect(snap.services.openai_embed.status).toBe("ok");
    expect(snap.services.openrouter.status).toBe("ok");
  });

  it("snapshot folds overall=down when any probe is down", async () => {
    // memmachine unconfigured → its probe returns down
    global.fetch = jest.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/api/queues")) {
        return new Response(
          JSON.stringify([
            { name: "q.memory.embed", messages_ready: 0, consumers: 1 },
          ]),
          { status: 200 },
        );
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const svc = new HealthDeepProbeService(
      fakeConfig({
        OPENKT_RABBITMQ_MGMT_URL: "https://broker.example.com",
        SUPABASE_URL: "https://abc.supabase.co",
        OPENAI_API_KEY: "sk-test",
        OPENKT_DEFAULT_LLM_KEY: "sk-or-test",
        // OPENKT_MEMMACHINE_URL intentionally absent
      }),
      fakeDb(() => ({ rows: [{ "?column?": 1 }] })) as never,
    );
    const snap = await svc.snapshot();
    expect(snap.overall).toBe("down");
    expect(snap.services.memmachine.status).toBe("down");
  });

  it("snapshot folds overall=degraded when any probe is degraded and none down", async () => {
    global.fetch = jest.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/api/queues")) {
        // consumer_count 0 → degraded
        return new Response(
          JSON.stringify([
            { name: "q.memory.embed", messages_ready: 0, consumers: 0 },
          ]),
          { status: 200 },
        );
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const svc = new HealthDeepProbeService(
      fakeConfig({
        OPENKT_RABBITMQ_MGMT_URL: "https://broker.example.com",
        OPENKT_MEMMACHINE_URL: "http://memmachine:8080",
        SUPABASE_URL: "https://abc.supabase.co",
        OPENAI_API_KEY: "sk-test",
        OPENKT_DEFAULT_LLM_KEY: "sk-or-test",
      }),
      fakeDb(() => ({ rows: [{ "?column?": 1 }] })) as never,
    );
    const snap = await svc.snapshot();
    expect(snap.overall).toBe("degraded");
    expect(snap.services.rabbitmq.status).toBe("degraded");
  });
});
