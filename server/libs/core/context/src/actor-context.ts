import type {
  AdminSupabaseClient,
  RequestScopedSupabaseClient,
} from "@openkt/data-supabase";

import type { ActorPrincipal } from "./actor-principal";
import type { RequestMetadata } from "./request-metadata";

export interface ActorContext {
  principal: ActorPrincipal;
  request: RequestMetadata;
  sb: RequestScopedSupabaseClient;
  admin: () => AdminSupabaseClient;
}
