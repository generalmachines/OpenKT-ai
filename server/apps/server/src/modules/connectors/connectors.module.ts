import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { PersonalTokensModule } from "../personal-tokens/personal-tokens.module";
import { ConnectorsController } from "./controllers/connectors.controller";
import { ConnectorsService } from "./services/connectors.service";

// The /connect static HTML page that used to live in this module is
// gone — the dashboard now owns the connector UX.
// We keep /v1/me/connectors as a JSON endpoint the dashboard calls.
@Module({
  imports: [AuthModule, PersonalTokensModule],
  controllers: [ConnectorsController],
  providers: [ConnectorsService],
  exports: [ConnectorsService],
})
export class ConnectorsModule {}
