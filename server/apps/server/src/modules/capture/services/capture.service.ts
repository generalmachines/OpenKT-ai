import { Injectable, Logger } from "@nestjs/common";

import { LlmGatewayService } from "@openkt/platform-llm";
import type { ActorContext } from "@openkt/core-context";

import { refuseSecrets } from "../../../common/secrets/refuse-secrets";
import { MemoryCommandsApplicationService } from "../../memory/services/memory-commands.application.service";
import { CreateMemorySchema } from "../../memory/contracts/memory.contract";

/**
 * CaptureService — Stage 2 of the OpenKT CLI's CAPTURE hook.
 *
 * The CLI's capture.py uses a regex gate (Stage 1) to filter ~80%
 * of prompts down to ones that look like context transfers
 * (preferences, decisions, corrections, facts). When a prompt passes
 * the gate, the CLI POSTs to /v1/capture; this service runs a small
 * LLM that decides:
 *
 *   (1) Is this a saveable memory?  If no → return saved:false (cheap path)
 *   (2) If yes, extract a clean third-person statement + kind + confidence
 *   (3) Save via the existing memoryCommands.create path
 *
 * Cost ceiling: ~$0.001 per call on the cheapest provider (haiku /
 * minimax-mini equivalent). LLM has a hard 800-token max output so
 * a prompt-injection attack can't make us write giant memories.
 *
 * The "is this saveable?" classification is the expensive bit
 * (saves us from auto-flooding the project with low-signal noise).
 * Once kt_save_memory's synthesize-on-save lands (de-synmem) the
 * dedup/merge logic will further protect against duplicate captures
 * — but the LLM is the front-line filter.
 */

// Tight JSON schema the LLM is asked to follow. The service parses
// the LLM output strictly; anything that doesn't match this shape is
// treated as "not saveable" rather than risking a malformed write.
interface ExtractedMemory {
  saveable: boolean;
  // Only present when saveable=true.
  kind?:
    | "decision"
    | "pattern"
    | "anti-pattern"
    | "context"
    | "incident"
    | "skill"
    | "environment"
    | "note"
    | "fact"
    | "debug-recipe"
    | "other";
  content?: string;
  confidence?: number;
  reason?: string;
}

const SYSTEM_PROMPT = `You extract durable cross-session knowledge from a single user prompt to an AI coding agent.

Your job is to decide whether the prompt contains a CONTEXT TRANSFER worth saving as a project memory, and if so, distill it into a clean third-person statement.

RULES — saveable=true ONLY when ALL hold:
  (a) The prompt states a durable fact, preference, decision, anti-pattern, or correction that the user actually wants the agent (and future agents) to remember.
  (b) The statement is non-obvious — not something derivable from \`git log\` or current code.
  (c) The statement is specific — not "we should write better code".

Otherwise: saveable=false (ephemeral questions, transient requests, status updates, debugging back-and-forth, etc.). When in doubt, set saveable=false. False-negatives are recoverable; false-positives are noise.

KINDS (use the most specific match):
  - decision: explicit choice between alternatives ("we chose X over Y because Z")
  - pattern: workflow / approach that should be repeated ("always run X before Y")
  - anti-pattern: workflow / approach that should be avoided ("don't deploy on Fridays")
  - context: domain fact / background ("Alex works at Acme Labs")
  - incident: bug / failure with cause + fix ("symptom S was caused by C; fix is F")
  - skill: technique to remember ("the right way to do X is Y")
  - environment: infrastructure / config ("API lives at api.openkt.ai/v1")
  - debug-recipe: troubleshooting steps for a specific failure mode
  - fact: simple statement of truth (use sparingly; prefer context)
  - other: only if none of the above fit

OUTPUT FORMAT — strict JSON, no other text:
{
  "saveable": <bool>,
  "kind": <one of the above, only when saveable=true>,
  "content": <1-2 sentence third-person statement, no "the user said", only when saveable=true>,
  "confidence": <0.0-1.0; >=0.6 to actually save>,
  "reason": <one short sentence explaining the verdict>
}

EXAMPLES:

Input: "I want to use AWS for hosting and Cloudflare for DNS"
Output: {"saveable":true,"kind":"decision","content":"Alex prefers AWS for hosting and Cloudflare for DNS.","confidence":0.9,"reason":"Explicit deploy-stack preference"}

Input: "how is the weather"
Output: {"saveable":false,"confidence":1.0,"reason":"Not a context transfer"}

Input: "don't use the beta runner for the nightly export agents — they don't spawn"
Output: {"saveable":true,"kind":"anti-pattern","content":"The beta runner does not work for the nightly export agents; use the stable runner instead.","confidence":0.85,"reason":"Concrete anti-pattern with reason"}

Input: "ok continue"
Output: {"saveable":false,"confidence":1.0,"reason":"Acknowledgement, no content"}
`;

@Injectable()
export class CaptureService {
  private readonly logger = new Logger(CaptureService.name);

  constructor(
    private readonly llm: LlmGatewayService,
    private readonly memoryCommands: MemoryCommandsApplicationService,
  ) {}

  /**
   * Classify + extract + save (or skip).
   *
   * Throws iff the LLM is genuinely unreachable AND there's no
   * fallback provider available. Otherwise returns a structured
   * verdict the controller can pass through to the client.
   */
  async capture(
    context: ActorContext,
    input: { prompt: string; project_id: string },
  ): Promise<{
    saved: boolean;
    memory_id?: string;
    kind?: string;
    confidence?: number;
    reason: string;
  }> {
    // Hard ceiling on input length so a runaway prompt can't burn
    // through tokens. The CLI side already caps at 4000 chars; this
    // belt-and-suspenders 8000 leaves headroom for future bumps but
    // caps the worst-case cost per call.
    const prompt = input.prompt.slice(0, 8000);
    // Refused before the prompt reaches any model, not only at the save.
    refuseSecrets("prompt", prompt);

    // Light LLM classification. Output is constrained to 800 tokens
    // — the JSON object we want is <300, and 800 is a safety net.
    let raw: string;
    try {
      const result = await this.llm.generate({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        maxOutputTokens: 800,
        timeoutMs: 15_000,
      });
      raw = result.text.trim();
    } catch (err) {
      this.logger.warn(
        `capture LLM unreachable for project_id=${input.project_id}: ${
          (err as Error).message
        }`,
      );
      return { saved: false, reason: "LLM unavailable; capture skipped" };
    }

    // Strict JSON parse. The LLM might wrap the object in
    // ```json fences``` — strip those first.
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();

    let parsed: ExtractedMemory;
    try {
      parsed = JSON.parse(cleaned) as ExtractedMemory;
    } catch {
      this.logger.debug(
        `capture LLM returned non-JSON for project_id=${input.project_id}: ${cleaned.slice(0, 200)}`,
      );
      return { saved: false, reason: "LLM output not JSON" };
    }

    if (!parsed.saveable) {
      return {
        saved: false,
        reason: parsed.reason ?? "LLM verdict: not saveable",
      };
    }
    if (!parsed.content || !parsed.kind) {
      return {
        saved: false,
        reason: "LLM verdict saveable but missing content or kind",
      };
    }
    // Hard floor on confidence — the prompt requests >=0.6; defend
    // against the LLM ignoring instructions.
    if ((parsed.confidence ?? 0) < 0.6) {
      return {
        saved: false,
        kind: parsed.kind,
        confidence: parsed.confidence,
        reason: `LLM confidence ${parsed.confidence ?? 0} < 0.6 floor`,
      };
    }

    // Save via the same path the MCP kt_save_memory tool uses. This
    // means the new dedup/merge/supersede logic from de-synmem (when
    // it lands) will apply uniformly — captures get the same
    // treatment as agent-initiated saves.
    //
    // Build the input through the SAME zod schema the REST controller
    // (parseWithSchema) and MCP tool (inputSchema) use — NOT a hand-cast
    // object. parse() applies the contract defaults; the critical one is
    // visibility:"project". The live memories.visibility column is
    // NOT NULL with no DB default, so an undefined visibility reaches
    // Postgres as DEFAULT → NULL → "null value in column \"visibility\"
    // violates not-null constraint" → 500 on every saveable capture
    // (incident 2026-06-05, request_id b0334a1d). safeParse also
    // validates the LLM-extracted fields — a hallucinated kind outside
    // MemoryKindSchema now returns saved:false instead of throwing.
    const memoryInput = CreateMemorySchema.safeParse({
      content: parsed.content,
      kind: parsed.kind,
      project_id: input.project_id,
      tag_slugs: ["captured-from-prompt"],
      confidence: parsed.confidence,
      // Lower importance than direct agent-saves — captured prompts
      // are signal-rich but the agent didn't explicitly endorse them.
      // Synthesize-on-save will compound importance for duplicates.
      importance: 0.4,
    });
    if (!memoryInput.success) {
      const issue = memoryInput.error.issues[0];
      this.logger.debug(
        `capture extraction failed contract validation for project_id=${input.project_id}: ` +
          `${issue?.path.join(".")} ${issue?.message}`,
      );
      return {
        saved: false,
        kind: parsed.kind,
        confidence: parsed.confidence,
        reason: `extracted memory failed validation: ${issue?.path.join(".") || "input"} ${issue?.message || "invalid"}`,
      };
    }

    const created = await this.memoryCommands.create(context, memoryInput.data);
    // `create` can return a "gate suggestion" instead of a memory if
    // the content is too long; surface that cleanly.
    if (!("id" in created)) {
      return {
        saved: false,
        kind: parsed.kind,
        confidence: parsed.confidence,
        reason: `memory gate suggestion: ${created.verdict}`,
      };
    }
    return {
      saved: true,
      memory_id: created.id,
      kind: parsed.kind,
      confidence: parsed.confidence,
      reason: parsed.reason ?? "saved",
    };
  }
}
