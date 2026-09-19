interface OriginReadable {
  headers?: Record<string, string | string[] | undefined>;
  header?(name: string): string | undefined;
  get?(name: string): string | undefined;
  protocol?: string;
}

function headerValue(request: OriginReadable, name: string): string | null {
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

export function resolveOrigin(request: OriginReadable): string | null {
  const explicitOrigin = headerValue(request, "origin");
  if (explicitOrigin) return explicitOrigin;

  const host = headerValue(request, "x-forwarded-host") ?? headerValue(request, "host");
  if (!host) return null;

  const protocol =
    headerValue(request, "x-forwarded-proto") ??
    request.protocol ??
    "https";

  return `${protocol}://${host}`;
}
