import { Module, forwardRef } from "@nestjs/common";

import { SupabaseDataModule } from "@openkt/data-supabase";

import { WaitlistModule } from "../waitlist/waitlist.module";
import { InternalAuthController } from "./controllers/internal-auth.controller";
import { PublicAuthController } from "./controllers/public-auth.controller";
import { ServicePrincipalGuard } from "./guards/service-principal.guard";
import { SupabaseJwtGuard } from "./guards/supabase-jwt.guard";
import { ActorContextFactory } from "./services/actor-context.factory";
import { AuthApplicationService } from "./services/auth-application.service";
import { DeviceCodeService } from "./services/device-code.service";
import { PrincipalResolutionService } from "./services/principal-resolution.service";
import { ServiceTokenService } from "./services/service-token.service";
import { SupabaseJwtVerifier } from "./services/supabase-jwt-verifier.service";

@Module({
  imports: [SupabaseDataModule, forwardRef(() => WaitlistModule)],
  controllers: [InternalAuthController, PublicAuthController],
  providers: [
    ActorContextFactory,
    AuthApplicationService,
    DeviceCodeService,
    PrincipalResolutionService,
    ServiceTokenService,
    SupabaseJwtVerifier,
    ServicePrincipalGuard,
    SupabaseJwtGuard,
  ],
  exports: [
    ActorContextFactory,
    PrincipalResolutionService,
    ServiceTokenService,
    ServicePrincipalGuard,
    SupabaseJwtGuard,
  ],
})
export class AuthModule {}
