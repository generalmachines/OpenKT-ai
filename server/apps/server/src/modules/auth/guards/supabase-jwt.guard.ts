import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from "@nestjs/common";

import {
  extractBearerToken,
  mapRequestMetadata,
} from "@openkt/auth-principal";
import { UnauthorizedDomainError } from "@openkt/core-errors";

import type { RequestWithContext } from "../../../common/http/request-with-context";
import { PrincipalResolutionService } from "../services/principal-resolution.service";

@Injectable()
export class SupabaseJwtGuard implements CanActivate {
  constructor(
    private readonly principalResolutionService: PrincipalResolutionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const bearerToken = extractBearerToken(request.header("authorization") ?? null);

    if (!bearerToken) {
      throw new UnauthorizedDomainError("authorization bearer token required");
    }

    const requestMetadata = request.requestMetadata ?? mapRequestMetadata(request);
    request.actorContext = await this.principalResolutionService.resolveJwt(
      requestMetadata,
      bearerToken,
    );

    return true;
  }
}
