import { Module } from "@nestjs/common";

import { WorkerDatabaseModule } from "../database/worker-database.module";
import { HealthMonitorService } from "./services/health-monitor.service";
import { WorkerHealthProbeService } from "./services/worker-health-probe.service";

// HealthMonitorModule — the worker-side cron that probes every CORE
// service every 30s, writes samples into service_health, detects
// ok ↔ degraded/down transitions, and emits incidents into
// service_incidents. Optional webhook delivery via
// OPENKT_HEALTH_WEBHOOK_URL — fire-and-forget, no retry.
//
// Disable on a deployment with OPENKT_DISABLE_HEALTH_MONITOR=1 (e.g.
// during migration runs or when running the worker as a one-off task).
@Module({
  imports: [WorkerDatabaseModule],
  providers: [WorkerHealthProbeService, HealthMonitorService],
  exports: [HealthMonitorService],
})
export class HealthMonitorModule {}
