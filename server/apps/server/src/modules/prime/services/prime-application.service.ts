import { Inject, Injectable, Optional } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";

import type { ActorContext } from "@openkt/core-context";

import { DRIZZLE, type DrizzleDb } from "../../../db/drizzle.module";
import { teamBriefings } from "../../../db/schema";
import type { MemoryRecord } from "../../memory/contracts/memory.contract";
import { MemoryQueriesApplicationService } from "../../memory/services/memory-queries.application.service";
import { ProjectsApplicationService } from "../../projects/services/projects-application.service";
import { ProjectScopeService } from "../../projects/services/project-scope.service";

export interface PrimeInput {
  project_id?: string;
  with_briefing: boolean;
  with_categorized?: boolean;
}

// PRIME_CATEGORIES — the kinds surfaced by /v1/prime when
// with_categorized=true. Order matters: it's the order the CLI
// renders sections in (Decisions first, anti-patterns next, etc).
// The five chosen are the action-oriented kinds an agent needs at
// session start: what to do (decisions/patterns), what to avoid
// (anti-patterns), what just broke (incidents), what's true about
// this project (context). The other MemoryKindSchema values
// (skill, debug-recipe, environment, note, fact, other) are either
// owned by other surfaces or too generic to surface here; future
// rev can make this configurable per request.
const PRIME_CATEGORIES: MemoryRecord["kind"][] = [
  "decision",
  "anti-pattern",
  "incident",
  "pattern",
  "context",
];

// PRIME_CATEGORY_LIMIT — top-N per kind. Five strikes the balance
// between "agent has enough standing context" and "session-start
// payload doesn't blow the model context budget". One LLM token =
// ~4 chars, MEMORY_CONTENT_MAX = 20k chars → 25 memories worst-case
// is ~125k chars, well inside Sonnet/Opus limits but generous.
const PRIME_CATEGORY_LIMIT = 5;

@Injectable()
export class PrimeApplicationService {
  constructor(
    @Optional() @Inject(DRIZZLE) private readonly db: DrizzleDb | null,
    private readonly projectScopeService: ProjectScopeService,
    private readonly projectsApplicationService: ProjectsApplicationService,
    private readonly memoryQueriesApplicationService: MemoryQueriesApplicationService,
  ) {}

  async prime(context: ActorContext, input: PrimeInput) {
    const projectId = await this.projectScopeService.resolveProjectIdOrSlug(
      context,
      input.project_id,
    );

    // categorized read is parallelized with the existing reads when the
    // caller opted in, so the new feature adds zero wall-time cost
    // (the slowest of {project lookup, memory list, briefing read,
    // categorized fan-out} dominates either way).
    const categorizedTask: Promise<Record<string, MemoryRecord[]> | null> =
      input.with_categorized
        ? this.memoryQueriesApplicationService
            .categorized(context, projectId, PRIME_CATEGORIES, PRIME_CATEGORY_LIMIT)
            .catch(() => null)
        : Promise.resolve(null);

    const [project, memories, briefing, categorized] = await Promise.all([
      this.projectsApplicationService.getById(context, projectId),
      this.memoryQueriesApplicationService
        .list(context, {
          project_id: projectId,
          limit: 50,
          offset: 0,
          include_archived: false,
        })
        .then((result) => result.data)
        .catch(() => []),
      this.readBriefing(context, projectId),
      categorizedTask,
    ]);

    return {
      project,
      memories,
      reconciliation: {
        pending: 0,
        applied: 0,
      },
      briefing,
      // categorized is included only when requested AND the read
      // succeeded; absence of the field = caller didn't ask for it
      // (or the read failed open). Backward-compatible with v0.1.21
      // and earlier CLI builds that don't know about the field.
      ...(categorized ? { categorized } : {}),
    };
  }

  private async readBriefing(
    _context: ActorContext,
    projectId: string,
  ): Promise<string | null> {
    if (!this.db) {
      return null;
    }
    const rows = await this.db
      .select({ briefingMd: teamBriefings.briefingMd })
      .from(teamBriefings)
      .where(and(eq(teamBriefings.projectId, projectId), eq(teamBriefings.isCurrent, true)))
      .orderBy(desc(teamBriefings.generatedAt))
      .limit(1);
    return rows[0]?.briefingMd ?? null;
  }
}
