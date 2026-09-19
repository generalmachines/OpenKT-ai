import { z } from "zod";

import type { ActorContext } from "@openkt/core-context";

import type { PagesApplicationService } from "../../pages/services/pages-application.service";

// kt_page (Spec 04 MCP tools): a living page as markdown with its sources. Kept in its own file so
// the tool list in mcp-server-factory.service.ts stays readable.
export const PageToolSchema = z.object({
  page_id: z.string().uuid().optional().describe("The page id (from kt_recall results of type 'section', or the app)."),
  project: z.string().min(1).max(256).optional().describe("Space UUID or slug, with `title`, when you do not have the page id."),
  title: z.string().min(1).max(200).optional().describe("The page title, e.g. 'Northgate — pricing'. Exact match first, then the closest title containing it."),
});

interface ToolServer {
  registerTool(
    name: string,
    config: { title: string; description: string; inputSchema: z.ZodRawShape; annotations: Record<string, unknown> },
    handler: (input: z.infer<typeof PageToolSchema>) => Promise<{ content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown> }>,
  ): unknown;
}

export function registerPageTools(server: ToolServer, pages: PagesApplicationService, context: ActorContext): void {
  server.registerTool(
    "kt_page",
    {
      title: "Read a page",
      description:
        "Read one living page of a space: sections kept current from the team's sessions, every sentence " +
        "citing its sources (who said it, in which session). Pass page_id, or project + title. Prefer this " +
        "over many kt_recall calls when a recall result points at a page.",
      inputSchema: PageToolSchema.shape,
      annotations: { title: "Read a page", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      const { page, markdown } = await pages.pageAsMarkdown(context, input);
      return {
        content: [{ type: "text" as const, text: markdown }],
        structuredContent: { page_id: page.id, title: page.title, version: page.version, sources: page.sources.length },
      };
    },
  );
}
