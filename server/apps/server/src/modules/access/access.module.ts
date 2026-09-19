import { Module } from "@nestjs/common";

import { AccessScopeService } from "./services/access-scope.service";

// AccessScopeService only needs the globally-provided DRIZZLE token —
// no imports of AuthModule/ProjectsModule required. Kept as its own
// small module (rather than folded into ProjectsModule) so any module
// that needs "what can this principal see" can import just this one,
// per architecture.md §3.
@Module({
  providers: [AccessScopeService],
  exports: [AccessScopeService],
})
export class AccessModule {}
