import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";

import {
  extractBearerToken,
  mapRequestMetadata,
} from "@openkt/auth-principal";
import { UnauthorizedDomainError } from "@openkt/core-errors";

import type { RequestWithContext } from "../../../common/http/request-with-context";
import { PrincipalResolutionService } from "../services/principal-resolution.service";
import { BearerAuthGuard } from "./bearer-auth.guard";

@Injectable()
export class SupabaseJwtGuard implements CanActivate {
  constructor(
    private readonly principalResolutionService: PrincipalResolutionService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const bearerToken = extractBearerToken(request.header("authorization") ?? null);

    if (!bearerToken) {
      throw new UnauthorizedDomainError("authorization bearer token required");
    }

    // Personal access tokens (`okt_pat_…`) are first-class on every REST route,
    // not only on /mcp: the desktop app and headless clients sign in with them.
    // Delegate to BearerAuthGuard so verification and scope enforcement stay in
    // one place.
    if (bearerToken.startsWith("okt_pat_")) {
      const bearerGuard = this.moduleRef.get(BearerAuthGuard, { strict: false });
      return bearerGuard.canActivate(context);
    }

    const requestMetadata = request.requestMetadata ?? mapRequestMetadata(request);
    request.actorContext = await this.principalResolutionService.resolveJwt(
      requestMetadata,
      bearerToken,
    );

    return true;
  }
}
