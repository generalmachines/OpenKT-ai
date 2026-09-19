import type { RequestMetadata } from "@openkt/core-context";
import { resolveOrigin } from "@openkt/platform-config";

import {
  REQUEST_METADATA_HEADERS,
  actorKindFromSurface,
  parseExecutionSurface,
} from "./principal-resolution";

interface HeaderReadable {
  ip?: string | null;
  headers?: Record<string, string | string[] | undefined>;
  header?(name: string): string | undefined;
  get?(name: string): string | undefined;
}

function headerValue(request: HeaderReadable, name: string): string | null {
  const lowered = name.toLowerCase();
  const direct = request.get?.(lowered) ?? request.header?.(lowered);
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const raw = request.headers?.[lowered] ?? request.headers?.[name];
  if (Array.isArray(raw)) {
    const first = raw.find((value) => value.trim().length > 0);
    return first?.trim() ?? null;
  }
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function resolveIp(request: HeaderReadable): string | null {
  if (request.ip?.trim()) return request.ip.trim();

  const forwardedFor = headerValue(request, "x-forwarded-for");
  if (forwardedFor) {
    const firstHop = forwardedFor.split(",")[0]?.trim();
    if (firstHop) return firstHop;
  }

  return headerValue(request, "x-real-ip");
}

function resolveActorKind(
  request: HeaderReadable,
  fallback: RequestMetadata["actorKind"],
): RequestMetadata["actorKind"] {
  const explicit = headerValue(request, REQUEST_METADATA_HEADERS.actorKind)?.toLowerCase();
  if (
    explicit === "human" ||
    explicit === "cli" ||
    explicit === "mcp" ||
    explicit === "agent" ||
    explicit === "system"
  ) {
    return explicit;
  }

  return fallback;
}

export function mapRequestMetadata(request: HeaderReadable): RequestMetadata {
  const surface = parseExecutionSurface(
    headerValue(request, REQUEST_METADATA_HEADERS.surface),
  );
  const actorKind = actorKindFromSurface(surface);

  return {
    requestId: headerValue(request, "x-request-id"),
    ip: resolveIp(request),
    userAgent: headerValue(request, "user-agent"),
    referer: headerValue(request, "referer"),
    origin: resolveOrigin(request),
    sessionId: headerValue(request, REQUEST_METADATA_HEADERS.sessionId),
    surface,
    actorKind: resolveActorKind(request, actorKind),
  };
}
