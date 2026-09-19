import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ActorContext } from "@openkt/core-context";

import type { JoinLinkView } from "../contracts/join-link.contract";
import type { TeamsService } from "../services/teams.service";

// kt_create_team, kt_join_team, kt_invite_link — so a person can set up a
// team and bring people in just by asking Claude, Cowork, ChatGPT or Codex.
// Registered by McpServerFactoryService.

const CreateTeamSchema = z.object({
  name: z.string().min(1).max(120).describe("The team's name, e.g. 'Hackathon crew'."),
});

const JoinTeamSchema = z.object({
  code_or_url: z
    .string()
    .min(1)
    .max(500)
    .describe("The join link someone shared (https://…/join/<code>) or just its code."),
});

const InviteLinkSchema = z.object({
  project: z.string().min(1).max(256).describe("The team space's UUID or slug (from kt_list_projects)."),
  role: z
    .enum(["reader", "editor"])
    .optional()
    .describe("What people who join may do: 'editor' (recall and save, the default) or 'reader' (recall only)."),
});

export function registerTeamTools(server: McpServer, context: ActorContext, teams: TeamsService): void {
  server.registerTool(
    "kt_create_team",
    {
      title: "Create a team",
      description:
        "Create a team: a new shared space the user owns, plus a join link to send to teammates. " +
        "Anyone who opens the link signs in (or signs up) and joins as an editor, then recalls and saves " +
        "in this space. Use when the user asks to start a team, a shared space, or to get people onto OpenKT " +
        "together. Give the user the link to share.",
      inputSchema: CreateTeamSchema.shape,
      annotations: { title: "Create a team", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => {
      const { space, link } = await teams.createTeam(context, input.name);
      return textAndStructured(
        `Created the team "${space.name}" (project_id ${space.id}). Share this link: ${link.url}\n` +
          `Anyone who opens it can sign up and join as an editor${expiry(link)}. ` +
          `Save team context with kt_save_memory(project_id: "${space.id}").`,
        { space, join_link: link },
      );
    },
  );

  server.registerTool(
    "kt_join_team",
    {
      title: "Join a team",
      description:
        "Join a team from a join link someone shared (the whole https://…/join/<code> link or just the code). " +
        "Use when the user pastes such a link or says they were invited. Returns the space's project_id; use it " +
        "with kt_recall and kt_save_memory to work in the team's context.",
      inputSchema: JoinTeamSchema.shape,
      annotations: { title: "Join a team", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      const joined = await teams.join(context, input.code_or_url);
      const can = joined.role === "reader" ? "recall its context" : "recall and save its context";
      return textAndStructured(
        `You are in "${joined.space.name}" as ${joined.role} and can ${can}. ` +
          `Pass project_id "${joined.space.id}" to kt_recall and kt_save_memory.`,
        joined,
      );
    },
  );

  server.registerTool(
    "kt_invite_link",
    {
      title: "Get a team invite link",
      description:
        "Return a join link for a team space the user owns or edits, to send to someone they want to bring in. " +
        "Reuses the user's current link for that role when there is one. Personal spaces cannot be shared by " +
        "link; create a team with kt_create_team instead.",
      inputSchema: InviteLinkSchema.shape,
      annotations: { title: "Get a team invite link", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      const link = await teams.inviteLink(context, input.project, input.role ?? "editor");
      return textAndStructured(
        `Share this link: ${link.url} — people who open it join as ${link.role}${expiry(link)}.`,
        { join_link: link },
      );
    },
  );
}

function expiry(link: JoinLinkView): string {
  const parts: string[] = [];
  if (link.expires_at) parts.push(`until ${link.expires_at.slice(0, 10)}`);
  if (link.max_uses !== null) parts.push(`for ${link.max_uses - link.uses} more people`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

function textAndStructured(text: string, structured: object) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: structured as Record<string, unknown>,
  };
}
