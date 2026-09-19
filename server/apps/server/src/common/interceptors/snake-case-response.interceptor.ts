import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable, map } from "rxjs";

// Global response interceptor: enforces snake_case on every JSON key
// the API emits. Internal TS types stay camelCase (idiomatic) — the
// conversion happens once, on the way out.
//
// Why a global interceptor over per-controller serialisers:
//   - One place to change the wire convention if we ever revisit it.
//   - Repos / application services don't have to know about the
//     contract; they return whatever shape Postgres gives them or
//     whatever's convenient internally.
//   - Idempotent: keys that already look snake_case are passed through
//     untouched, so memory rows (already snake from Postgres) survive
//     a no-op pass.
//
// Performance: linear in keys, no recursion-depth concern (response
// shapes are bounded — memories, projects, lists). The hot path is
// list endpoints; even there, conversion is cheap relative to the
// JSON.stringify Nest is about to do anyway.
@Injectable()
export class SnakeCaseResponseInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((value) => toSnakeKeys(value)));
  }
}

const camelToSnakeRe = /[A-Z]/g;

function toSnakeKey(key: string): string {
  // Already snake (or all-lowercase) — leave untouched. Keys with
  // digits or hyphens stay as-is too.
  if (!camelToSnakeRe.test(key)) {
    camelToSnakeRe.lastIndex = 0;
    return key;
  }
  camelToSnakeRe.lastIndex = 0;
  return key.replace(camelToSnakeRe, (m, idx: number) =>
    idx === 0 ? m.toLowerCase() : `_${m.toLowerCase()}`,
  );
}

function toSnakeKeys(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toSnakeKeys);
  }
  // Pass through non-plain objects (Date, Buffer, Uint8Array, class
  // instances). Plain objects get key-walked.
  if (typeof value !== "object") {
    return value;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[toSnakeKey(k)] = toSnakeKeys(v);
  }
  return out;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
