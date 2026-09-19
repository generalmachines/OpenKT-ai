import type { ConfigService } from "@nestjs/config";

export interface SupabaseEnvironment {
  url: string;
  publishableKey: string;
  serviceRoleKey: string;
}

export const STATELESS_AUTH_OPTIONS = {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
} as const;

function requireValue(value: string | undefined, key: string): string {
  if (!value) {
    throw new Error(`Supabase client unavailable — ${key} must be set.`);
  }
  return value;
}

// Supabase is optional. A server with built-in accounts only leaves every
// SUPABASE_* variable unset; nothing may construct a Supabase client then.
export function isSupabaseConfigured(configService: Pick<ConfigService, "get">): boolean {
  return Boolean(configService.get<string>("SUPABASE_URL"));
}

export function resolveSupabaseEnvironment(
  configService: Pick<ConfigService, "get">,
): SupabaseEnvironment {
  const url = requireValue(configService.get<string>("SUPABASE_URL"), "SUPABASE_URL");
  const publishableKey =
    configService.get<string>("SUPABASE_ANON_KEY") ??
    configService.get<string>("SUPABASE_PUBLISHABLE_KEY");
  const serviceRoleKey = configService.get<string>("SUPABASE_SERVICE_ROLE_KEY");

  return {
    url,
    publishableKey: requireValue(
      publishableKey,
      "SUPABASE_ANON_KEY or SUPABASE_PUBLISHABLE_KEY",
    ),
    serviceRoleKey: requireValue(serviceRoleKey, "SUPABASE_SERVICE_ROLE_KEY"),
  };
}
