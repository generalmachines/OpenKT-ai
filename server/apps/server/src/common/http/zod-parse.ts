import type { ZodType } from "zod";

import { ValidationDomainError } from "@openkt/core-errors";

export function parseWithSchema<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationDomainError("invalid request payload", result.error.flatten());
  }
  return result.data;
}
