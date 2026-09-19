import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from "@nestjs/common";

import {
  extractServiceCredential,
} from "@openkt/auth-service-auth";
import { mapRequestMetadata } from "@openkt/auth-principal";
import { UnauthorizedDomainError } from "@openkt/core-errors";

import type { RequestWithContext } from "../../../common/http/request-with-context";
import { PrincipalResolutionService } from "../services/principal-resolution.service";
import { ServiceTokenService } from "../services/service-token.service";

@Injectable()
export class ServicePrincipalGuard implements CanActivate {
  constructor(
    private readonly principalResolutionService: PrincipalResolutionService,
    private readonly serviceTokenService: ServiceTokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const credential = extractServiceCredential(request);

    if (!credential) {
      throw new UnauthorizedDomainError("service credential required");
    }

    this.serviceTokenService.assertValid(credential.token);

    const requestMetadata = request.requestMetadata ?? mapRequestMetadata(request);
    request.actorContext = await this.principalResolutionService.resolveServicePrincipal(
      requestMetadata,
      credential.serviceName,
    );

    return true;
  }
}
