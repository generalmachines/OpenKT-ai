import "./instrument";

import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { Logger } from "nestjs-pino";

import { enableCorsFromEnv } from "@openkt/platform-cors";

import { AppModule, UNPREFIXED_ROUTES } from "./app.module";

async function bootstrap(): Promise<void> {
  // rawBody: true tells NestJS's express adapter to configure the global
  // JSON body parser with a `verify` callback that stores the raw bytes
  // as req.rawBody (Buffer) on every request. It also ensures the global
  // json() is registered unconditionally by NestJS — without it, a
  // path-scoped app.use('/path', json()) registered before listen()
  // causes NestJS's isMiddlewareApplied('jsonParser') check to return
  // true, so the global parser is silently skipped and req.body is
  // undefined on all other POST routes.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  app.useLogger(app.get(Logger));
  // Express stops a JSON body at 100 KB by default; a skill may carry 1 MB of
  // text (more once JSON-escaped). Registered globally, never per path — see
  // the note above.
  app.useBodyParser("json", { limit: "3mb" });
  // Behind a reverse proxy, `req.ip` is the proxy unless Express is told how
  // many hops to trust — and the per-IP sign-in limit would be shared by
  // everyone. OPENKT_TRUST_PROXY takes Express's own values: a hop count
  // ("1"), "true", or a subnet list ("loopback, 10.0.0.0/8").
  const trustProxy = process.env.OPENKT_TRUST_PROXY?.trim();
  if (trustProxy) {
    app.set(
      "trust proxy",
      /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy === "true" ? true : trustProxy,
    );
  }
  // /mcp lives outside /v1 because the MCP protocol is versioned by
  // the SDK itself, not by our REST API. Canonical URL is
  // https://api.openkt.ai/mcp; the controller also registers /v1/mcp
  // so older CLI/dashboard builds with the version-prefixed path keep
  // working.
  //
  // /.well-known/oauth-authorization-server and /oauth/* live outside
  // /v1 because OAuth discovery is anchored at the host root (RFC
  // 8414); Claude.ai hits `${origin}/.well-known/…` before the user
  // even types the server URL. Keeping the OAuth endpoints unprefixed
  // mirrors the discovery doc.
  app.setGlobalPrefix("v1", { exclude: [...UNPREFIXED_ROUTES] });
  enableCorsFromEnv(app);
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle("OpenKT API")
    .setDescription(
      "Canonical NestJS backend contract for OpenKT. Success responses use `{ data, error, meta }` envelopes and JWT-authenticated routes expect `Authorization: Bearer <token>`.",
    )
    .setVersion("1.0.0")
    .addBearerAuth(
      {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "Supabase access token for user-authenticated routes.",
      },
      "supabase-bearer",
    )
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup("v1/docs", app, swaggerDocument, {
    jsonDocumentUrl: "v1/docs-json",
  });

  await app.listen(
    process.env.PORT ? Number(process.env.PORT) : 4100,
    process.env.HOST ?? "127.0.0.1",
  );
}

void bootstrap();
