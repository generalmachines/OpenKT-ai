import { Injectable } from "@nestjs/common";

import type { ActorContext, ActorPrincipal, RequestMetadata } from "@openkt/core-context";
import { actorKindForPrincipal } from "@openkt/auth-principal";
import {
  SupabaseAdminClientFactory,
  SupabaseUserClientFactory,
} from "@openkt/data-supabase";

@Injectable()
export class ActorContextFactory {
  constructor(
    private readonly adminClientFactory: SupabaseAdminClientFactory,
    private readonly userClientFactory: SupabaseUserClientFactory,
  ) {}

  createUserContext(input: {
    principal: ActorPrincipal;
    request: RequestMetadata;
    // Nullable for PAT-auth callers — they don't have a Supabase JWT
    // and can't impersonate the user against Supabase. The admin client
    // is exposed instead; any downstream call that strictly requires a
    // user-scoped Supabase client (the only place this matters today
    // is AuthApplicationService.logout) must guard against that path.
    jwt: string | null;
  }): ActorContext {
    const sb = input.jwt
      ? this.userClientFactory.bind(input.jwt)
      : this.adminClientFactory.getClient();
    return {
      principal: input.principal,
      request: this.decorateRequest(input.request, input.principal),
      sb,
      admin: () => this.adminClientFactory.getClient(),
    };
  }

  createServiceContext(input: {
    principal: ActorPrincipal;
    request: RequestMetadata;
  }): ActorContext {
    const adminClient = this.adminClientFactory.getClient();
    return {
      principal: input.principal,
      request: this.decorateRequest(input.request, input.principal),
      sb: adminClient,
      admin: () => adminClient,
    };
  }

  private decorateRequest(
    request: RequestMetadata,
    principal: ActorPrincipal,
  ): RequestMetadata {
    return {
      ...request,
      actorKind: actorKindForPrincipal(request.surface, principal),
    };
  }
}
