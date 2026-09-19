import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export function requestIdMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const headerValue = request.header("x-request-id") ?? randomUUID();
  request.headers["x-request-id"] = headerValue;
  response.setHeader("x-request-id", headerValue);
  next();
}
