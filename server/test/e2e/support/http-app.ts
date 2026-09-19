// A real AppModule (no Supabase) over HTTP for e2e suites: sign-up, bearer
// requests and MCP tools/call, the way a client sees the server.
import { randomUUID } from "node:crypto";

import { RequestMethod } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import request from "supertest";

const SUPABASE_KEYS = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const PASSWORD = "correct horse battery 42";

export type Person = { token: string; user: { id: string; email: string; display_name: string }; email: string };
export type ToolResult = {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: any;
};

export class HttpApp {
  app!: NestExpressApplication;
  private readonly savedEnv: Record<string, string | undefined> = {};
  private readonly run = randomUUID().slice(0, 8);
  private counter = 0;

  // `env` is set before the app module loads (some modules read it at import).
  async start(env: Record<string, string> = {}): Promise<void> {
    for (const key of [...SUPABASE_KEYS, "OPENKT_MEMORY_ENGINE", ...Object.keys(env)]) this.savedEnv[key] = process.env[key];
    for (const key of SUPABASE_KEYS) delete process.env[key];
    process.env.OPENKT_MEMORY_ENGINE = "local";
    Object.assign(process.env, env);
    const { AppModule } = await import("../../../apps/server/src/app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    this.app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    this.app.useBodyParser("json", { limit: "3mb" }); // as main.ts
    this.app.set("trust proxy", true);
    this.app.setGlobalPrefix("v1", { exclude: [{ path: "mcp", method: RequestMethod.ALL }] });
    await this.app.init();
  }

  async stop(): Promise<void> {
    await this.app?.close();
    for (const [key, value] of Object.entries(this.savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  http() {
    return request(this.app.getHttpServer());
  }

  tag(label: string): string {
    return `${label}-${this.run}`;
  }

  async signup(label: string, displayName = label): Promise<Person> {
    const email = `${label}-${this.run}-${++this.counter}@e2e.test`;
    const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${++this.counter % 250}`;
    const res = await this.http()
      .post("/v1/auth/signup")
      .set("X-Forwarded-For", ip)
      .send({ email, password: PASSWORD, display_name: displayName })
      .expect(201);
    return { token: res.body.data.token, user: res.body.data.user, email };
  }

  as(p: Person) {
    const auth = { Authorization: `Bearer ${p.token}` };
    return {
      get: (path: string) => this.http().get(path).set(auth),
      post: (path: string, body: unknown = {}) => this.http().post(path).set(auth).send(body as object),
      put: (path: string, body: unknown = {}) => this.http().put(path).set(auth).send(body as object),
      patch: (path: string, body: unknown = {}) => this.http().patch(path).set(auth).send(body as object),
      delete: (path: string) => this.http().delete(path).set(auth),
    };
  }

  async mcp(p: Person, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const res = await this.http()
      .post("/mcp")
      .set({ Authorization: `Bearer ${p.token}` })
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
      .expect(200);
    const payload = res.text.startsWith("{")
      ? JSON.parse(res.text)
      : JSON.parse(res.text.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
    if (payload.error) throw new Error(`${name}: ${JSON.stringify(payload.error)}`);
    return payload.result as ToolResult;
  }

  async mcpTools(p: Person): Promise<Array<{ name: string; description?: string }>> {
    const res = await this.http()
      .post("/mcp")
      .set({ Authorization: `Bearer ${p.token}` })
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
      .expect(200);
    const payload = res.text.startsWith("{")
      ? JSON.parse(res.text)
      : JSON.parse(res.text.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
    return payload.result.tools;
  }

  // A space owned by `owner`, optionally shared with `teammate`.
  async space(owner: Person, name: string, teammate?: Person, role: "reader" | "editor" = "editor"): Promise<string> {
    const res = await this.as(owner).post("/v1/projects", { name }).expect(201);
    const id = res.body.data.id as string;
    if (teammate) {
      await this.as(owner).put(`/v1/projects/${id}/grants`, { email: teammate.email, role }).expect(200);
    }
    return id;
  }
}
