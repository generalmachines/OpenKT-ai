import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createClient } from "@supabase/supabase-js";

import { isSupabaseConfigured, resolveSupabaseEnvironment, STATELESS_AUTH_OPTIONS } from "./env";
import type { AdminSupabaseClient } from "./types";

@Injectable()
export class SupabaseAdminClientFactory {
  private cached: AdminSupabaseClient | null = null;

  constructor(private readonly configService: ConfigService) {}

  getClient(): AdminSupabaseClient {
    if (this.cached) {
      return this.cached;
    }

    if (!isSupabaseConfigured(this.configService)) {
      this.cached = unconfiguredAdminClient();
      return this.cached;
    }

    const environment = resolveSupabaseEnvironment(this.configService);
    const client = createClient(environment.url, environment.serviceRoleKey, STATELESS_AUTH_OPTIONS);

    this.cached = Object.assign(client, {
      provider: "supabase" as const,
      kind: "admin" as const,
    });

    return this.cached;
  }
}

// Supabase is optional. Every actor context carries a client handle, so with
// SUPABASE_* unset we hand out a stand-in that costs nothing to create and
// fails loudly only if some code path actually tries to talk to Supabase.
// (With DATABASE_URL set, access checks and repositories use Postgres directly
// and never touch it.)
function unconfiguredAdminClient(): AdminSupabaseClient {
  return new Proxy({} as AdminSupabaseClient, {
    get(_target, property) {
      if (property === "provider") return "supabase";
      if (property === "kind") return "admin";
      if (typeof property === "symbol" || property === "then") return undefined;
      throw new Error(
        `Supabase is not configured on this server (SUPABASE_URL is unset) — cannot use client.${property}`,
      );
    },
  });
}
