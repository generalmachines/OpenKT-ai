import { Inject, Injectable, Optional } from "@nestjs/common";

import type { ActorContext } from "@openkt/core-context";
import { LlmGatewayService } from "@openkt/platform-llm";

import type { BriefingPayload, BriefingRow } from "../contracts/briefing.contract";
import { LocalPgBriefingRepository } from "../repositories/local-pg-briefing.repository";

const SYSTEM_PROMPT = `You are a senior staff engineer writing a short weekly briefing for a teammate dropping back into a software project after a few days away.

You are NOT briefing an AI agent — write for a human. Use plain prose with light Markdown structure. No headers larger than ##, no horizontal rules.

The reader wants four things, in this order:
1. **Direction this week** — what is the team consolidating around? One paragraph.
2. **What landed** — bulleted list, one bullet per memory or pattern that converged. Cite the person and the concrete outcome.
3. **Open thread — left off here** — bulleted list of what is still mid-flight. Be specific.
4. **Decisions made** — bulleted list of architectural / process commitments.
5. **What to brief the next agent on** — one or two sentences, in voice, as if briefing someone walking up to your desk.

Tone: confident, terse, evidence-cited. No hype. No "we are excited to". No emoji. No closing summary.

Output JSON: { "briefing_md": "..." }. The briefing_md value is the full markdown body. Keep it under 350 words.`;

@Injectable()
export class BriefingsApplicationService {
  constructor(
    private readonly briefingRepository: LocalPgBriefingRepository,
    @Optional()
    @Inject(LlmGatewayService)
    private readonly llm: LlmGatewayService | null,
  ) {}

  async getCurrent(
    context: ActorContext,
    projectId: string,
  ): Promise<BriefingPayload> {
    const briefing = await this.briefingRepository.getCurrent(context, projectId);
    return { briefing, is_demo: false };
  }

  async refresh(
    context: ActorContext,
    projectId: string,
  ): Promise<BriefingPayload> {
    const project = await this.briefingRepository.fetchProjectAndOrg(context, projectId);
    if (!project) {
      // No project visible to caller — return whatever current is (likely null).
      return { briefing: null, is_demo: false };
    }
    const memories = await this.briefingRepository.listMemoriesForBriefing(context, projectId, 80);
    if (memories.length === 0) {
      return { briefing: null, is_demo: false };
    }

    let briefingMd: string;
    let model = "manual";
    if (this.llm) {
      const userPrompt = this.buildUserPrompt(memories, project.name);
      // LlmGatewayService API: {generate} or similar — fall back to a
      // plain "no-llm" composition if the call surface differs.
      try {
        const result = await (this.llm as unknown as {
          completeJson?: (system: string, user: string) => Promise<{ briefing_md?: string }>;
        }).completeJson?.(SYSTEM_PROMPT, userPrompt);
        if (result?.briefing_md) {
          briefingMd = result.briefing_md;
          model = "openkt-default";
        } else {
          briefingMd = this.composeFallback(memories, project.name);
        }
      } catch {
        briefingMd = this.composeFallback(memories, project.name);
      }
    } else {
      briefingMd = this.composeFallback(memories, project.name);
    }

    const row = await this.briefingRepository.insertCurrent(context, {
      project_id: projectId,
      org_id: project.org_id,
      generated_by: context.principal.userId ?? null,
      briefing_md: briefingMd,
      model,
      source_memory_count_at_generation: memories.length,
      source_memory_ids: memories.map((m) => m.id),
    });
    return { briefing: row, is_demo: false };
  }

  private buildUserPrompt(
    memories: { content: string; kind: string }[],
    projectName: string,
  ): string {
    const lines = memories.map((m) => {
      const trimmed = m.content.length > 600 ? m.content.slice(0, 600) + "…" : m.content;
      return `- (${m.kind}) ${trimmed}`;
    });
    return `Project: ${projectName}\n\nRecent memories (most recent first, ${memories.length} total):\n\n${lines.join("\n")}\n\nWrite the briefing.`;
  }

  // Deterministic fallback when the LLM gateway isn't wired or fails.
  // Surfaces the most recent N memory titles so the briefing is never
  // an empty box even if the LLM call doesn't land.
  private composeFallback(
    memories: { content: string; kind: string; created_at: string }[],
    projectName: string,
  ): string {
    const top = memories.slice(0, 6).map((m) => {
      const firstLine = (m.content.split(/\r?\n/)[0] ?? "").trim().slice(0, 140);
      return `- (${m.kind}) ${firstLine}`;
    });
    return [
      `**Direction this week** — ${projectName} has ${memories.length} recent memories landing. The LLM briefing pass is offline; the most recent captures are listed below as a stand-in.`,
      "",
      "## What landed",
      "",
      ...top,
      "",
      "## What to brief the next agent on",
      "",
      "> Read the recent memories above before touching code. Re-run the briefing once the LLM gateway is back.",
    ].join("\n");
  }
}
