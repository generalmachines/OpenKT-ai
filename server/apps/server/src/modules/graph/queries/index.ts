import { entityCentralityQuery } from "./entity-centrality.query";
import { entityNeighborsQuery } from "./entity-neighbors.query";
import { episodeLineageQuery } from "./episode-lineage.query";
import { memoryPathsQuery } from "./memory-paths.query";
import { projectOverviewQuery } from "./project-overview.query";
import { tagContributorsQuery } from "./tag-contributors.query";

import type { CypherQuery } from "./types";

// Named-query registry. The dispatcher resolves an incoming `query`
// name through this map, validates `params` against the matched
// schema, and executes the query against the right backend.
//
// Adding a new query: drop a file in `./<name>.query.ts` and append
// to `QUERIES` here. The registry is intentionally hand-rolled rather
// than auto-discovered so reviewers see the exact named surface in
// one place.

export const QUERIES: Record<string, CypherQuery<unknown>> = {
  [entityNeighborsQuery.name]: entityNeighborsQuery as CypherQuery<unknown>,
  [episodeLineageQuery.name]: episodeLineageQuery as CypherQuery<unknown>,
  [tagContributorsQuery.name]: tagContributorsQuery as CypherQuery<unknown>,
  [memoryPathsQuery.name]: memoryPathsQuery as CypherQuery<unknown>,
  [entityCentralityQuery.name]: entityCentralityQuery as CypherQuery<unknown>,
  [projectOverviewQuery.name]: projectOverviewQuery as CypherQuery<unknown>,
};

export const QUERY_NAMES = Object.keys(QUERIES);

export function getQuery(name: string): CypherQuery<unknown> | null {
  return Object.prototype.hasOwnProperty.call(QUERIES, name) ? QUERIES[name] : null;
}

export {
  entityNeighborsQuery,
  episodeLineageQuery,
  tagContributorsQuery,
  memoryPathsQuery,
  entityCentralityQuery,
  projectOverviewQuery,
};
export * from "./types";
