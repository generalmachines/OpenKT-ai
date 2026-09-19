// Unit tests for RabbitMqStateService.
//
// Covers two paths:
//   1. HTTP management-API probe via OPENKT_RABBITMQ_MGMT_URL — we stub
//      global.fetch so the service hits the API without a real broker.
//   2. amqplib fallback — we stub `amqplib.connect()` to either succeed
//      (returning a fake connection + channel.checkQueue) or fail
//      (rejected promise) to verify graceful degradation.
//
// The endpoint NEVER 5xx's: we assert `broker_reachable=false` with
// empty arrays whenever every probe path fails.

const mockAmqpConnect = jest.fn();
jest.mock("amqplib", () => ({
  __esModule: true,
  connect: (...args: unknown[]) => mockAmqpConnect(...args),
}));

import { RabbitMqStateService } from "../../apps/server/src/modules/observability/services/rabbitmq-state.service";

function fakeConfig(values: Record<string, string | undefined>) {
  return {
    get: (key: string) => values[key],
  };
}

describe("RabbitMqStateService", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    jest.clearAllMocks();
    mockAmqpConnect.mockReset();
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("HTTP management API path", () => {
    it("shapes /api/exchanges + /api/queues + /api/consumers when reachable", async () => {
      global.fetch = jest.fn(async (input: unknown) => {
        const url = String(input);
        if (url.endsWith("/api/exchanges")) {
          return new Response(
            JSON.stringify([
              {
                name: "memory.engine.commands",
                type: "topic",
                durable: true,
                message_stats_in: { publish: 1234 },
              },
              { name: "", type: "direct", durable: true }, // default — should be filtered
            ]),
            { status: 200 },
          );
        }
        if (url.endsWith("/api/queues")) {
          return new Response(
            JSON.stringify([
              {
                name: "q.memory.embed",
                messages_ready: 7,
                messages_unacknowledged: 2,
                consumers: 1,
                idle_since: "2026-05-14T09:59:00.000Z",
              },
              {
                name: "q.memory.triage",
                messages: 0,
                messages_unacknowledged: 0,
                consumers: 0,
              },
            ]),
            { status: 200 },
          );
        }
        if (url.endsWith("/api/consumers")) {
          return new Response(
            JSON.stringify([
              {
                queue: { name: "q.memory.embed" },
                consumer_tag: "amq.ctag-abc",
                prefetch_count: 8,
              },
            ]),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      }) as unknown as typeof fetch;

      const svc = new RabbitMqStateService(
        fakeConfig({
          OPENKT_RABBITMQ_MGMT_URL: "https://broker.example.com",
          OPENKT_RABBITMQ_MGMT_USER: "guest",
          OPENKT_RABBITMQ_MGMT_PASS: "guest",
        }) as never,
      );

      const result = await svc.snapshot();
      expect(result.broker_reachable).toBe(true);
      expect(result.exchanges).toHaveLength(1);
      expect(result.exchanges[0]).toMatchObject({
        name: "memory.engine.commands",
        type: "topic",
        durable: true,
        message_count_estimate: 1234,
      });
      expect(result.queues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "q.memory.embed",
            message_count: 7,
            messages_unack: 2,
            consumer_count: 1,
            idle_since: "2026-05-14T09:59:00.000Z",
          }),
          expect.objectContaining({
            name: "q.memory.triage",
            message_count: 0,
            consumer_count: 0,
          }),
        ]),
      );
      expect(result.consumers).toEqual([
        {
          queue: "q.memory.embed",
          consumer_tag: "amq.ctag-abc",
          prefetch_count: 8,
        },
      ]);
      // last_checked is an ISO timestamp produced at call time
      expect(Number.isFinite(Date.parse(result.last_checked))).toBe(true);
    });

    it("falls through to amqplib when the HTTP API returns 5xx", async () => {
      global.fetch = jest.fn(async () =>
        new Response("broken", { status: 502 }),
      ) as unknown as typeof fetch;

      mockAmqpConnect.mockRejectedValue(new Error("network unreachable"));

      const svc = new RabbitMqStateService(
        fakeConfig({
          OPENKT_RABBITMQ_MGMT_URL: "https://broker.example.com",
          RABBITMQ_URL: "amqp://localhost",
        }) as never,
      );
      const result = await svc.snapshot();
      // amqplib also failed → graceful degradation
      expect(result.broker_reachable).toBe(false);
      expect(result.exchanges).toEqual([]);
      expect(result.queues).toEqual([]);
      expect(result.consumers).toEqual([]);
    });
  });

  describe("amqplib fallback path", () => {
    it("returns broker_reachable=true with queue checks when amqplib succeeds", async () => {
      // fake amqplib connection: createChannel returns an object with
      // checkQueue + close + on. The service opens one channel per
      // queue check, so we hand back a fresh fake on every call.
      const channels: Array<{
        checkQueue: jest.Mock;
        close: jest.Mock;
        on: jest.Mock;
      }> = [];
      const fakeConn = {
        createChannel: jest.fn(async () => {
          const fake = {
            checkQueue: jest.fn(async (queue: string) => ({
              queue,
              messageCount: 3,
              consumerCount: 1,
            })),
            close: jest.fn(async () => undefined),
            on: jest.fn(),
          };
          channels.push(fake);
          return fake;
        }),
        close: jest.fn(async () => undefined),
      };
      mockAmqpConnect.mockResolvedValue(fakeConn);

      const svc = new RabbitMqStateService(
        fakeConfig({ RABBITMQ_URL: "amqp://localhost" }) as never,
      );
      const result = await svc.snapshot();
      expect(result.broker_reachable).toBe(true);
      // All known queues are probed; each returns {messageCount:3, consumerCount:1}
      expect(result.queues.length).toBeGreaterThan(0);
      for (const q of result.queues) {
        expect(q.message_count).toBe(3);
        expect(q.consumer_count).toBe(1);
        expect(q.messages_unack).toBe(0);
      }
      // Static exchange list is returned with message_count_estimate=null
      expect(result.exchanges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "memory.engine.commands",
            type: "topic",
            durable: true,
            message_count_estimate: null,
          }),
        ]),
      );
      // amqplib path doesn't surface per-consumer tags
      expect(result.consumers).toEqual([]);
      // Sanity: we opened a channel for the initial check + one per
      // queue probe.
      expect(channels.length).toBeGreaterThan(1);
    });

    it("skips queues that don't exist (checkQueue 404 → channel error)", async () => {
      let callIdx = 0;
      const fakeConn = {
        createChannel: jest.fn(async () => {
          const idx = callIdx++;
          return {
            checkQueue: jest.fn(async (queue: string) => {
              // First channel is the warmup; every subsequent channel
              // either succeeds (even idx) or rejects (odd idx).
              if (idx % 2 === 0) {
                return { queue, messageCount: 0, consumerCount: 0 };
              }
              throw new Error("NOT_FOUND - no queue");
            }),
            close: jest.fn(async () => undefined),
            on: jest.fn(),
          };
        }),
        close: jest.fn(async () => undefined),
      };
      mockAmqpConnect.mockResolvedValue(fakeConn);

      const svc = new RabbitMqStateService(
        fakeConfig({ RABBITMQ_URL: "amqp://localhost" }) as never,
      );
      const result = await svc.snapshot();
      // Even with half the queues failing, the endpoint is still
      // reachable and reports the successful ones.
      expect(result.broker_reachable).toBe(true);
      expect(result.queues.length).toBeGreaterThan(0);
    });

    it("returns broker_reachable=false with empty arrays when amqplib.connect rejects", async () => {
      mockAmqpConnect.mockRejectedValue(new Error("ECONNREFUSED"));

      const svc = new RabbitMqStateService(
        fakeConfig({ RABBITMQ_URL: "amqp://localhost" }) as never,
      );
      const result = await svc.snapshot();
      expect(result.broker_reachable).toBe(false);
      expect(result.exchanges).toEqual([]);
      expect(result.queues).toEqual([]);
      expect(result.consumers).toEqual([]);
    });

    it("returns broker_reachable=false when no RABBITMQ_URL is configured", async () => {
      const svc = new RabbitMqStateService(fakeConfig({}) as never);
      const result = await svc.snapshot();
      expect(result.broker_reachable).toBe(false);
      expect(mockAmqpConnect).not.toHaveBeenCalled();
    });
  });
});
