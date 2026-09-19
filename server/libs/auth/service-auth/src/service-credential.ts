import { timingSafeEqual } from "node:crypto";

import { extractBearerToken } from "@openkt/auth-principal";

interface HeaderReadable {
  headers?: Record<string, string | string[] | undefined>;
  header?(name: string): string | undefined;
  get?(name: string): string | undefined;
}

export const SERVICE_NAME_HEADER = "x-openkt-service-name";

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

export interface ServiceCredential {
  serviceName: string;
  token: string;
}

export function extractServiceCredential(request: HeaderReadable): ServiceCredential | null {
  const token = extractBearerToken(headerValue(request, "authorization"));
  const serviceName = headerValue(request, SERVICE_NAME_HEADER);

  if (!token || !serviceName) {
    return null;
  }

  return {
    serviceName,
    token,
  };
}

export function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}
