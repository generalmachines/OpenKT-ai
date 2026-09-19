import { Injectable, Module } from "@nestjs/common";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { Test } from "@nestjs/testing";

import { AnalyticsRollupModule } from "../../apps/worker/src/modules/analytics-rollup/analytics-rollup.module";
import { WorkerDatabaseModule } from "../../apps/worker/src/modules/database/worker-database.module";
import { WorkerPgService } from "../../apps/worker/src/modules/database/worker-pg.service";
import { HealthMonitorModule } from "../../apps/worker/src/modules/health-monitor/health-monitor.module";
import { MemoryEngineModule } from "../../apps/worker/src/modules/memory-engine/memory-engine.module";
import { OutboxModule } from "../../apps/worker/src/modules/outbox/outbox.module";

@Injectable()
class FirstDatabaseConsumer {
  constructor(readonly db: WorkerPgService) {}
}

@Injectable()
class SecondDatabaseConsumer {
  constructor(readonly db: WorkerPgService) {}
}

@Module({
  imports: [WorkerDatabaseModule],
  providers: [FirstDatabaseConsumer],
  exports: [FirstDatabaseConsumer],
})
class FirstFeatureModule {}

@Module({
  imports: [WorkerDatabaseModule],
  providers: [SecondDatabaseConsumer],
  exports: [SecondDatabaseConsumer],
})
class SecondFeatureModule {}

describe("WorkerDatabaseModule", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(() => {
    process.env.DATABASE_URL = "postgres://openkt:openkt@localhost:15432/openkt";
  });

  afterAll(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it("shares one WorkerPgService across importing feature modules", async () => {
    const testingModule = await Test.createTestingModule({
      imports: [FirstFeatureModule, SecondFeatureModule],
    }).compile();

    const first = testingModule.get(FirstDatabaseConsumer);
    const second = testingModule.get(SecondDatabaseConsumer);

    expect(first.db).toBe(second.db);

    await testingModule.close();
  });

  it.each([
    MemoryEngineModule,
    HealthMonitorModule,
    AnalyticsRollupModule,
    OutboxModule,
  ])("%p imports the shared worker database module", (featureModule) => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      featureModule,
    );

    expect(imports).toContain(WorkerDatabaseModule);
  });
});
