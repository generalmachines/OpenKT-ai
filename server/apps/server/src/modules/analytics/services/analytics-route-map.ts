// Mapping from request (method, route-pattern) to a normalized event
// name. The middleware looks the request up here; any unmatched
// mutating route still produces a generic `route.write` event so we
// don't lose signal — but we prefer explicit names for endpoints that
// fund the dashboard.
//
// Keys are `${METHOD} ${path-pattern}` where path-pattern uses the
// canonical /v1/* form (the middleware strips numeric ids before
// lookup, but uses the literal path otherwise).

export interface RouteEventMatch {
  event: string;
  // include_read=true forces the middleware to emit even when the
  // request is a GET — most reads are noise.
  includeRead?: boolean;
}

export const ANALYTICS_ROUTE_MAP: ReadonlyMap<string, RouteEventMatch> = new Map<
  string,
  RouteEventMatch
>([
  ["POST /v1/memories", { event: "memory.created" }],
  ["DELETE /v1/memories/:id", { event: "memory.forgotten" }],
  ["POST /v1/memories/recall", { event: "memory.recalled" }],
  ["POST /v1/memories/search", { event: "memory.searched" }],
  ["POST /v1/memories/answer", { event: "memory.answered" }],
  ["POST /v1/memories/enhance", { event: "memory.enhanced" }],

  ["POST /v1/auth/signup", { event: "auth.signup" }],
  ["POST /v1/auth/password", { event: "auth.signin" }],
  ["POST /v1/auth/magic-link", { event: "auth.magic_link_requested" }],

  ["POST /v1/projects", { event: "project.created" }],
  ["DELETE /v1/projects/:id", { event: "project.deleted" }],

  ["POST /v1/orgs", { event: "org.created" }],
  ["POST /v1/orgs/:id/invites", { event: "org.invited" }],

  // High-signal reads we explicitly want to track.
  ["GET /v1/projects/:id/graph", { event: "graph.viewed", includeRead: true }],
]);
