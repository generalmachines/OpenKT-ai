import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { MemoryModule } from "../memory/memory.module";
import { ProjectsModule } from "../projects/projects.module";
import { PrimeController } from "./controllers/prime.controller";
import { PrimeApplicationService } from "./services/prime-application.service";

@Module({
  imports: [AuthModule, ProjectsModule, MemoryModule],
  controllers: [PrimeController],
  providers: [PrimeApplicationService],
})
export class PrimeModule {}
