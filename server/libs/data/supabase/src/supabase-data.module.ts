import { Module } from "@nestjs/common";

import { SupabaseAdminClientFactory } from "./admin-client.factory";
import { SupabaseUserClientFactory } from "./user-client.factory";

@Module({
  providers: [SupabaseAdminClientFactory, SupabaseUserClientFactory],
  exports: [SupabaseAdminClientFactory, SupabaseUserClientFactory],
})
export class SupabaseDataModule {}
