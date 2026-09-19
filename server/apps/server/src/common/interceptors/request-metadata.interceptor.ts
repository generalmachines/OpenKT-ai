import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Observable } from "rxjs";

import { mapRequestMetadata } from "@openkt/auth-principal";

import type { RequestWithContext } from "../http/request-with-context";

@Injectable()
export class RequestMetadataInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    request.requestMetadata = mapRequestMetadata(request);
    return next.handle();
  }
}
