import {
  createParamDecorator,
  type ExecutionContext,
} from "@nestjs/common";

import type { ActorContext } from "@openkt/core-context";
import { UnauthorizedDomainError } from "@openkt/core-errors";

import type { RequestWithContext } from "../../../common/http/request-with-context";

export const ActorContextParam = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ActorContext => {
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    if (!request.actorContext) {
      throw new UnauthorizedDomainError("actor context missing on request");
    }
    return request.actorContext;
  },
);
