import { Module } from "@nestjs/common";

import { WorkerDatabaseModule } from "../database/worker-database.module";
import { DailyRollupService } from "./services/daily-rollup.service";

// analytics-rollup module — hourly job that walks analytics_events +
// llm_calls and upserts the daily rollup tables.
//
// TODO(scheduler): swap setInterval for @nestjs/schedule once it's
// added to the worker app. Today the service self-schedules in
// onModuleInit().
@Module({
  imports: [WorkerDatabaseModule],
  providers: [DailyRollupService],
  exports: [DailyRollupService],
})
export class AnalyticsRollupModule {}
