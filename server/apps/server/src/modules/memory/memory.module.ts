import { Module } from "@nestjs/common";

import { LlmGatewayService } from "@openkt/platform-llm";

import { AuthModule } from "../auth/auth.module";
import { ProjectsModule } from "../projects/projects.module";
import { AccessModule } from "../access/access.module";
import { EpisodesController } from "./controllers/episodes.controller";
import { MemoriesController } from "./controllers/memories.controller";
import { MemoryTraceController } from "./controllers/memory-trace.controller";
import { DrizzleOutboxRepository } from "./repositories/drizzle-outbox.repository";
import { KnowledgeRepository } from "./repositories/knowledge.repository";
import { MemoryRepository } from "./repositories/memory.repository";
import { MemoryAnswerService } from "./services/memory-answer.service";
import { MemoryCommandsApplicationService } from "./services/memory-commands.application.service";
import { MemoryEnhancementService } from "./services/memory-enhancement.service";
import { MEMORY_ENGINE } from "./services/memory-engine";
import { MemoryOutboxService } from "./services/memory-outbox.service";
import { MemoryQueriesApplicationService } from "./services/memory-queries.application.service";
import { MemoryRecallService } from "./services/memory-recall.service";
import { MemorySynthesisService } from "./services/memory-synthesis.service";
import { MemoryTraceService } from "./services/memory-trace.service";
import { LocalMemoryEngine } from "./services/local-memory-engine.service";
import { SessionRepository } from "../sessions/repositories/session.repository";

// Single repository, single source of truth. Drizzle is global and
// provides DRIZZLE; the env-driven repo swap that lived here in the
// last iteration is gone — DATABASE_URL is the only knob now.

@Module({
  imports: [AuthModule, ProjectsModule, AccessModule],
  controllers: [MemoriesController, EpisodesController, MemoryTraceController],
  providers: [
    MemoryRepository,
    // Provided directly (not via SessionsModule) — see the note in
    // sessions.module.ts on why these two modules each provide the
    // other's lightweight, DRIZZLE-only repository class instead of
    // importing one another's module.
    SessionRepository,
    KnowledgeRepository,
    DrizzleOutboxRepository,
    LlmGatewayService,
    LocalMemoryEngine,
    { provide: MEMORY_ENGINE, useExisting: LocalMemoryEngine },
    MemoryOutboxService,
    MemoryCommandsApplicationService,
    MemoryEnhancementService,
    MemoryQueriesApplicationService,
    MemoryRecallService,
    MemorySynthesisService,
    MemoryAnswerService,
    MemoryTraceService,
  ],
  exports: [
    MemoryRepository,
    KnowledgeRepository,
    MemoryCommandsApplicationService,
    MemoryQueriesApplicationService,
    MemoryRecallService,
    MemoryAnswerService,
    MemoryTraceService,
  ],
})
export class MemoryModule {}
