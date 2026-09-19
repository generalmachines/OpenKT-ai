-- LLM I/O capture for the trace endpoint.
--
-- The triage / synthesize / episode / member_knowledge / briefing
-- stages all funnel through LlmGatewayService, which already writes a
-- row to llm_calls with provider/model/tokens/latency/status. The
-- dashboard wants the *content* of those calls so a user inspecting a
-- memory's trace can see the prompt the LLM saw and the response it
-- gave back — not just "triage completed in 412ms".
--
-- Columns added:
--   prompt_messages    jsonb  — array of {role, content}, content
--                                truncated to 8KB per message in the
--                                application layer before insert
--   response_text      text   — raw text the provider returned
--   response_metadata  jsonb  — provider response metadata (usage,
--                                finish_reason, model, id, ...)
--   truncated          bool   — true when at least one prompt message
--                                was truncated to fit the 8KB cap
--
-- Capture is gated by OPENKT_LLM_IO_CAPTURE (default true). When the
-- env flag is false the worker / server recorders skip these columns
-- entirely (they stay NULL) and the existing token/latency accounting
-- continues unchanged.

ALTER TABLE "llm_calls"
  ADD COLUMN IF NOT EXISTS "prompt_messages" jsonb,
  ADD COLUMN IF NOT EXISTS "response_text" text,
  ADD COLUMN IF NOT EXISTS "response_metadata" jsonb,
  ADD COLUMN IF NOT EXISTS "truncated" boolean NOT NULL DEFAULT false;--> statement-breakpoint

-- Optional index — the trace endpoint joins llm_calls per memory_id +
-- stage. The existing stage_created_idx covers global rollups; this
-- one accelerates the per-memory join used by GET /v1/memories/:id/trace.
CREATE INDEX IF NOT EXISTS "llm_calls_memory_id_idx"
  ON "llm_calls" ("memory_id", "created_at" DESC)
  WHERE "memory_id" IS NOT NULL;--> statement-breakpoint
