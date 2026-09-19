import { AsyncLocalStorage } from "node:async_hooks";

// Per-call observability context for LLM Gateway invocations.
//
// Callers wrap a code region with `runWithLlmCallContext(ctx, () => …)`
// and any LlmGatewayService.tryGenerate*() inside that region will pick
// up the context via the AsyncLocalStorage so the recorder can attach
// `stage`, `purpose`, `memory_id`, `episode_id`, `user_id`, `project_id`
// to the llm_calls row without threading parameters through every
// function signature in the pipeline.

export type LlmCallStage =
  | "triage"
  | "synthesize"
  | "briefing"
  | "answer"
  | "embed"
  | "manual"
  | "preprocess"
  | "episode"
  | "pulse";

export interface LlmCallContext {
  stage: LlmCallStage;
  purpose?: string | null;
  memoryId?: string | null;
  episodeId?: string | null;
  userId?: string | null;
  projectId?: string | null;
  requestId?: string | null;
}

const storage = new AsyncLocalStorage<LlmCallContext>();

export function runWithLlmCallContext<T>(
  context: LlmCallContext,
  fn: () => T,
): T {
  return storage.run(context, fn);
}

export function getLlmCallContext(): LlmCallContext | undefined {
  return storage.getStore();
}

// Merge a partial override on top of the current context. Returns the
// resulting context (or undefined when nothing is set). Useful when a
// caller wants to inherit project/user from an outer scope and only
// override `purpose` for a sub-call.
export function withLlmCallContext<T>(
  override: Partial<LlmCallContext> & Pick<LlmCallContext, "stage">,
  fn: () => T,
): T {
  const parent = storage.getStore();
  const merged: LlmCallContext = {
    ...(parent ?? {}),
    ...override,
    stage: override.stage,
  };
  return storage.run(merged, fn);
}
