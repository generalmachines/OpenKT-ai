export interface ActorOAuthIdentity {
  // Lower-cased provider name as Supabase reports it ('github', 'google',
  // ...). 'email' when the session came from password / magic-link flows.
  provider: string;
  // GitHub: login (Supabase user_metadata.user_name). Null for non-GitHub
  // providers or when Supabase didn't return the field.
  githubUsername?: string | null;
  // GitHub: numeric account id as a string (Supabase user_metadata.provider_id).
  githubId?: string | null;
  // Provider-supplied avatar URL (user_metadata.avatar_url). Null when absent.
  avatarUrl?: string | null;
  // Provider-supplied display name (user_metadata.full_name ?? .name).
  fullName?: string | null;
}

export interface ActorPrincipal {
  type: "user" | "service" | "system";
  userId: string | null;
  email: string | null;
  displayName: string | null;
  authSource: "supabase-jwt" | "service-token" | "mcp-token" | "system";
  tokenId?: string | null;
  serviceName?: string | null;
  // Populated for `supabase-jwt` principals so the BFF can lazy-create /
  // upgrade profile rows on first authenticated request without a second
  // round-trip to Supabase. Always undefined for service / system
  // principals — those don't have an upstream identity provider.
  oauthIdentity?: ActorOAuthIdentity | null;
  // Populated only for `mcp-token` (okt_pat_…) principals with the
  // token's stored scopes ("read" | "write" | "admin", see
  // PersonalTokensService.normalizeScopes). null/undefined for
  // supabase-jwt/service/system principals — those aren't
  // scope-restricted, a JWT session has full access.
  scopes?: string[] | null;
}
