import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

// We use amqplib's bare API for one-shot probing — no need for
// amqp-connection-manager's retry layer because this endpoint is
// allowed to fail fast and return `broker_reachable: false`.
import * as amqplib from "amqplib";

// Live RabbitMQ broker state for the platform-admin dashboard.
//
// Two probing strategies, picked by env:
//   1. HTTP management API — preferred. Amazon MQ exposes the
//      RabbitMQ management plugin on port 443 of the broker's web URL.
//      Configure OPENKT_RABBITMQ_MGMT_URL + _USER + _PASS to opt in.
//      Returns exchanges + queues + consumers from /api/{exchanges,
//      queues, consumers}.
//   2. amqplib fallback — opens a one-shot connection to RABBITMQ_URL,
//      calls channel.checkQueue(name) for each known queue, and infers
//      the exchanges from a static list (we can't enumerate via AMQP
//      without the management plugin).
//
// The endpoint never 5xx's: any unreachable / auth / timeout error
// short-circuits to `broker_reachable: false` with empty arrays. The
// dashboard then renders "broker unreachable" in the live view.

// `q.memory.neighbors`, `q.memory.answer`, and `q.memory.repair` were
// dropped from the topology in the pipeline simplification push.
// Neighbors are now computed lazily on recall (see MemoryRecallService)
// and answer/repair were stubs the orchestrator never implemented.
const KNOWN_QUEUES = [
  "q.memory.commands",
  "q.memory.preprocess",
  "q.memory.embed",
  "q.memory.triage",
  "q.memory.episode",
  "q.memory.synthesize",
  "q.memory.member_knowledge",
  "q.project.briefing",
];

const KNOWN_EXCHANGES = [
  { name: "memory.engine.commands", type: "topic", durable: true },
  { name: "memory.engine.events", type: "topic", durable: true },
  { name: "memory.engine.dlx", type: "topic", durable: true },
];

// Both probing strategies cap at this many ms to keep the endpoint
// snappy. 3s gives the management API plenty of time over the wider
// internet while still bounding the worst case for the dashboard.
const PROBE_TIMEOUT_MS = 3_000;

export interface RabbitMqState {
  broker_reachable: boolean;
  last_checked: string;
  exchanges: Array<{
    name: string;
    type: string;
    durable: boolean;
    message_count_estimate: number | null;
  }>;
  queues: Array<{
    name: string;
    message_count: number;
    messages_unack: number;
    consumer_count: number;
    idle_since: string | null;
  }>;
  consumers: Array<{
    queue: string;
    consumer_tag: string;
    prefetch_count: number | null;
  }>;
}

@Injectable()
export class RabbitMqStateService {
  private readonly logger = new Logger(RabbitMqStateService.name);

  constructor(private readonly config: ConfigService) {}

  async snapshot(): Promise<RabbitMqState> {
    const mgmtUrl = this.config.get<string>("OPENKT_RABBITMQ_MGMT_URL");
    if (mgmtUrl) {
      const fromHttp = await this.probeHttpApi(mgmtUrl);
      if (fromHttp) return fromHttp;
      // fall through to amqplib probe — the HTTP path may have failed
      // for reasons (network blip, auth misconfig) but the broker
      // itself could still be reachable via AMQP.
    }
    return this.probeAmqp();
  }

  // ── HTTP management API ─────────────────────────────────────────

  private async probeHttpApi(mgmtUrl: string): Promise<RabbitMqState | null> {
    const user = this.config.get<string>("OPENKT_RABBITMQ_MGMT_USER");
    const pass = this.config.get<string>("OPENKT_RABBITMQ_MGMT_PASS");
    const headers: Record<string, string> = { accept: "application/json" };
    if (user && pass) {
      headers.authorization =
        "Basic " + Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
    }

    try {
      const base = mgmtUrl.replace(/\/+$/, "");
      const [exchangesRes, queuesRes, consumersRes] = await Promise.all([
        fetchWithTimeout(`${base}/api/exchanges`, headers, PROBE_TIMEOUT_MS),
        fetchWithTimeout(`${base}/api/queues`, headers, PROBE_TIMEOUT_MS),
        fetchWithTimeout(`${base}/api/consumers`, headers, PROBE_TIMEOUT_MS),
      ]);
      if (!exchangesRes.ok || !queuesRes.ok || !consumersRes.ok) {
        this.logger.warn(
          `rabbitmq mgmt api non-2xx: exchanges=${exchangesRes.status} queues=${queuesRes.status} consumers=${consumersRes.status}`,
        );
        return null;
      }
      const [exchanges, queues, consumers] = (await Promise.all([
        exchangesRes.json(),
        queuesRes.json(),
        consumersRes.json(),
      ])) as [unknown, unknown, unknown];

      return {
        broker_reachable: true,
        last_checked: new Date().toISOString(),
        exchanges: this.shapeExchanges(exchanges),
        queues: this.shapeQueues(queues),
        consumers: this.shapeConsumers(consumers),
      };
    } catch (err) {
      this.logger.warn(
        `rabbitmq mgmt api unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private shapeExchanges(raw: unknown): RabbitMqState["exchanges"] {
    if (!Array.isArray(raw)) return [];
    const out: RabbitMqState["exchanges"] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const e = item as Record<string, unknown>;
      const name = typeof e.name === "string" ? e.name : null;
      if (!name) continue;
      // Amazon MQ surfaces a leading "" exchange (the default) we don't
      // want to expose.
      if (name === "") continue;
      out.push({
        name,
        type: typeof e.type === "string" ? e.type : "topic",
        durable: e.durable === true,
        message_count_estimate:
          typeof e.message_stats_in === "object" && e.message_stats_in !== null
            ? toFiniteNumber((e.message_stats_in as Record<string, unknown>).publish) ?? null
            : null,
      });
    }
    return out;
  }

  private shapeQueues(raw: unknown): RabbitMqState["queues"] {
    if (!Array.isArray(raw)) return [];
    const out: RabbitMqState["queues"] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const q = item as Record<string, unknown>;
      const name = typeof q.name === "string" ? q.name : null;
      if (!name) continue;
      out.push({
        name,
        message_count: toFiniteNumber(q.messages_ready ?? q.messages) ?? 0,
        messages_unack: toFiniteNumber(q.messages_unacknowledged) ?? 0,
        consumer_count: toFiniteNumber(q.consumers) ?? 0,
        idle_since: typeof q.idle_since === "string" ? q.idle_since : null,
      });
    }
    return out;
  }

  private shapeConsumers(raw: unknown): RabbitMqState["consumers"] {
    if (!Array.isArray(raw)) return [];
    const out: RabbitMqState["consumers"] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const c = item as Record<string, unknown>;
      const queue =
        c.queue && typeof c.queue === "object"
          ? (c.queue as Record<string, unknown>).name
          : null;
      const queueName = typeof queue === "string" ? queue : null;
      const consumerTag =
        typeof c.consumer_tag === "string" ? c.consumer_tag : null;
      if (!queueName || !consumerTag) continue;
      out.push({
        queue: queueName,
        consumer_tag: consumerTag,
        prefetch_count: toFiniteNumber(c.prefetch_count) ?? null,
      });
    }
    return out;
  }

  // ── amqplib fallback ────────────────────────────────────────────

  private async probeAmqp(): Promise<RabbitMqState> {
    const url = this.config.get<string>("RABBITMQ_URL");
    const empty: RabbitMqState = {
      broker_reachable: false,
      last_checked: new Date().toISOString(),
      exchanges: [],
      queues: [],
      consumers: [],
    };
    if (!url) return empty;

    // amqplib >= 0.10 returns a `ChannelModel` from connect(); the
    // raw Connection is wrapped under `.connection` and exposes the
    // event emitter surface only. ChannelModel is the wrapper that
    // owns createChannel() and the close() we need.
    let conn: amqplib.ChannelModel | null = null;
    let channel: amqplib.Channel | null = null;
    try {
      conn = await withTimeout(
        amqplib.connect(url),
        PROBE_TIMEOUT_MS,
        "amqplib.connect",
      );
      channel = await withTimeout(
        conn.createChannel(),
        PROBE_TIMEOUT_MS,
        "amqplib.createChannel",
      );
      // Silence the default error handler — checkQueue rejects with
      // a 404 channel close when a queue is absent, and we don't want
      // those to bubble up as unhandled errors.
      channel.on("error", () => {});

      const queues: RabbitMqState["queues"] = [];
      // checkQueue is per-channel and a 404 closes the channel, so we
      // sequentially open a fresh channel for each probe. Cheap enough
      // for ~11 queues in a single one-shot endpoint.
      for (const queueName of KNOWN_QUEUES) {
        const stats = await this.probeQueue(conn, queueName);
        if (stats) queues.push(stats);
      }

      await safeClose(channel, "channel");
      await safeClose(conn, "connection");

      return {
        broker_reachable: true,
        last_checked: new Date().toISOString(),
        // amqplib can't enumerate exchanges, so we return the static
        // declared topology — same names the worker asserts on boot.
        // message_count_estimate is null because checkExchange returns
        // a name-only echo (no counters).
        exchanges: KNOWN_EXCHANGES.map((e) => ({
          ...e,
          message_count_estimate: null,
        })),
        queues,
        // checkQueue doesn't surface consumer tags, only counts. We
        // return an empty consumer list under the amqplib path; the
        // count per queue lives on the queue row above.
        consumers: [],
      };
    } catch (err) {
      this.logger.warn(
        `amqplib probe failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      await safeClose(channel, "channel");
      await safeClose(conn, "connection");
      return empty;
    }
  }

  private async probeQueue(
    conn: amqplib.ChannelModel,
    queueName: string,
  ): Promise<RabbitMqState["queues"][number] | null> {
    let probe: amqplib.Channel | null = null;
    try {
      probe = await withTimeout(
        conn.createChannel(),
        PROBE_TIMEOUT_MS,
        `createChannel(${queueName})`,
      );
      probe!.on("error", () => {});
      const result = await withTimeout(
        probe!.checkQueue(queueName),
        PROBE_TIMEOUT_MS,
        `checkQueue(${queueName})`,
      );
      return {
        name: result.queue,
        message_count: result.messageCount ?? 0,
        messages_unack: 0,
        consumer_count: result.consumerCount ?? 0,
        idle_since: null,
      };
    } catch (err) {
      // checkQueue fails (404) when the queue doesn't exist yet. We
      // log at debug level and skip; the row simply doesn't appear in
      // the response.
      this.logger.debug?.(
        `checkQueue(${queueName}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      await safeClose(probe, `channel(${queueName})`);
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { headers, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timeout ${label} after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function safeClose(
  closable:
    | { close: () => Promise<unknown> | void }
    | null
    | undefined,
  _label: string,
): Promise<void> {
  if (!closable) return;
  try {
    await Promise.resolve(closable.close());
  } catch {
    // best-effort
  }
}

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
