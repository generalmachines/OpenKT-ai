import { SetMetadata } from "@nestjs/common";

export type RateLimitKeyKind = "user" | "org" | "ip";

export interface RateLimitConfig {
  // Scope of the bucket key: keys are built like
  //   user → `user:${userId}:${name}`
  //   org  → `org:${orgId}:${name}`
  //   ip   → `ip:${ip}:${name}`
  key: RateLimitKeyKind;
  // Logical name suffix — e.g. "memory_create". Defaults to the
  // handler method name if not provided.
  name?: string;
  capacity: number;
  refillPerSec: number;
}

export const RATE_LIMIT_METADATA_KEY = "openkt:rate-limit";

// Attach one or more rate-limit policies to a route. Multiple decorators
// stack — the guard enforces ALL of them in order.
export const RateLimit = (
  ...configs: RateLimitConfig[]
): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_METADATA_KEY, configs);
