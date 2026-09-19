/**
 * RabbitMQ topology constants — Track C of the SGS migration.
 *
 * Source of truth: `docs/specs/memory-engine-rabbitmq-pipeline-v1.md`
 * (sections "RabbitMQ topology", "Routing keys", "Queues"). Keep this
 * file in lock-step with the spec — every name change propagates here.
 *
 * Reliability posture:
 *   - All three exchanges are durable.
 *   - All three exchanges are type `topic`. The original design used
 *     `x-modulus-hash` (rabbitmq_sharding plugin) for horizontal worker
 *     scaling, but Amazon MQ for RabbitMQ does not support custom plugins
 *     and we run a single worker today — sharding was a no-op. Topic
 *     exchanges work on every broker without plugins, and we can re-add
 *     a sharding mode behind a feature flag when we genuinely need 4+
 *     parallel workers.
 *
 * Routing:
 *   - All commands publish to MEMORY_COMMANDS_EXCHANGE with a routing key
 *     describing the operation (e.g. `memory.preprocess.request`). A
 *     single durable queue (MEMORY_COMMANDS_QUEUE) is bound with `#` so
 *     every command lands there for the worker to dispatch internally.
 *   - Events publish to MEMORY_EVENTS_EXCHANGE with stage routing keys
 *     (memory.preprocess.done, memory.embed.done, etc.) — topic exchange
 *     allows future per-stage observability subscribers.
 */

// ── Exchanges ───────────────────────────────────────────────────────

/** Commands exchange. Type `topic` — was `x-modulus-hash`. */
export const MEMORY_COMMANDS_EXCHANGE = "memory.engine.commands";

/** Topic exchange for stage-completion / failure events. */
export const MEMORY_EVENTS_EXCHANGE = "memory.engine.events";

/** Dead-letter exchange. Topic so per-stage DLQs subscribe by stage key. */
export const MEMORY_DLX_EXCHANGE = "memory.engine.dlx";

/**
 * Single durable command queue. Bound to MEMORY_COMMANDS_EXCHANGE with
 * `#` so every command routing key (memory.*.request, project.*.request)
 * lands here. The worker's command consumer reads from this queue.
 */
export const MEMORY_COMMANDS_QUEUE = "q.memory.commands";

/** @deprecated Use MEMORY_COMMANDS_QUEUE. Kept as an alias for any in-tree caller. */
export const MEMORY_COMMANDS_PSEUDO_QUEUE = MEMORY_COMMANDS_QUEUE;

// ── Routing keys (commands) ─────────────────────────────────────────

export const ROUTING_KEY_PREPROCESS_REQUEST = "memory.preprocess.request";
export const ROUTING_KEY_EMBED_REQUEST = "memory.embed.request";
export const ROUTING_KEY_TRIAGE_REQUEST = "memory.triage.request";
export const ROUTING_KEY_EPISODE_REQUEST = "memory.episode.request";
export const ROUTING_KEY_SYNTHESIZE_REQUEST = "memory.synthesize.request";
export const ROUTING_KEY_MEMBER_KNOWLEDGE_REQUEST = "memory.member_knowledge.request";
export const ROUTING_KEY_BRIEFING_REQUEST = "project.briefing.request";

// ── Routing keys (events) ───────────────────────────────────────────

export const ROUTING_KEY_PREPROCESS_DONE = "memory.preprocess.done";
export const ROUTING_KEY_EMBED_DONE = "memory.embed.done";
export const ROUTING_KEY_TRIAGE_DONE = "memory.triage.done";
export const ROUTING_KEY_EPISODE_DONE = "memory.episode.done";
export const ROUTING_KEY_SYNTHESIZE_DONE = "memory.synthesize.done";
export const ROUTING_KEY_MEMBER_KNOWLEDGE_DONE = "memory.member_knowledge.done";
export const ROUTING_KEY_BRIEFING_DONE = "project.briefing.done";
export const ROUTING_KEY_STAGE_FAILED = "memory.stage.failed";

// ── Queue names ─────────────────────────────────────────────────────
//
// `q.memory.answer` and `q.memory.repair` were dropped — the worker
// never had a real implementation for either stage. Migration 0028
// removes them from the `agentic_jobs.kind` allow-list to match.

export const QUEUE_PREPROCESS = "q.memory.preprocess";
export const QUEUE_EMBED = "q.memory.embed";
export const QUEUE_TRIAGE = "q.memory.triage";
export const QUEUE_EPISODE = "q.memory.episode";
export const QUEUE_SYNTHESIZE = "q.memory.synthesize";
export const QUEUE_MEMBER_KNOWLEDGE = "q.memory.member_knowledge";
export const QUEUE_BRIEFING = "q.project.briefing";

// ── DI tokens ───────────────────────────────────────────────────────

export const RMQ_CONNECTION_MANAGER = Symbol("RMQ_CONNECTION_MANAGER");
export const SQS_CLIENT = Symbol("SQS_CLIENT");
export const MESSAGE_QUEUE_PUBLISHER = Symbol("MESSAGE_QUEUE_PUBLISHER");
