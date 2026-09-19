import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createClient } from "@supabase/supabase-js";

import { resolveSupabaseEnvironment, STATELESS_AUTH_OPTIONS } from "./env";
import type { UserScopedSupabaseClient } from "./types";

@Injectable()
export class SupabaseUserClientFactory {
  constructor(private readonly configService: ConfigService) {}

  bind(jwt: string): UserScopedSupabaseClient {
    const environment = resolveSupabaseEnvironment(this.configService);
    const client = createClient(environment.url, environment.publishableKey, {
      ...STATELESS_AUTH_OPTIONS,
      global: {
        headers: {
          Authorization: `Bearer ${jwt}`,
        },
      },
    });

    return Object.assign(client, {
      provider: "supabase" as const,
      kind: "user-scoped" as const,
    });
  }
}
