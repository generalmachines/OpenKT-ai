import { Module } from "@nestjs/common";

import { WorkerDatabaseModule } from "../database/worker-database.module";
import { LocalPgOutboxRepository } from "./local-pg-outbox.repository";
import { OutboxRelayService } from "./outbox-relay.service";
import { OUTBOX_RELAY_STORE } from "./outbox.constants";

@Module({
  imports: [WorkerDatabaseModule],
  providers: [
    OutboxRelayService,
    LocalPgOutboxRepository,
    {
      provide: OUTBOX_RELAY_STORE,
      useExisting: LocalPgOutboxRepository,
    },
  ],
  exports: [OutboxRelayService],
})
export class OutboxModule {}
