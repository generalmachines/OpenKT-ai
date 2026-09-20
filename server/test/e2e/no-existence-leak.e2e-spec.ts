import { randomUUID } from "node:crypto";

import type { NestExpressApplication } from "@nestjs/platform-express";
import type request from "supertest";

import { HttpApp, type Person } from "./support/http-app";

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

type Method = "delete" | "get" | "patch";
type Route = { method: Method; path: string };
type ExpressLayer = { route?: { path?: string; methods?: Record<string, boolean> } };

const ID_ROUTE = /(?:^|\/)(?:projects|sessions|memories)\/:(?:id|project_?id|session_?id|memory_?id|projectId|sessionId|memoryId)(?:\/|$)|\/grants\/:(?:id|grant_?id|grantId|userId)(?:\/|$)/i;

function auditedRoutes(app: NestExpressApplication): Route[] {
  const express = app.getHttpAdapter().getInstance() as { router?: { stack?: ExpressLayer[] }; _router?: { stack?: ExpressLayer[] } };
  const stack = express.router?.stack ?? express._router?.stack ?? [];
  return stack.flatMap(({ route }) => {
    if (!route || typeof route.path !== "string" || !ID_ROUTE.test(route.path)) return [];
    const path = route.path;
    return (["get", "patch", "delete"] as const)
      .filter((method) => route.methods?.[method])
      .map((method) => ({ method, path }));
  }).sort((a, b) => `${a.path}:${a.method}`.localeCompare(`${b.path}:${b.method}`));
}

function concretePath(route: string, ids: { project: string; session: string; memory: string; grant: string }): string {
  const resourceId = route.includes("/sessions/") ? ids.session : route.includes("/memories/") ? ids.memory : ids.project;
  return route
    .replace(/:project_?id\b|:projectId\b/gi, ids.project)
    .replace(/:session_?id\b|:sessionId\b/gi, ids.session)
    .replace(/:memory_?id\b|:memoryId\b/gi, ids.memory)
    .replace(/:grant_?id\b|:grantId\b|:userId\b/gi, ids.grant)
    .replace(/:id\b/g, resourceId);
}

function patchBody(path: string): object {
  if (path.includes("/sessions/")) return { title: "must stay private" };
  if (path.includes("/projects/")) return { name: "must stay private" };
  return {};
}

function responseShape(body: Record<string, any>) {
  return { ...body, error: body.error ? { ...body.error, request_id: null } : body.error };
}

describeIfDb("No existence leaks from id-taking routes (e2e)", () => {
  const t = new HttpApp();
  let owner: Person;
  let reader: Person;
  let stranger: Person;
  let target: Person;
  let ids: { project: string; session: string; memory: string; grant: string };

  beforeAll(async () => {
    await t.start();
    [owner, reader, stranger, target] = await Promise.all([t.signup("leak-owner"), t.signup("leak-reader"), t.signup("leak-stranger"), t.signup("leak-target")]);
    const project = await t.space(owner, "existence leak audit", reader, "reader");
    const session = (await t.as(owner).post("/v1/sessions", { project_id: project, source: "note", title: "private" }).expect(201)).body.data.id as string;
    await t.as(owner).put(`/v1/sessions/${session}/grants`, { email: reader.email, role: "reader" }).expect(200);
    const memory = (await t.as(owner).post("/v1/memories", { project_id: project, content: "Private audit fact", kind: "fact" }).expect(201)).body.data.id as string;
    ids = { project, session, memory, grant: reader.user.id };
  }, 60_000);

  afterAll(() => t.stop());

  it.each(["project", "session"] as const)("keeps %s grant-management existence semantics consistent", async (kind) => {
    const resourceId = ids[kind];
    const base = `/v1/${kind}s/${resourceId}/grants`;
    const missing = `/v1/${kind}s/${randomUUID()}/grants`;
    const routes = [
      { method: "get" as const, path: base },
      { method: "put" as const, path: base, body: { email: `${randomUUID()}@e2e.test`, role: "reader" } },
      { method: "delete" as const, path: `${base}/${ids.grant}` },
    ];

    await t.as(owner).get(base).expect(200);
    await t.as(owner).put(base, { email: target.email, role: "reader" }).expect(200);
    await t.as(owner).delete(`${base}/${target.user.id}`).expect(200);

    for (const route of routes) {
      const readerResponse = route.method === "put"
        ? await t.as(reader).put(route.path, route.body)
        : await t.as(reader)[route.method](route.path);
      expect(readerResponse.status).toBe(403);

      const strangerResponse = route.method === "put"
        ? await t.as(stranger).put(route.path, route.body)
        : await t.as(stranger)[route.method](route.path);
      const missingPath = route.path.replace(base, missing);
      const missingResponse = route.method === "put"
        ? await t.as(stranger).put(missingPath, route.body)
        : await t.as(stranger)[route.method](missingPath);
      expect(strangerResponse.status).toBe(404);
      expect(responseShape(strangerResponse.body)).toEqual(responseShape(missingResponse.body));
    }
  });

  it("discovers every relevant GET/PATCH/DELETE route from the live router and gives a stranger the same 404", async () => {
    const routes = auditedRoutes(t.app);
    expect(routes.length).toBeGreaterThan(0);
    expect(new Set(routes.map((route) => route.method))).toEqual(new Set(["get", "patch", "delete"]));

    for (const route of routes) {
      const path = concretePath(route.path, ids);
      const missingPath = concretePath(route.path, {
        project: randomUUID(), session: randomUUID(), memory: randomUUID(), grant: randomUUID(),
      });
      const realAgent = t.as(stranger)[route.method](path, ...(route.method === "patch" ? [patchBody(path)] : []));
      const missingAgent = t.as(stranger)[route.method](missingPath, ...(route.method === "patch" ? [patchBody(missingPath)] : []));
      const [real, missing] = await Promise.all([realAgent as request.Test, missingAgent as request.Test]);
      expect({ route, status: real.status }).not.toEqual({ route, status: 403 });
      expect(real.status).toBe(missing.status);
      expect(responseShape(real.body)).toEqual(responseShape(missing.body));
    }
  });
});
