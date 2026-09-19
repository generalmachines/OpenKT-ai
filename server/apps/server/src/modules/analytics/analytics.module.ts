import { Global, Module, NestModule, MiddlewareConsumer } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { AnalyticsController } from "./controllers/analytics.controller";
import { InternalAnalyticsController } from "./controllers/internal-analytics.controller";
import { AnalyticsMiddleware } from "./middleware/analytics.middleware";
import { AnalyticsQueryService } from "./services/analytics-query.service";
import { AnalyticsService } from "./services/analytics.service";

// @Global so any service in the app can inject AnalyticsService and
// emit() a business event without re-importing the module.
@Global()
@Module({
  imports: [AuthModule],
  controllers: [AnalyticsController, InternalAnalyticsController],
  providers: [AnalyticsService, AnalyticsQueryService],
  exports: [AnalyticsService, AnalyticsQueryService],
})
export class AnalyticsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AnalyticsMiddleware).forRoutes("*");
  }
}
