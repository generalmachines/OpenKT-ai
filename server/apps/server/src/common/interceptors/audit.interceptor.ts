import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Observable } from "rxjs";

import { mapAuditActorSnapshot } from "@openkt/platform-audit";

import type { RequestWithContext } from "../http/request-with-context";

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    if (request.actorContext) {
      request.auditSnapshot = mapAuditActorSnapshot(request.actorContext);
    }
    return next.handle();
  }
}
