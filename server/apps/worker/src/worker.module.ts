import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";

import { validateWorkerEnvironment } from "@openkt/platform-config";

import { AnalyticsRollupModule } from "./modules/analytics-rollup/analytics-rollup.module";
import { JobsModule } from "./modules/jobs/jobs.module";
import { MemoryEngineModule } from "./modules/memory-engine/memory-engine.module";
import { MqModule } from "./modules/mq/mq.module";
import { OutboxModule } from "./modules/outbox/outbox.module";
import { WorkerRuntimeService } from "./worker-runtime.service";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateWorkerEnvironment,
      envFilePath: [".env.local", ".env"],
    }),
    MqModule,
    OutboxModule,
    JobsModule,
    MemoryEngineModule,
    AnalyticsRollupModule,
  ],
  providers: [WorkerRuntimeService],
})
export class WorkerModule {}
