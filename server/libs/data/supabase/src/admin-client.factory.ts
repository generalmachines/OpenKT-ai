import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createClient } from "@supabase/supabase-js";

import { resolveSupabaseEnvironment, STATELESS_AUTH_OPTIONS } from "./env";
import type { AdminSupabaseClient } from "./types";

@Injectable()
export class SupabaseAdminClientFactory {
  private cached: AdminSupabaseClient | null = null;

  constructor(private readonly configService: ConfigService) {}

  getClient(): AdminSupabaseClient {
    if (this.cached) {
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
