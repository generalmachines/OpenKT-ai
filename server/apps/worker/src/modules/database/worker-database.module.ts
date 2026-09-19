import { Module } from "@nestjs/common";

import { WorkerPgService } from "./worker-pg.service";

@Module({
  providers: [WorkerPgService],
  exports: [WorkerPgService],
})
export class WorkerDatabaseModule {}
