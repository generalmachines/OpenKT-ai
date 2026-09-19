import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { GraphController } from "./controllers/graph.controller";
import { GraphQueryController } from "./controllers/graph-query.controller";
import { GraphQueryService } from "./services/graph-query.service";
import { GraphRepository } from "./services/graph.repository";
import { GraphService } from "./services/graph.service";
import { Neo4jService } from "./services/neo4j.service";

@Module({
  imports: [AuthModule],
  controllers: [GraphController, GraphQueryController],
  providers: [
    GraphRepository,
    GraphService,
    Neo4jService,
    GraphQueryService,
  ],
  exports: [GraphService, Neo4jService, GraphQueryService],
})
export class GraphModule {}
