import { Injectable } from "@nestjs/common";

import { LlmGatewayService, stripPromptBoundary } from "@openkt/platform-llm";

import {
  EnhancedMemorySchema,
  type EnhanceMemoryInput,
  type EnhancedMemoryResult,
  type MemoryKind,
} from "../contracts/memory.contract";

const FALLBACK_KIND: MemoryKind = "context";

@Injectable()
export class MemoryEnhancementService {
  constructor(private readonly llmGatewayService: LlmGatewayService) {}

  async enhance(input: EnhanceMemoryInput): Promise<EnhancedMemoryResult> {
    const content = input.content.trim();
    const existingTags = input.existing_tags.map(normalizeTag).filter(Boolean).slice(0, 8);

    const generated = await this.llmGatewayService.tryGenerateObject({
      messages: [
        {
          role: "system",
          content:
            "You clean up a short project memory for storage. Keep the meaning intact. " +
            "Return concise useful tags and one memory kind. Do not invent facts.",
        },
        {
          role: "user",
          content:
            `<untrusted-content>\nAction: ${input.action}\n` +
            `Existing tags: ${existingTags.join(", ") || "none"}\n` +
            `Memory:\n${stripPromptBoundary(content)}\n</untrusted-content>`,
        },
      ],
      schema: EnhancedMemorySchema,
      maxOutputTokens: 900,
      timeoutMs: 30_000,
    });

    if (generated) {
      return {
        enhanced_content:
          input.action === "tags" ? content : generated.object.enhanced_content.trim(),
        tags: mergeTags(existingTags, generated.object.tags),
        kind: generated.object.kind,
      };
    }

    return {
      enhanced_content: content,
      tags: mergeTags(existingTags, heuristicTags(content)),
      kind: heuristicKind(content),
    };
  }
}

function mergeTags(existing: string[], generated: string[]): string[] {
  return Array.from(new Set([...existing, ...generated.map(normalizeTag).filter(Boolean)])).slice(0, 8);
}

function normalizeTag(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function heuristicKind(content: string): MemoryKind {
  const lower = content.toLowerCase();
  if (lower.includes("decision") || lower.includes("decided")) return "decision";
  if (lower.includes("pattern") || lower.includes("always ")) return "pattern";
  if (lower.includes("incident") || lower.includes("outage") || lower.includes("failed")) return "incident";
  if (lower.includes("debug") || lower.includes("fix")) return "debug-recipe";
  if (lower.includes("env") || lower.includes("api key") || lower.includes("database")) return "environment";
  return FALLBACK_KIND;
}

function heuristicTags(content: string): string[] {
  const lower = content.toLowerCase();
  const candidates = [
    "openkt",
    "backend",
    "frontend",
    "memory",
    "mcp",
    "cli",
    "rabbitmq",
    "supabase",
    "auth",
    "dashboard",
    "llm",
    "embedding",
  ];
  return candidates.filter((tag) => lower.includes(tag)).slice(0, 8);
}
