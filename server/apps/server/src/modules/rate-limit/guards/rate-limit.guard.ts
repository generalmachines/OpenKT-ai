import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import type { RequestWithContext } from "../../../common/http/request-with-context";
import {
  RATE_LIMIT_METADATA_KEY,
  type RateLimitConfig,
} from "../decorators/rate-limit.decorator";
import { RateLimitService } from "../services/rate-limit.service";

// 429 with Retry-After header. Express picks up the Retry-After from
// HttpException's getResponse() when we shape it — but we also set
// the header directly on the response so caching layers see it.
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimit: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const configs = this.reflector.getAllAndOverride<RateLimitConfig[] | undefined>(
      RATE_LIMIT_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!configs?.length) return true;

    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithContext>();
    const response = http.getResponse<{ setHeader: (name: string, value: string) => void }>();
    const handlerName = context.getHandler().name;

    for (const config of configs) {
      const key = this.buildKey(config, request, handlerName);
      if (!key) {
        // Missing scope identifier (no userId for a user-scoped limit,
        // etc) → fail open, log a debug-level note.
        continue;
      }
      const result = await this.rateLimit.acquire(key, config.capacity, config.refillPerSec);
      if (!result.allowed) {
        const retryAfterSec = Math.ceil((result.retryAfterMs ?? 1000) / 1000);
        response.setHeader("Retry-After", String(retryAfterSec));
        throw new HttpException(
          {
            data: null,
            error: {
              code: "rate_limited",
              message: "rate limit exceeded",
              retry_after_ms: result.retryAfterMs ?? 1000,
              bucket: key,
            },
            meta: null,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    return true;
  }

  private buildKey(
    config: RateLimitConfig,
    request: RequestWithContext,
    handlerName: string,
  ): string | null {
    const name = config.name ?? handlerName;
    switch (config.key) {
      case "user": {
        const userId = request.actorContext?.principal.userId;
        if (!userId) return null;
        return `user:${userId}:${name}`;
      }
      case "org": {
        // Org-scoped limits look for an org_id on the request — URL
        // param, body field, or one resolved upstream by another
        // guard (e.g. RequireOrgRoleGuard sets `resolvedOrgId`).
        // Endpoints where the org is only derivable via the project
        // won't find one here and will short-circuit (no limit
        // enforced) — the user-scope limit still applies and
        // generally fires first anyway. We can promote the org
        // lookup later by adding a small `project_id → org_id`
        // resolver guard if pilot traffic demands it.
        const orgId =
          (request as RequestWithContext & { resolvedOrgId?: string }).resolvedOrgId ??
          extractOrgIdFromRequest(request);
        if (!orgId) return null;
        return `org:${orgId}:${name}`;
      }
      case "ip": {
        const ip = request.ip ?? request.header("x-forwarded-for") ?? "unknown";
        return `ip:${ip}:${name}`;
      }
      default:
        return null;
    }
  }
}

function extractOrgIdFromRequest(request: RequestWithContext): string | null {
  const params = (request.params ?? {}) as Record<string, unknown>;
  const body = (request.body ?? {}) as Record<string, unknown>;
  const query = (request.query ?? {}) as Record<string, unknown>;
  return (
    pickString(params.org_id) ??
    pickString(params.orgId) ??
    pickString(body.org_id) ??
    pickString(query.org_id) ??
    null
  );
}

function pickString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
