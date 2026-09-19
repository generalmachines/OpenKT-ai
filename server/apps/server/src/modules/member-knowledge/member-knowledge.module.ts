import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { MemberKnowledgeController } from "./controllers/member-knowledge.controller";
import { LocalPgMemberKnowledgeRepository } from "./repositories/local-pg-member-knowledge.repository";
import { MemberKnowledgeApplicationService } from "./services/member-knowledge-application.service";

// DrizzleModule is @Global(), so the DRIZZLE token used by the repo
// is injectable here without importing it explicitly.

@Module({
  imports: [AuthModule],
  controllers: [MemberKnowledgeController],
  providers: [
    LocalPgMemberKnowledgeRepository,
    MemberKnowledgeApplicationService,
  ],
  exports: [MemberKnowledgeApplicationService],
})
export class MemberKnowledgeModule {}
