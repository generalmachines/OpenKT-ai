import type { SupabaseClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawSupabaseClient = SupabaseClient<any, "public", "public", any, any>;

interface BaseSupabaseClient extends RawSupabaseClient {
  readonly provider: "supabase";
}

export interface UserScopedSupabaseClient extends BaseSupabaseClient {
  readonly kind: "user-scoped";
}

export interface AdminSupabaseClient extends BaseSupabaseClient {
  readonly kind: "admin";
}

export type RequestScopedSupabaseClient =
  | UserScopedSupabaseClient
  | AdminSupabaseClient;
