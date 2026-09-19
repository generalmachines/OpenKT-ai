import { z } from "zod";

const baseEnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DATABASE_URL: z.string().min(1).optional(),
  DATA_POSTGRES_URL: z.string().min(1).optional(),
  POSTGRES_URL: z.string().min(1).optional(),
  OPENKT_QUEUE_BACKEND: z.enum(["rabbitmq", "sqs"]).default("rabbitmq"),
  RABBITMQ_URL: z.string().min(1).optional(),
  RMQ_PUBLISHER_CONFIRM_TIMEOUT_MS: z.coerce.number().int().min(1).default(5000),
  AWS_REGION: z.string().min(1).optional(),
  OPENKT_SQS_COMMAND_QUEUE_URL: z.string().url().optional(),
  OPENKT_SQS_EVENTS_QUEUE_URL: z.string().url().optional(),
  OPENKT_SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(20),
  OPENKT_SQS_VISIBILITY_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(43_200)
    .default(300),
  OPENKT_SQS_VISIBILITY_HEARTBEAT_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(21_600)
    .default(60),
  OPENKT_SQS_SHUTDOWN_GRACE_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(3_600)
    .default(30),
  OPENKT_SQS_MAX_MESSAGES: z.coerce.number().int().min(1).max(10).default(8),
  OPENKT_SQS_POLL_ERROR_DELAY_MS: z.coerce.number().int().min(100).default(1000),
  OUTBOX_RELAY_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  OUTBOX_RELAY_ACTIVE_POLL_MS: z.coerce.number().int().min(10).default(250),
  OUTBOX_RELAY_IDLE_POLL_MS: z.coerce.number().int().min(100).default(5000),
  OUTBOX_RELAY_CLAIM_TTL_SECONDS: z.coerce.number().int().min(1).default(30),
  OUTBOX_RELAY_RETRY_BASE_MS: z.coerce.number().int().min(100).default(1000),
  OUTBOX_RELAY_RETRY_MAX_MS: z.coerce.number().int().min(1000).default(60000),
  RMQ_COMMAND_CONSUMER_PREFETCH: z.coerce.number().int().min(1).default(8),
  OPENKT_EMBEDDING_BACKEND: z.enum(["bge", "openai"]).optional(),
  OPENKT_BGE_URL: z.string().url().optional(),
  OPENKT_BGE_MODEL: z.string().min(1).optional(),
  OPENKT_OPENAI_EMBED_URL: z.string().url().optional(),
  OPENKT_OPENAI_EMBED_MODEL: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENKT_DEFAULT_LLM_KEY: z.string().min(1).optional(),
  OPENKT_DEFAULT_LLM_PROVIDER: z
    .enum(["minimax", "openai", "openrouter"])
    .default("minimax"),
  // Secondary provider in the LLM gateway's fallback chain. When the
  // primary trips its circuit breaker (5×5xx in 60s) or exhausts its
  // retry budget, the gateway transparently retries against this one.
  // Set to the same value as OPENKT_DEFAULT_LLM_PROVIDER to disable
  // fallback (the chain collapses to a single provider). Defaults to
  // openai so deployments that already have OPENAI_API_KEY configured
  // for embeddings get LLM fallback for free.
  OPENKT_FALLBACK_LLM_PROVIDER: z
    .enum(["minimax", "openai", "openrouter"])
    .default("openai"),
  OPENKT_DEFAULT_LLM_BASE_URL: z.string().url().optional(),
  // Override the per-provider default model id. Optional; unset uses the
  // provider default (minimax→MiniMax-M2.7, openai→gpt-4o-mini,
  // openrouter→anthropic/claude-haiku-4.5). Set to swap M2.7↔M2.5 without
  // a redeploy.
  OPENKT_DEFAULT_LLM_MODEL: z.string().min(1).optional(),
  // Per-attempt timeout for an LLM provider call. Default lowered from
  // the previous 30s ceiling to 5s so a slow primary can fail fast and
  // the gateway can fall back before the caller's own deadline expires.
  OPENKT_LLM_TIMEOUT_MS: z.coerce.number().int().min(100).default(5000),
  // OpenAI Chat Completions key used by the fallback chain. When unset,
  // the gateway falls back to OPENAI_API_KEY (the embedding-side key)
  // so deployments don't need to duplicate the credential.
  OPENKT_OPENAI_API_KEY: z.string().min(1).optional(),
  // Built-in accounts. Google sign-in is on only when this lists at least one
  // OAuth client id (comma-separated; one per platform — web, desktop, iOS…).
  // An ID token is accepted only if its `aud` is one of them.
  OPENKT_GOOGLE_CLIENT_IDS: z.string().min(1).optional(),
  // Express `trust proxy`. Set it when the API sits behind a reverse proxy or
  // load balancer (e.g. `1` = one hop), otherwise every request appears to
  // come from the proxy's address and the per-IP sign-in limit is shared by
  // everyone. Leave unset when clients connect directly.
  OPENKT_TRUST_PROXY: z.string().min(1).optional(),
  // Signs the CSRF token on the OAuth sign-in page (/oauth/authorize). Optional:
  // unset, the key is derived from OPENKT_INTERNAL_SERVICE_TOKEN, then
  // OPENKT_MCP_SERVICE_KEY, then DATABASE_URL — values every replica shares.
  OPENKT_FORM_SECRET: z.string().min(16).optional(),
  // Supabase sign-in — optional, all-or-nothing (see ensureSupabaseIsAllOrNothing).
  SUPABASE_URL: z.string().url("SUPABASE_URL must be a valid URL").optional(),
  SUPABASE_ANON_KEY: z.string().min(1).optional(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  OPENKT_INTERNAL_SERVICE_TOKEN: z.string().min(1).optional(),
  OPENKT_MCP_SERVICE_KEY: z.string().min(1).optional(),
  // Shared-secret used by /v1/internal/cron/archive-stale and any other
  // internal cron route. Optional in dev; the route fails-closed at
  // runtime when missing so an unconfigured deployment can't be
  // tricked into running the archive sweep.
  CRON_SECRET: z.string().min(1).optional(),
  // Public URL of the OpenKT dashboard. The BFF returns
  // `${OPENKT_DASHBOARD_URL}/signin/device?code=…` from
  // POST /v1/auth/device-code, which the CLI prints for the user. Defaults
  // to the local dev dashboard so a fresh checkout boots; deployments
  // override per-env.
  OPENKT_DASHBOARD_URL: z.string().url().default("http://localhost:3000"),
  // Comma-separated list of origins the BFF will accept browser requests
  // from. The dashboard hits /v1/auth/* with `credentials: "include"`,
  // which means the preflight has to echo an exact origin (`*` is not
  // allowed when credentials travel). When unset, libs/platform/cors
  // applies a dev-friendly default; production must set this to the
  // public app origin (e.g. https://app.openkt.ai).
  CORS_ALLOWED_ORIGINS: z.string().min(1).optional(),
  // Memory engine. `local` is the only engine: plain Postgres —
  // pgvector + tsvector hybrid search, no graph database and no
  // message broker required. The variable stays so a deployment that
  // still sets a removed engine name fails loudly at boot.
  OPENKT_MEMORY_ENGINE: z.enum(["local"]).default("local"),
  // Optional cross-encoder rerank step (M5 hybrid recall). Any
  // OpenAI/TEI-compatible `/rerank` endpoint — e.g. a local
  // Infinity/TEI sidecar serving BAAI/bge-reranker. Skipped cleanly
  // (no network call, no error) when unset.
  OPENKT_RERANK_URL: z.string().url().optional(),
  OPENKT_RERANK_TIMEOUT_MS: z.coerce.number().int().min(100).default(2000),
  // Sessions (M1). Idle-close sweep cadence + disable switch.
  OPENKT_SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).default(30),
  OPENKT_DISABLE_SESSION_SWEEP: z.enum(["0", "1"]).default("0"),
  // ── Knowledge synthesis (migration 0014) ─────────────────────────
  OPENKT_SYNTHESIZE_ENABLED: z.coerce.boolean().default(true),
  OPENKT_SYNTHESIZE_TOP_K: z.coerce.number().int().min(1).max(50).default(5),
  OPENKT_SYNTHESIZE_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  OPENKT_SYNTHESIZE_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  OPENKT_SYNTHESIZE_SUPERSEDE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.75),
  // Observability / quota knobs.
  OPENKT_MINIMAX_MONTHLY_TOKEN_CAP: z.coerce.number().int().min(1).optional(),
  // ── Tag clustering / dedup (Enhancement 1) ───────────────────────
  // Cosine-similarity threshold for "this new tag is the same as that
  // existing tag" in WorkerTagMatcherService. 0.85 is conservative
  // enough that "rabbitmq" and "rabbit-mq" cluster while "rabbitmq"
  // and "rabbit-trap" stay separate. Tune per deployment if the
  // embedding model or tag vocabulary changes.
  OPENKT_TAG_DEDUP_SIMILARITY: z.coerce.number().min(0).max(1).default(0.85),
  // ── LLM I/O capture (Enhancement 2 / migration 0025) ─────────────
  // When true (default), the LLM call recorder also writes prompt
  // messages + response text + response metadata to llm_calls. Set
  // to false in deployments that can't store user prompts for
  // compliance reasons — the existing token/latency accounting still
  // works, the new columns simply stay NULL.
  OPENKT_LLM_IO_CAPTURE: z.coerce.boolean().default(true),
  // RabbitMQ management API (used by /v1/internal/rabbitmq-state). When
  // OPENKT_RABBITMQ_MGMT_URL is set the rabbitmq-state endpoint hits
  // ${url}/api/{exchanges,queues,consumers} with basic-auth from
  // OPENKT_RABBITMQ_MGMT_USER + OPENKT_RABBITMQ_MGMT_PASS. If the URL
  // is unset (or the HTTP probe fails), the endpoint falls back to a
  // lightweight amqplib check.checkQueue() probe against RABBITMQ_URL.
  // Amazon MQ for RabbitMQ exposes the management plugin on port 443
  // of the broker's web URL when enabled.
  OPENKT_RABBITMQ_MGMT_URL: z.string().url().optional(),
  OPENKT_RABBITMQ_MGMT_USER: z.string().min(1).optional(),
  OPENKT_RABBITMQ_MGMT_PASS: z.string().min(1).optional(),
});

const ensureDatabaseUrl = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) =>
  schema.superRefine((value, ctx) => {
    const environment = value as {
      DATABASE_URL?: string;
      DATA_POSTGRES_URL?: string;
      POSTGRES_URL?: string;
    };

    if (
      !environment.DATABASE_URL &&
      !environment.DATA_POSTGRES_URL &&
      !environment.POSTGRES_URL
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DATABASE_URL"],
        message: "DATABASE_URL is required",
      });
    }
  });

const ensureWorkerEnvironment = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) =>
  schema.superRefine((value, ctx) => {
    const environment = value as {
      DATABASE_URL?: string;
      DATA_POSTGRES_URL?: string;
      POSTGRES_URL?: string;
      OPENKT_QUEUE_BACKEND?: "rabbitmq" | "sqs";
      RABBITMQ_URL?: string;
      AWS_REGION?: string;
      OPENKT_SQS_COMMAND_QUEUE_URL?: string;
      OPENKT_SQS_VISIBILITY_TIMEOUT_SECONDS?: number;
      OPENKT_SQS_VISIBILITY_HEARTBEAT_SECONDS?: number;
    };

    if (
      !environment.DATABASE_URL &&
      !environment.DATA_POSTGRES_URL &&
      !environment.POSTGRES_URL
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DATABASE_URL"],
        message: "DATABASE_URL is required",
      });
    }

    if (environment.OPENKT_QUEUE_BACKEND === "sqs") {
      for (const key of ["AWS_REGION", "OPENKT_SQS_COMMAND_QUEUE_URL"] as const) {
        if (!environment[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when OPENKT_QUEUE_BACKEND=sqs`,
          });
        }
      }
      const visibilityTimeout =
        environment.OPENKT_SQS_VISIBILITY_TIMEOUT_SECONDS ?? 300;
      const heartbeat =
        environment.OPENKT_SQS_VISIBILITY_HEARTBEAT_SECONDS ?? 60;
      if (heartbeat * 2 > visibilityTimeout) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["OPENKT_SQS_VISIBILITY_HEARTBEAT_SECONDS"],
          message:
            "OPENKT_SQS_VISIBILITY_HEARTBEAT_SECONDS must be at most half of OPENKT_SQS_VISIBILITY_TIMEOUT_SECONDS",
        });
      }
    } else if (!environment.RABBITMQ_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["RABBITMQ_URL"],
        message: "RABBITMQ_URL is required when OPENKT_QUEUE_BACKEND=rabbitmq",
      });
    }
  });

// Supabase is OPTIONAL: built-in accounts (email + password, Google) need no
// third-party auth service, and the server boots with every SUPABASE_*
// variable unset. But a half-configured Supabase is a mistake worth failing
// on at boot, so once SUPABASE_URL is set the keys that go with it are required.
const ensureSupabaseIsAllOrNothing = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) =>
  schema.superRefine((value, ctx) => {
    const environment = value as {
      SUPABASE_URL?: string;
      SUPABASE_ANON_KEY?: string;
      SUPABASE_PUBLISHABLE_KEY?: string;
      SUPABASE_SERVICE_ROLE_KEY?: string;
    };
    if (!environment.SUPABASE_URL) return;

    if (!environment.SUPABASE_ANON_KEY && !environment.SUPABASE_PUBLISHABLE_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SUPABASE_ANON_KEY"],
        message: "SUPABASE_ANON_KEY or SUPABASE_PUBLISHABLE_KEY is required when SUPABASE_URL is set",
      });
    }
    if (!environment.SUPABASE_SERVICE_ROLE_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SUPABASE_SERVICE_ROLE_KEY"],
        message: "SUPABASE_SERVICE_ROLE_KEY is required when SUPABASE_URL is set",
      });
    }
  });

export const apiEnvironmentSchema = ensureDatabaseUrl(
  ensureSupabaseIsAllOrNothing(
    baseEnvironmentSchema.extend({
      PORT: z.coerce.number().int().min(1).max(65535).default(4100),
    }),
  ),
);

export const workerEnvironmentSchema = ensureWorkerEnvironment(
  baseEnvironmentSchema.extend({
    PORT: z.coerce.number().int().min(1).max(65535).default(4101),
  }),
);

export type ApiEnvironment = z.infer<typeof apiEnvironmentSchema>;
export type WorkerEnvironment = z.infer<typeof workerEnvironmentSchema>;
