import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Response } from "express";

import { AnalyticsService } from "../services/analytics.service";
import {
  ANALYTICS_ROUTE_MAP,
  type RouteEventMatch,
} from "../services/analytics-route-map";
import type { RequestWithContext } from "../../../common/http/request-with-context";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Capture middleware. Hooks `res.on('finish')` so the event fires
// after the controller resolves — gives us the final status code +
// the actor context that the SupabaseJwtGuard attached to the request.
// Failures inside AnalyticsService.emit() are swallowed there.
@Injectable()
export class AnalyticsMiddleware implements NestMiddleware {
  constructor(private readonly analytics: AnalyticsService) {}

  use(req: RequestWithContext, res: Response, next: NextFunction): void {
    res.on("finish", () => {
      try {
        // Only count successful + redirected responses. 4xx/5xx are
        // measured via observability/audit, not analytics.
        if (res.statusCode >= 400) return;

        const method = req.method.toUpperCase();
        const path = (req.originalUrl ?? req.url ?? "").split("?")[0] ?? "";
        const pattern = normalizePath(path);
        const match = matchRoute(method, pattern);

        if (!match) {
          // Default: only emit for mutating methods, so we don't
          // flood on every GET.
          if (READ_METHODS.has(method)) return;
          void this.analytics.emit({
            event: "route.write",
            userId: req.actorContext?.principal.userId ?? null,
            orgId: null,
            projectId: null,
            properties: {
              method,
              path: pattern,
              status: res.statusCode,
            },
            client: clientFromRequest(req),
            sessionId: null,
            requestId: requestId(req),
            ip: req.ip ?? null,
            userAgent: req.header("user-agent") ?? null,
          });
          return;
        }

        if (match.includeRead === false && READ_METHODS.has(method)) return;

        void this.analytics.emit({
          event: match.event,
          userId: req.actorContext?.principal.userId ?? null,
          orgId: null,
          projectId: null,
          properties: { method, path: pattern, status: res.statusCode },
          client: clientFromRequest(req),
          sessionId: null,
          requestId: requestId(req),
          ip: req.ip ?? null,
          userAgent: req.header("user-agent") ?? null,
        });
      } catch {
        // Swallow — middleware MUST never break the response.
      }
    });

    next();
  }
}

function requestId(req: RequestWithContext): string {
  const headerValue = req.header("x-request-id");
  return typeof headerValue === "string" && headerValue.length > 0
    ? headerValue
    : "unknown";
}

function clientFromRequest(req: RequestWithContext): string {
  const ua = req.header("user-agent") ?? "";
  if (/openkt-cli/i.test(ua)) return "cli";
  if (/Mozilla|Chrome|Safari|Firefox/i.test(ua)) return "web";
  if (/curl|wget|httpie/i.test(ua)) return "curl";
  return "api";
}

// Replace UUID-like path segments with :id so we can look up patterns
// like `POST /v1/memories/:id`.
function normalizePath(path: string): string {
  return path
    .split("/")
    .map((segment) => (UUID_RE.test(segment) ? ":id" : segment))
    .join("/");
}

function matchRoute(method: string, pattern: string): RouteEventMatch | undefined {
  const direct = ANALYTICS_ROUTE_MAP.get(`${method} ${pattern}`);
  if (direct) return direct;
  // Some routes have an `:id`-style segment that we kept literal in
  // the map (e.g. `/orgs/:id/invites`); already covered by direct.
  return undefined;
}
