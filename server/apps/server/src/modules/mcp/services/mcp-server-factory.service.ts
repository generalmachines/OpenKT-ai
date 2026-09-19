import { Injectable } from "@nestjs/common";
import { createUIResource } from "@mcp-ui/server";
import { z } from "zod";

import type { ActorContext } from "@openkt/core-context";

import { BriefingService } from "../../briefing/services/briefing.service";
import {
  CreateMemorySchema,
  DeleteMemoryInputSchema,
  MemorySearchRequestSchema,
  RecallRequestSchema,
} from "../../memory/contracts/memory.contract";
import { MemoryCommandsApplicationService } from "../../memory/services/memory-commands.application.service";
import { MemoryQueriesApplicationService } from "../../memory/services/memory-queries.application.service";
import { MemoryRecallService } from "../../memory/services/memory-recall.service";
import { ProjectScopeService } from "../../projects/services/project-scope.service";
import { ProjectsApplicationService } from "../../projects/services/projects-application.service";
import {
  CloseSessionSchema,
  CreateSessionSchema,
} from "../../sessions/contracts/session.contract";
import { SessionsApplicationService } from "../../sessions/services/sessions-application.service";
import { SKILL_MD, renderSkillText } from "../../skills/services/skill-files";
import { SkillsApplicationService } from "../../skills/services/skills-application.service";
import { McpUiRendererService } from "./mcp-ui-renderer.service";

// The contract every connected tool should follow — kept here (not
// inline in `new McpServer(...)`) so its size is easy to eyeball.
// MCP server `instructions` are shown to the model once per
// connection; some clients truncate long ones, so this stays well
// under the 2KB budget architecture.md §4 sets for it and every tool
// description.
export const SERVER_INSTRUCTIONS = `OpenKT is your team's shared memory: what one person saved should reach a teammate's session, not just yours.

Contract for every session:
1. START — call kt_session_start at the beginning of work. It returns a session_id and a brief for the project. Read the brief before doing anything else.
2. RECALL — call kt_recall(query, session_id) before any non-trivial work: before answering a question, before implementing something that might already have a decided approach, before debugging something that might already have a known cause. A teammate's session may have already solved this.
3. SAVE — call kt_save_memory(content, session_id) at decision points as they happen, not only at the end: a decision made, an incident and its fix, a convention, a gotcha. Small and frequent beats one big dump at close.
4. END — call kt_session_end(session_id, summary) when the work is done. Idle sessions close themselves, but an explicit summary is better than none.

SKILLS — when the user asks to do something "the way we do it", or mentions a team procedure, template or house style, call kt_list_skills and follow the matching skill (kt_get_skill returns it in full).

Passing session_id to kt_recall/kt_save_memory keeps provenance (who learned what, when, from which tool) accurate and keeps the session from being closed as idle mid-work. It is optional — omitting it still saves/recalls, just without that link.

No project bound yet? Call kt_list_projects and ask the user, or omit project_id entirely to use their personal space — nothing is ever dropped for lack of somewhere to put it.`;

// `@modelcontextprotocol/sdk` ships ESM-only (`"type": "module"`). The
// bff is CommonJS; static `require()` of an ESM module only works under
// Node 22.12+ where `require(esm)` is on by default. The package's
// engines field allows Node 20, so we go through dynamic `import()`
// (always supported from CJS) and cache the loaded namespaces — the
// SDK is loaded once on first MCP request, not per-request.
type SdkExports = Awaited<typeof sdkExportsPromise>;
const sdkExportsPromise = (async () => {
  const [{ McpServer }, { StreamableHTTPServerTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/mcp.js"),
    import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
  ]);
  return { McpServer, StreamableHTTPServerTransport };
})();

// Tool naming
// ───────────
// All tools are prefixed `kt_` so they're unambiguous in clients that
// have multiple MCP servers connected (Linear, GitHub, OpenKT). Names
// are verb-noun, descriptions tell the agent *when* to call the tool —
// since we can no longer rely on a SessionStart hook to inject context
// for non-CLI clients (Claude.ai), the recall tool's description does
// the prompting itself.
@Injectable()
export class McpServerFactoryService {
  constructor(
    private readonly memoryCommands: MemoryCommandsApplicationService,
    private readonly memoryQueries: MemoryQueriesApplicationService,
    private readonly memoryRecall: MemoryRecallService,
    private readonly projectsApp: ProjectsApplicationService,
    private readonly projectScope: ProjectScopeService,
    private readonly briefing: BriefingService,
    private readonly ui: McpUiRendererService,
    private readonly sessionsApp: SessionsApplicationService,
    private readonly skillsApp: SkillsApplicationService,
  ) {}

  async sdk(): Promise<SdkExports> {
    return sdkExportsPromise;
  }

  async build(context: ActorContext): Promise<InstanceType<SdkExports["McpServer"]>> {
    const { McpServer } = await sdkExportsPromise;
    const server = new McpServer(
      {
        name: "openkt",
        version: "1.0.0",
      },
      { instructions: SERVER_INSTRUCTIONS },
    );

    // ── kt_recall ───────────────────────────────────────────────────
    server.registerTool(
      "kt_recall",
      {
        title: "Recall project memories",
        description:
          "Search the user's saved project memories for context relevant to a question or task. " +
          "ALWAYS CALL THIS FIRST on any new topic, decision, or task before answering — it " +
          "surfaces prior decisions, incidents, conventions, and gotchas the user already saved. " +
          "\n\n" +
          "PROJECT RESOLUTION (read this if you don't already have a project_id):\n" +
          "• Coding harness with a working directory (Claude Code, Cursor, Codex, OpenCode): the " +
          "host's session-start primer normally injects project_id from a .openkt/manifest.json " +
          "parent-walk. If it didn't, the user isn't bound to a project yet — point them at `kt init`.\n" +
          "• Non-coding harness (Claude.ai web, ChatGPT, Slack, etc.) on first connection: call " +
          "kt_list_projects, ask the user which one to use, THEN call this tool with the chosen " +
          "project_id. Cache the choice for the rest of the conversation.\n" +
          "\n" +
          "Cheap and idempotent: bumps a per-memory recall counter but does not modify content. " +
          "Returns hybrid (vector + keyword) ranked memories with kind, content, tags, importance. " +
          "Pass session_id from kt_session_start to keep the session's activity fresh.",
        inputSchema: RecallRequestSchema.shape,
        annotations: {
          title: "Recall project memories",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      async (input, extra) => {
        // Progressive UI: send notifications/progress while the recall
        // pipeline runs so hosts that support MCP progress (Claude.ai,
        // Claude Code, Cursor) show a live "Thinking…" line. Falls back
        // silently if the host hasn't passed a progressToken.
        await notifyProgress(extra, 0.1, "Embedding query…");
        const result = await this.memoryRecall.recall(context, input);
        await notifyProgress(extra, 0.7, "Ranking memories…");
        const ui = this.ui.renderRecall(result as never, input.query ?? "");
        await notifyProgress(extra, 1, "Done");
        return jsonAndUi(result, ui, "openkt/recall");
      },
    );

    // ── kt_save_memory ──────────────────────────────────────────────
    server.registerTool(
      "kt_save_memory",
      {
        title: "Save a project memory",
        description:
          "Persist a non-obvious fact, decision, incident, pattern, or anti-pattern as a " +
          "project memory so future sessions (and other team members) can recall it. " +
          "Save proactively when you learn something the next agent should know: " +
          "kind=decision (we chose X over Y because Z), incident (symptom S was caused by C; fix is F), " +
          "pattern (the right way to do P is Q), anti-pattern (don't do X without Y), " +
          "context (background fact), skill (how to do X). " +
          "\n\n" +
          "Same project-resolution rule as kt_recall: in coding harnesses the host injects " +
          "project_id; in non-coding harnesses, call kt_list_projects first, confirm with the " +
          "user, then pass the chosen project_id here. Triggers the async embedding + " +
          "deduplication pipeline through the outbox. Pass session_id from kt_session_start " +
          "so the memory is attributed to this session and to its connector.",
        inputSchema: CreateMemorySchema.shape,
        annotations: {
          title: "Save a project memory",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
        },
      },
      async (input) => {
        const result = await this.memoryCommands.create(context, input);
        const ui = this.ui.renderSaved(result as never);
        return jsonAndUi(result, ui, "openkt/saved");
      },
    );

    // ── kt_search_memories ──────────────────────────────────────────
    server.registerTool(
      "kt_search_memories",
      {
        title: "Search memories (no recall side-effects)",
        description:
          "Browse or filter memories across one or more projects by query, kind, or tag without " +
          "bumping recall counters. Use this for listing/browsing UX — when the user asks " +
          "\"what memories do I have about X\" or you need to enumerate before deciding. " +
          "Prefer kt_recall when you need context to answer a question.",
        inputSchema: MemorySearchRequestSchema.shape,
        annotations: {
          title: "Search memories",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      async (input) => {
        const result = await this.memoryQueries.search(context, input);
        const ui = this.ui.renderRecall(result as never, input.query ?? "search");
        return jsonAndUi(result, ui, "openkt/search");
      },
    );

    // ── kt_forget_memory ────────────────────────────────────────────
    server.registerTool(
      "kt_forget_memory",
      {
        title: "Forget (archive or hard-delete) a memory",
        description:
          "Archive a memory by id (default: soft, recoverable) or hard-delete it (owner-only, " +
          "irreversible). Use when the user explicitly asks to forget something or when a " +
          "memory is clearly obsolete. Always prefer soft archive over hard delete.",
        inputSchema: DeleteMemoryInputSchema.shape,
        annotations: {
          title: "Forget a memory",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
        },
      },
      async (input) => {
        const result = await this.memoryCommands.forget(context, input);
        return jsonResult(result);
      },
    );

    // ── kt_list_projects ────────────────────────────────────────────
    server.registerTool(
      "kt_list_projects",
      {
        title: "List projects the user has access to",
        description:
          "List the OpenKT projects the current user can read. " +
          "\n\n" +
          "WHEN TO CALL:\n" +
          "• Non-coding harness (Claude.ai web, ChatGPT, Slack) — call this FIRST on every new " +
          "conversation to find the right project_id, then ask the user to confirm which one " +
          "before reading or writing memories. Cache the choice for the conversation.\n" +
          "• Coding harness without a bound project — fall back to this when the host's primer " +
          "didn't supply a project_id (i.e. cwd has no .openkt/manifest.json).\n" +
          "\n" +
          "Returns project_id, slug, name, org, role, and visibility. Use the result to populate " +
          "the project_id argument on kt_recall / kt_save_memory / kt_project_brief.",
        inputSchema: ListProjectsSchema.shape,
        annotations: {
          title: "List accessible projects",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      async (input) => {
        const filters: Record<string, string> = {};
        if (input.org_id) filters.orgId = input.org_id;
        if (input.visibility) filters.visibility = input.visibility;
        const rows = await this.projectsApp.listVisible(
          context,
          filters as Parameters<typeof this.projectsApp.listVisible>[1],
        );
        const payload = { count: rows.length, projects: rows };
        const ui = this.ui.renderProjectList(payload as never);
        return jsonAndUi(payload, ui, "openkt/projects");
      },
    );

    // ── kt_project_brief ────────────────────────────────────────────
    server.registerTool(
      "kt_project_brief",
      {
        title: "Get a project's auto-generated brief",
        description:
          "Fetch the auto-maintained brief for a project: scope, conventions, recent activity, " +
          "active people, key decisions. Call this at session start (or when switching projects) " +
          "to ground yourself before answering domain questions. " +
          "\n\n" +
          "Accepts project_id (UUID) OR project_slug — pass exactly one. If you have neither " +
          "(typical for non-coding harnesses on first connection), call kt_list_projects first " +
          "and ask the user which project the conversation is about. " +
          "Recommended flow for non-coding harnesses: kt_list_projects → user picks → " +
          "kt_project_brief on the chosen project → kt_recall on subsequent prompts.",
        inputSchema: ProjectBriefSchema.shape,
        annotations: {
          title: "Get project brief",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      async (input) => {
        const projectId = await this.resolveProjectId(context, input);
        const result = await this.briefing.getBriefing(context, projectId);
        const ui = this.ui.renderProjectBrief(result as never);
        return jsonAndUi(result, ui, "openkt/brief");
      },
    );

    // ── kt_session_start ──────────────────────────────────────────
    // M1/M3 "Session lifecycle over MCP" (architecture.md §4). Opens a
    // T0 session and returns its id together with the project brief in
    // one round-trip, so a client only needs one tool call to go from
    // "nothing" to "warm and ready to work".
    server.registerTool(
      "kt_session_start",
      {
        title: "Start a session",
        description:
          "Open a session at the beginning of work — call this FIRST, before kt_recall or " +
          "kt_save_memory. Returns session_id (pass it to every kt_recall/kt_save_memory/" +
          "kt_session_end call in this conversation) and the project's brief, so you start " +
          "warm instead of cold. " +
          "\n\n" +
          "Same project-resolution rule as kt_recall: omit project to use the user's personal " +
          "space, or pass the project_id/slug the host already bound. Sessions close themselves " +
          "after a period of inactivity even if you forget to call kt_session_end.",
        inputSchema: StartSessionSchema.shape,
        annotations: {
          title: "Start a session",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
        },
      },
      async (input) => {
        const session = await this.sessionsApp.start(context, {
          project_id: input.project ?? undefined,
          source: input.source ?? "mcp",
          client: input.client ?? null,
          title: input.title ?? null,
          metadata: {},
        });
        const brief = await this.briefing
          .getBriefing(context, session.project_id)
          .catch(() => null);
        return jsonResult({ session, brief });
      },
    );

    // ── kt_session_end ────────────────────────────────────────────
    server.registerTool(
      "kt_session_end",
      {
        title: "End a session",
        description:
          "Close a session with your own summary of what happened — call this when the work " +
          "is done or the conversation is ending. A good summary is a few sentences: what was " +
          "asked, what changed, what's left open. Idle sessions close automatically, but an " +
          "explicit summary is more useful than an idle-timeout placeholder.",
        inputSchema: CloseSessionToolSchema.shape,
        annotations: {
          title: "End a session",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      async (input) => {
        const session = await this.sessionsApp.close(context, input.session_id, {
          summary: input.summary ?? null,
        });
        return jsonResult({ session });
      },
    );

    // ── kt_list_skills ────────────────────────────────────────────
    // Skills: the team's written procedures — a SKILL.md plus optional
    // reference files, versioned and granted like a space.
    server.registerTool(
      "kt_list_skills",
      {
        title: "List the team's skills",
        description:
          "List the skills the user can use: written, versioned team procedures (\"how we sharpen a " +
          "marketing message\", \"how we cut a release\"). Call this when the user asks to do something " +
          "\"the way we do it\", mentions a team procedure, template or house style, or asks what skills " +
          "exist. Then call kt_get_skill on the one that matches and follow it. Read-only.",
        inputSchema: ListSkillsToolSchema.shape,
        annotations: {
          title: "List the team's skills",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      async (input) => {
        const skills = await this.skillsApp.list(context, {
          project_id: input.project ?? undefined,
          q: input.q ?? undefined,
          archived: false,
        });
        const lines = skills.map(
          (s, i) =>
            `${i + 1}. ${s.title} (${s.slug}) — ${s.description} — ${s.space_name ?? (s.project_id ? "shared with you" : "personal")}`,
        );
        const text = skills.length
          ? `${lines.join("\n")}\n\nCall kt_get_skill with a skill's name (in brackets) to read it in full.`
          : "No skills yet in the spaces you can read. kt_save_skill creates one.";
        return textAndStructured(text, { count: skills.length, skills });
      },
    );

    // ── kt_get_skill ──────────────────────────────────────────────
    server.registerTool(
      "kt_get_skill",
      {
        title: "Read a skill",
        description:
          "Return one skill in full: its SKILL.md, then every other file under a `--- <path> ---` " +
          "header. Follow what it says for the task at hand. `skill` is the id or the name from " +
          "kt_list_skills; pass `project` when two spaces have a skill with the same name. " +
          "Counts as one use of the skill.",
        inputSchema: GetSkillToolSchema.shape,
        annotations: {
          title: "Read a skill",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
        },
      },
      async (input) => {
        const id = await this.skillsApp.resolveId(context, input.skill, input.project ?? undefined);
        const run = await this.skillsApp.recordRun(context, id, "mcp");
        return textAndStructured(renderSkillText(run.files), run);
      },
    );

    // ── kt_save_skill ─────────────────────────────────────────────
    server.registerTool(
      "kt_save_skill",
      {
        title: "Save a skill",
        description:
          "Create a skill, or save a new version of an existing one (pass `skill`). `skill_md` is the " +
          "whole SKILL.md: YAML frontmatter with `name` (lowercase-kebab, at most 64 characters) and " +
          "`description` (what it does and when to use it, at most 1024), then the markdown " +
          "instructions. Use when the user asks to write down a procedure so the team and their tools " +
          "can reuse it. Omit `project` for a personal skill. Updating needs edit access; every save is " +
          "a new version and the skill's other files are kept.",
        inputSchema: SaveSkillToolSchema.shape,
        annotations: {
          title: "Save a skill",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
        },
      },
      async (input) => {
        let saved;
        if (input.skill) {
          const id = await this.skillsApp.resolveId(context, input.skill, input.project ?? undefined);
          const current = await this.skillsApp.get(context, id);
          saved = await this.skillsApp.saveVersion(context, id, {
            files: [
              { path: SKILL_MD, content: input.skill_md },
              ...current.files.filter((f) => f.path !== SKILL_MD).map((f) => ({ path: f.path, content: f.content })),
            ],
            title: input.title,
            change_note: input.change_note ?? null,
            base_version: current.current_version,
          });
        } else {
          saved = await this.skillsApp.create(context, {
            title: input.title,
            project_id: input.project ?? null,
            skill_md: input.skill_md,
            change_note: input.change_note ?? null,
          });
        }
        const { files: _files, versions: _versions, ...skill } = saved;
        return textAndStructured(
          `Saved "${saved.title}" (${saved.slug}) as version ${saved.current_version} — ` +
            `${saved.space_name ?? (saved.project_id ? "in a shared space" : "personal to you")}.`,
          { skill },
        );
      },
    );

    // ── kt_setup ────────────────────────────────────────────────────
    // Returns setup guidance as plain text. No sign-in flow and no
    // token minting happens here — reaching this tool already required
    // a valid bearer, and tokens are issued by POST /v1/me/tokens.
    server.registerTool(
      "kt_setup",
      {
        title: "Setup guidance",
        description:
          "Return paste-able steps for connecting an AI tool to this OpenKT server. " +
          "Call this when the user asks how to set OpenKT up in another client.",
        inputSchema: z.object({
          client: z
            .string()
            .max(100)
            .optional()
            .describe("The client being set up, e.g. 'claude-code', 'cursor', 'claude.ai'."),
        }).shape,
        annotations: {
          title: "Setup guidance",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      async (input) => textResult(setupGuidance(input.client)),
    );

    return server;
  }

  private async resolveProjectId(
    context: ActorContext,
    input: { project_id?: string | null; project_slug?: string | null },
  ): Promise<string> {
    if (input.project_id) return input.project_id;
    if (input.project_slug) {
      // resolveProjectIdOrSlug accepts either; we pass slug explicitly so
      // the caller can't smuggle a UUID through the slug field.
      return this.projectScope.resolveProjectIdOrSlug(context, input.project_slug);
    }
    // Fall back to the caller's personal project — same default as the CLI.
    return this.projectScope.resolvePersonalProjectId(context);
  }
}

const ListProjectsSchema = z.object({
  org_id: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe("Optional: scope the listing to a single org."),
  visibility: z
    .enum(["personal", "project", "org"])
    .nullable()
    .optional()
    .describe("Optional: filter by visibility."),
});

const ProjectBriefSchema = z.object({
  project_id: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe("Project UUID. Pass either project_id or project_slug, not both."),
  project_slug: z
    .string()
    .min(1)
    .max(120)
    .nullable()
    .optional()
    .describe(
      "Project slug (e.g. 'openkt-server'). If neither id nor slug is given, falls back to the user's personal project.",
    ),
});

const StartSessionSchema = z.object({
  project: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe(
      "Project UUID or slug to file this session under. Omit to use the user's personal space.",
    ),
  title: z.string().max(200).optional().describe("Optional short title for this session."),
  source: z
    .enum([
      "claude-code",
      "chatgpt",
      "claude",
      "mcp",
      "voice",
      "meeting",
      "screenshot",
      "note",
      "connector",
    ])
    .optional()
    .describe("The connector opening this session. Defaults to 'mcp'."),
  client: z.string().max(120).optional().describe("Free-text client identifier, e.g. 'claude-code/1.2.0'."),
});

const CloseSessionToolSchema = z.object({
  session_id: z.string().uuid().describe("The session_id returned by kt_session_start."),
  summary: z
    .string()
    .max(20_000)
    .optional()
    .describe("A few sentences: what was asked, what changed, what's left open."),
});

const ListSkillsToolSchema = z.object({
  project: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe("Space UUID or slug to list skills from. Omit to list every skill the user can use."),
  q: z.string().max(200).optional().describe("Optional words to match in the skill's title, name or description."),
});

const GetSkillToolSchema = z.object({
  skill: z.string().min(1).max(200).describe("The skill's id, or its name (the slug shown by kt_list_skills)."),
  project: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe("Space UUID or slug — only needed when two spaces hold a skill with the same name."),
});

const SaveSkillToolSchema = z.object({
  title: z.string().min(1).max(200).describe("The skill's human title, e.g. 'Sharpen a marketing message'."),
  skill_md: z
    .string()
    .min(1)
    .describe("The whole SKILL.md: `---` frontmatter with name and description, then the markdown body."),
  project: z.string().min(1).max(256).optional().describe("Space UUID or slug to file a NEW skill in. Omit for personal."),
  skill: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Id or name of an existing skill to save a new version of. Omit to create a new skill."),
  change_note: z.string().max(500).optional().describe("One line on what changed, shown in the version history."),
});

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// A text block a model can use on its own, plus the same facts as data.
function textAndStructured(text: string, structured: object) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: structured as Record<string, unknown>,
  };
}

function setupGuidance(client?: string): string {
  const target = client?.trim() ? client.trim() : "your AI tool";
  return [
    `Connecting ${target} to OpenKT:`,
    "1. Add a remote MCP server (Streamable HTTP) pointing at <your OpenKT server URL>/mcp.",
    "2. Authenticate. Clients that support OAuth sign in through the browser when they first connect. " +
      "Otherwise create a personal access token (POST /v1/me/tokens) and send it as " +
      "`Authorization: Bearer okt_pat_…`.",
    "3. Check the connection by calling kt_list_projects — it lists the spaces you can read and write.",
    "4. Then work as the server instructions describe: kt_session_start at the start of work, " +
      "kt_recall before non-trivial work, kt_save_memory when something durable is settled, " +
      "kt_session_end when the work ends.",
  ].join("\n");
}

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

// Combine the JSON payload (so the agent can reason about the result)
// with an inline HTML UI resource (so MCP-UI-capable hosts render a
// rich card). MimeType is `text/html` per the MCP Apps spec; the host
// sandboxes the iframe and discards the resource if it can't render.
function jsonAndUi(value: unknown, htmlString: string, uriNamespace: string) {
  const ui = createUIResource({
    uri: `ui://${uriNamespace}/${randomShortId()}`,
    content: { type: "rawHtml", htmlString },
    encoding: "text",
  });
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(value, null, 2) },
      ui,
    ],
  };
}

// MCP progress notifications. The SDK exposes a `sendNotification`
// helper on the tool-handler `extra` arg; we wrap it so a missing
// progressToken silently no-ops (hosts that don't request progress
// shouldn't see any side effects).
async function notifyProgress(
  extra: unknown,
  progress: number,
  message: string,
): Promise<void> {
  const params = extra as
    | {
        _meta?: { progressToken?: string | number };
        sendNotification?: (n: {
          method: string;
          params: { progressToken: string | number; progress: number; message?: string };
        }) => Promise<void>;
      }
    | undefined;
  const token = params?._meta?.progressToken;
  if (!token || !params?.sendNotification) return;
  try {
    await params.sendNotification({
      method: "notifications/progress",
      params: { progressToken: token, progress, message },
    });
  } catch {
    // Best-effort — the client may have already moved on.
  }
}

function randomShortId(): string {
  return Math.random().toString(36).slice(2, 10);
}
