import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { constantTimeEquals } from "@openkt/auth-service-auth";
import {
  ForbiddenDomainError,
  UnauthorizedDomainError,
} from "@openkt/core-errors";

@Injectable()
export class ServiceTokenService {
  constructor(private readonly configService: ConfigService) {}

  assertValid(token: string): void {
    const configuredToken =
      this.configService.get<string>("OPENKT_INTERNAL_SERVICE_TOKEN") ??
      this.configService.get<string>("OPENKT_MCP_SERVICE_KEY");

    if (!configuredToken) {
      throw new ForbiddenDomainError("internal service auth is not configured");
    }

    if (!constantTimeEquals(token, configuredToken)) {
      throw new UnauthorizedDomainError("invalid service token");
    }
  }
}
