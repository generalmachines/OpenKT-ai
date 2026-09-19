import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";

import type { ActorContext } from "@openkt/core-context";
import { NotFoundDomainError, ValidationDomainError } from "@openkt/core-errors";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { refuseSecrets } from "../../../common/secrets/refuse-secrets";
import { JobQueueRepository, type ProcessingSummary } from "../../jobs/repositories/job-queue.repository";
import { citedIds } from "../../jobs/rules/living-rules";
import { ProjectScopeService } from "../../projects/services/project-scope.service";
import type { EditSectionInput } from "../contracts/page.contract";
import { PageRepository, type PageListItem } from "../repositories/page.repository";
import { pageMarkdown, renderPage, type RenderedPage } from "./page-render";

/**
 * Pages and briefs as people and tools read them (Spec 04 "Spaces, pages, briefs"). A page is
 * readable by anyone who can read its space; someone who cannot gets 404 on every route. Editing a
 * section needs write access to the space; a reader gets 403 insufficient_role (they can already
 * see the page, so nothing leaks).
 */
@Injectable()
export class PagesApplicationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly pages: PageRepository,
    private readonly jobs: JobQueueRepository,
    private readonly projectScope: ProjectScopeService,
  ) {}

  async list(context: ActorContext, rawProjectId: string): Promise<{ pages: PageListItem[]; processing: ProcessingSummary }> {
    const projectId = await this.projectScope.resolveProjectIdOrSlug(context, rawProjectId);
    await this.projectScope.requireProjectAccess(context, projectId, "read");
    const [pages, processing] = await Promise.all([this.pages.listByProject(projectId), this.jobs.processingSummary(projectId)]);
    return { pages, processing };
  }

  async get(context: ActorContext, pageId: string): Promise<RenderedPage> {
    const page = await this.pages.findPage(pageId);
    if (!page || page.status !== "active") throw new NotFoundDomainError("page");
    await this.readable(context, page.project_id, "page");
    const sections = await this.pages.sectionsOf([page.id]);
    const facts = await this.pages.factsByIds([...new Set(sections.flatMap((s) => citedIds(s.body_md)))]);
    // Only facts of this space that are not personal are shown; anything else renders as nothing.
    const shown = facts.filter((f) => f.project_id === page.project_id && f.visibility !== "personal");
    const userId = context.principal.userId;
    return renderPage(page, sections, shown, (s) => s.project_id === page.project_id || s.owner.id === userId);
  }

  async revisions(context: ActorContext, pageId: string) {
    const page = await this.pages.findPage(pageId);
    if (!page) throw new NotFoundDomainError("page");
    await this.readable(context, page.project_id, "page");
    return this.pages.revisions(page.id);
  }

  async editSection(context: ActorContext, pageId: string, sectionId: string, input: EditSectionInput): Promise<RenderedPage> {
    const page = await this.pages.findPage(pageId);
    if (!page || page.status !== "active") throw new NotFoundDomainError("page");
    await this.readable(context, page.project_id, "page");
    try {
      await this.projectScope.requireProjectAccess(context, page.project_id, "write");
    } catch (err) {
      if (err instanceof NotFoundDomainError) {
        throw new ForbiddenException({ code: "insufficient_role", message: "Editing a page needs editor access to its space." });
      }
      throw err;
    }
    refuseSecrets("section", input.body_md, input.heading);
    const userId = context.principal.userId!;
    await this.db.transaction(async (tx) => {
      const section = (await this.pages.sectionsOf([page.id], tx)).find((s) => s.id === sectionId);
      if (!section) throw new NotFoundDomainError("section");
      const ids = citedIds(input.body_md);
      const citable = new Set<string>();
      if (ids.length) {
        const list = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
        const rows = await tx.execute(sql`
          select id from memories where id in (${list}) and project_id = ${page.project_id}::uuid and visibility <> 'personal'
        `);
        for (const r of rows.rows as { id: string }[]) citable.add(String(r.id));
      }
      await this.pages.writeSection(tx, {
        pageId: page.id,
        sectionId: section.id,
        heading: input.heading?.trim(),
        body: input.body_md.trim(),
        citable,
        lock: true,
        actor: `user:${userId}`,
        reason: "edited by a person",
      });
    });
    await this.pages.embedSection(sectionId).catch(() => false);
    return this.get(context, page.id);
  }

  async brief(context: ActorContext, rawProjectId: string): Promise<{ brief_md: string | null; updated_at: string | null }> {
    const projectId = await this.projectScope.resolveProjectIdOrSlug(context, rawProjectId);
    await this.projectScope.requireProjectAccess(context, projectId, "read");
    const brief = await this.pages.brief(projectId);
    return { brief_md: brief?.brief_md ?? null, updated_at: brief?.updated_at ?? null };
  }

  /** The stored brief of a space, for kt_session_start. Never throws: no brief is a normal state. */
  async briefFor(projectId: string): Promise<string | null> {
    return (await this.pages.brief(projectId).catch(() => null))?.brief_md ?? null;
  }

  /** kt_page: by id, or by space + title (exact, then the closest title that contains it). */
  async pageAsMarkdown(context: ActorContext, input: { page_id?: string; project?: string; title?: string }): Promise<{ page: RenderedPage; markdown: string }> {
    let pageId = input.page_id;
    if (!pageId) {
      if (!input.project || !input.title) throw new ValidationDomainError("pass page_id, or project and title");
      const projectId = await this.projectScope.resolveProjectIdOrSlug(context, input.project);
      await this.projectScope.requireProjectAccess(context, projectId, "read");
      const exact = await this.pages.findPageByTitle(projectId, input.title);
      if (exact) pageId = exact.id;
      else {
        const rows = await this.db.execute(sql`
          select id from pages where project_id = ${projectId}::uuid and status = 'active' and title ilike ${`%${input.title.trim()}%`}
           order by updated_at desc limit 1
        `);
        pageId = (rows.rows[0] as { id?: string } | undefined)?.id;
      }
      if (!pageId) throw new NotFoundDomainError("page");
    }
    const page = await this.get(context, pageId);
    return { page, markdown: pageMarkdown(page) };
  }

  private async readable(context: ActorContext, projectId: string, what: string): Promise<void> {
    try {
      await this.projectScope.requireProjectAccess(context, projectId, "read");
    } catch (err) {
      if (err instanceof NotFoundDomainError) throw new NotFoundDomainError(what);
      throw err;
    }
  }
}
