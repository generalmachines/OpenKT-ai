import { randomUUID } from "node:crypto";

import { Logger } from "@nestjs/common";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ActorContext } from "@openkt/core-context";
import type { ProjectRecord } from "@openkt/data-repositories";

import {
  CreateMemorySchema,
  MemorySearchRequestSchema,
  RecallRequestSchema,
  type MemoryKind,
  type MemoryRecord,
} from "../../memory/contracts/memory.contract";
import type { MemoryCommandsApplicationService } from "../../memory/services/memory-commands.application.service";
import type { MemoryQueriesApplicationService } from "../../memory/services/memory-queries.application.service";
import type { MemoryRecallService } from "../../memory/services/memory-recall.service";
import type { ProjectScopeService } from "../../projects/services/project-scope.service";
import type { ProjectsApplicationService } from "../../projects/services/projects-application.service";
import type { SessionsApplicationService } from "../../sessions/services/sessions-application.service";
import { CARDS_URI, MCP_APP_MIME_TYPE, cardToolMeta, loadCardsHtml } from "./mcp-apps";

// The MCP Apps card tools of Spec 04 ("Card tools"), registered only for
// clients that advertise the `io.modelcontextprotocol/ui` extension (see
// mcp-apps.ts for the negotiation and the spec references):
//
//   kt_save_card     model  → the save card: the draft + the spaces the caller can write to. Writes nothing.
//   kt_search_card   model  → the results card.
//   kt_session_card  model  → the session summary card.
//   kt_commit_save   app    → performs the save the person confirmed in the card.
//   kt_mark_used     app    → records that the person used a recalled item.
//
// App-only tools are hidden from the model by the host, but the server still
// authorises every call: kt_commit_save goes through the same write-access
// check as kt_save_memory, whatever the card offered.

export interface CardToolDeps {
  memoryCommands: MemoryCommandsApplicationService;
  memoryQueries: MemoryQueriesApplicationService;
  memoryRecall: MemoryRecallService;
  projectsApp: ProjectsApplicationService;
  projectScope: ProjectScopeService;
  sessionsApp: SessionsApplicationService;
}

const logger = new Logger("McpCardTools");

// Product kinds (what people and the cards say) → the kinds the memory store keeps.
const KIND_ALIASES: Record<string, MemoryKind> = {
  decision: "decision",
  fact: "fact",
  "how-to": "pattern",
  howto: "pattern",
  issue: "incident",
  question: "note",
  action: "note",
  idea: "note",
};
export function toMemoryKind(kind: string | undefined): MemoryKind {
  const k = (kind ?? "").trim().toLowerCase();
  if (!k) return "fact";
  if (KIND_ALIASES[k]) return KIND_ALIASES[k]!;
  const parsed = CreateMemorySchema.shape.kind.safeParse(k);
  return parsed.success ? parsed.data : "note";
}

const Kind = z.string().max(40).optional().describe("decision, fact, how-to, issue, question, action or idea. Default fact.");

const SaveCardSchema = z.object({
  content: z.string().min(1).max(20_000).describe("The statement to save: one short, self-contained sentence or two."),
  kind: Kind,
  suggested_project: z
    .string()
    .max(256)
    .optional()
    .describe("Space id or slug to preselect, when the conversation already points at one."),
  session_id: z.string().uuid().optional().describe("The session_id from kt_session_start."),
});

const SearchCardSchema = z.object({
  query: z.string().min(1).max(2_000).describe("What to look for."),
  project: z.string().max(256).optional().describe("Space id or slug. Omit to search every space the user can read."),
});

const SessionCardSchema = z.object({
  session_id: z.string().uuid().describe("The session_id from kt_session_start."),
});

const CommitSaveSchema = z.object({
  content: z.string().min(1).max(20_000).optional(),
  statement: z.string().min(1).max(20_000).optional(),
  kind: Kind,
  visibility: z.enum(["personal", "project"]).optional(),
  project: z.string().max(256).optional(),
  project_id: z.string().max(256).optional(),
  session_id: z.string().uuid().optional(),
  draft_id: z.string().max(200).optional(),
});

const MarkUsedSchema = z.object({
  id: z.string().uuid().describe("The memory the user used."),
  recall_id: z.string().max(200).optional(),
});

type Space = { id: string; name: string; slug: string; role: string; accessLabel: string };

export function registerCardTools(server: McpServer, context: ActorContext, deps: CardToolDeps): boolean {
  const html = loadCardsHtml();
  if (!html) {
    logger.warn("[mcp] cards bundle not found (packages/mcp-cards/dist/openkt-cards.html) — card tools not registered");
    return false;
  }

  server.registerResource(
    "OpenKT cards",
    CARDS_URI,
    {
      title: "OpenKT cards",
      description: "Save, search results and session summary cards (MCP Apps).",
      mimeType: MCP_APP_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: CARDS_URI,
          mimeType: MCP_APP_MIME_TYPE,
          text: html,
          // The card draws its own border and radius. No csp/domain: it makes no requests.
          _meta: { ui: { prefersBorder: false } },
        },
      ],
    }),
  );

  // ── kt_save_card ────────────────────────────────────────────────
  server.registerTool(
    "kt_save_card",
    {
      title: "Save to OpenKT (card)",
      description:
        "Show the user a card to confirm a statement and pick the space it is saved to. Use it in chat " +
        "clients when something durable was settled (a decision, fact, how-to, issue, question, action or " +
        "idea) and the space is not already settled. Nothing is saved until the user confirms in the card; " +
        "do not also call kt_save_memory for the same statement.",
      inputSchema: SaveCardSchema.shape,
      annotations: { title: "Save to OpenKT (card)", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      _meta: cardToolMeta(["model", "app"]),
    },
    async (input) => {
      const { spaces, personalId } = await writableSpaces(context, deps);
      const suggested = input.suggested_project
        ? spaces.find((s) => s.id === input.suggested_project || s.slug === input.suggested_project)
        : undefined;
      const kind = (input.kind ?? "fact").trim().toLowerCase() || "fact";
      const structured = {
        view: "save",
        statement: input.content,
        kind,
        draft: { content: input.content, kind, ...(input.session_id ? { session_id: input.session_id } : {}) },
        spaces: spaces.map((s) => ({
          id: s.id,
          name: s.name,
          label: s.name,
          access_label: s.accessLabel,
          sublabel: s.accessLabel,
          role: s.role,
          writable: true,
        })),
        default_space_id: suggested?.id ?? null,
        suggested_space_id: suggested?.id ?? null,
        personal: { label: "Only me", sublabel: "your personal space", project: personalId },
      };
      const choices = spaces.length ? `Spaces offered: ${spaces.map((s) => s.name).join(", ")}, or Only me.` : "Offered: Only me.";
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Draft shown to the user in a card: "${input.content}" (${kind}). NOT saved yet. ` +
              `Wait for the user to confirm the space in the card. ${choices}`,
          },
        ],
        structuredContent: structured,
      };
    },
  );

  // ── kt_search_card ──────────────────────────────────────────────
  server.registerTool(
    "kt_search_card",
    {
      title: "Search OpenKT (card)",
      description:
        "Search what the team already knows and show the results as a card the user can pick from. Use it " +
        "when the user asks what the team knows about something. For your own context before working, " +
        "kt_recall is enough.",
      inputSchema: SearchCardSchema.shape,
      annotations: { title: "Search OpenKT (card)", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      _meta: cardToolMeta(["model", "app"]),
    },
    async (input) => {
      const recallId = randomUUID();
      let rows: MemoryRecord[];
      let spaceLabel: string | null = null;
      if (input.project) {
        const projectId = await deps.projectScope.resolveProjectIdOrSlug(context, input.project);
        const result = await deps.memoryRecall.recall(
          context,
          RecallRequestSchema.parse({ query: input.query, project_id: projectId, invocation_id: recallId, limit: 10 }),
        );
        rows = result.data;
        spaceLabel = rows[0]?.project.name ?? (await spaceName(context, deps, projectId));
      } else {
        // No project: every space the caller can read and every session granted to them.
        const result = await deps.memoryQueries.search(
          context,
          MemorySearchRequestSchema.parse({ query: input.query, limit: 10 }),
        );
        rows = result.data;
      }
      const items = rows.map((m) => ({
        id: m.id,
        kind: m.kind,
        content: m.content,
        author: m.owner.display_name ?? m.owner.email ?? null,
        source: m.source,
        date: m.created_at,
        space: m.project.name,
      }));
      const text = items.length
        ? items
            .map(
              (it, i) =>
                `${i + 1}. [${it.kind}] ${it.content} — ${[it.author, it.source, it.date?.slice(0, 10), it.space].filter(Boolean).join(", ")} (id ${it.id})`,
            )
            .join("\n") + `\nrecall_id: ${recallId}`
        : "Nothing relevant in the spaces you can read.";
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: {
          view: "search",
          query: input.query,
          space_label: spaceLabel,
          items,
          total: items.length,
          recall_id: recallId,
        },
      };
    },
  );

  // ── kt_session_card ─────────────────────────────────────────────
  server.registerTool(
    "kt_session_card",
    {
      title: "Session summary (card)",
      description:
        "Show a card summarising an OpenKT session: its title, summary and what was saved in it. Use it " +
        "after kt_session_end, or when the user asks what a session kept.",
      inputSchema: SessionCardSchema.shape,
      annotations: { title: "Session summary (card)", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      _meta: cardToolMeta(["model", "app"]),
    },
    async (input) => {
      const { session, memories } = await deps.sessionsApp.get(context, input.session_id);
      const space = memories[0]?.project.name ?? (await spaceName(context, deps, session.project_id));
      const facts = memories.map((m) => ({ id: m.id, kind: m.kind, content: m.content }));
      const accessLabel = space ? `filed in ${space}` : null;
      const text =
        `${session.title ?? "Untitled session"} — ${session.status}, filed in ${space ?? "a space you can read"}. ` +
        `${facts.length} item${facts.length === 1 ? "" : "s"} kept.` +
        (session.summary ? `\nSummary: ${session.summary}` : "") +
        (facts.length ? "\n" + facts.map((f, i) => `${i + 1}. [${f.kind}] ${f.content}`).join("\n") : "");
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: {
          view: "session",
          title: session.title,
          summary: session.summary,
          facts,
          space,
          access_label: accessLabel,
          session: {
            id: session.id,
            title: session.title,
            status: session.status,
            space: space ? { label: space } : null,
            started_at: session.started_at,
            ended_at: session.ended_at,
          },
          counts: { saved: facts.length },
        },
      };
    },
  );

  // ── kt_commit_save (app only) ───────────────────────────────────
  server.registerTool(
    "kt_commit_save",
    {
      title: "Save (from the card)",
      description:
        "Called by the OpenKT save card when the user confirms. Saves the statement to the chosen space " +
        "(or to the personal space) after checking the user can write there.",
      inputSchema: CommitSaveSchema.shape,
      annotations: { title: "Save (from the card)", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      _meta: cardToolMeta(["app"]),
    },
    async (input) => {
      const content = (input.content ?? input.statement ?? "").trim();
      if (!content) return errorResult("Nothing to save: the statement is empty.");
      const target = input.project ?? input.project_id;
      const personal = input.visibility === "personal" || target === "personal";
      const projectId = target && target !== "personal" ? target : undefined;
      const base = {
        content,
        kind: toMemoryKind(input.kind),
        project_id: projectId,
        visibility: personal ? ("personal" as const) : ("project" as const),
      };

      const attempt = (withSession: boolean) =>
        deps.memoryCommands.create(
          context,
          CreateMemorySchema.parse({ ...base, ...(withSession && input.session_id ? { session_id: input.session_id } : {}) }),
        );
      let saved: Awaited<ReturnType<typeof attempt>>;
      try {
        saved = await attempt(true);
      } catch (error) {
        // The session was opened in another space than the one picked in the
        // card: keep the save, drop the session link.
        if (!(input.session_id && /session/i.test(errorMessage(error)))) return errorResult(friendlySaveError(error));
        try {
          saved = await attempt(false);
        } catch (retryError) {
          return errorResult(friendlySaveError(retryError));
        }
      }
      if (!("id" in saved)) return errorResult(`Not saved: ${saved.reason}`);
      const where = personal ? "your personal space (only you)" : saved.project.name;
      return {
        content: [{ type: "text" as const, text: `Saved to ${where}: "${saved.content}" (${saved.kind}, id ${saved.id}).` }],
        structuredContent: {
          id: saved.id,
          space: { id: saved.project.id, name: saved.project.name },
          visibility: saved.visibility,
        },
      };
    },
  );

  // ── kt_mark_used (app only) ─────────────────────────────────────
  server.registerTool(
    "kt_mark_used",
    {
      title: "Mark a result as used (from the card)",
      description:
        "Called by the OpenKT results card when the user picks a recalled item. Records that the item was " +
        "used, in the item's access history.",
      inputSchema: MarkUsedSchema.shape,
      annotations: { title: "Mark as used", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      _meta: cardToolMeta(["app"]),
    },
    async (input) => {
      // get() checks read access and records the access.
      const memory = await deps.memoryQueries.get(context, input.id);
      return {
        content: [{ type: "text" as const, text: `Noted: the user used "${memory.content}" (id ${memory.id}).` }],
        structuredContent: { ok: true, id: memory.id, recall_id: input.recall_id ?? null },
      };
    },
  );

  return true;
}

// Spaces the caller can write to, other than their personal space (the card
// shows that one as "Only me"). Never readers.
async function writableSpaces(
  context: ActorContext,
  deps: CardToolDeps,
): Promise<{ spaces: Space[]; personalId: string }> {
  const personalId = await deps.projectScope.resolvePersonalProjectId(context);
  const visible = await deps.projectsApp.listVisible(context, {});
  const checked = await Promise.all(
    visible
      .filter((p) => p.id !== personalId)
      .map(async (p: ProjectRecord) => {
        try {
          const access = await deps.projectScope.requireProjectAccess(context, p.id, "write");
          const mine = access.role === "owner";
          return {
            id: p.id,
            name: p.name,
            slug: p.slug,
            role: mine ? "owner" : "editor",
            accessLabel: mine ? "your space · people you share it with can read" : "shared with you · its members can read",
          } satisfies Space;
        } catch {
          return null;
        }
      }),
  );
  return { spaces: checked.filter((s): s is Space => s !== null), personalId };
}

async function spaceName(context: ActorContext, deps: CardToolDeps, projectId: string): Promise<string | null> {
  const visible = await deps.projectsApp.listVisible(context, {}).catch(() => [] as ProjectRecord[]);
  return visible.find((p) => p.id === projectId)?.name ?? null;
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

function friendlySaveError(error: unknown): string {
  const message = errorMessage(error);
  if (/duplicate/i.test(message)) return "Already saved: that space has this statement.";
  if (/not found|forbidden|access/i.test(message)) return "Not saved: you cannot write to that space.";
  return `Not saved: ${message || "the server refused the save."}`;
}
