import "./instrument";

import { RequestMethod } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { Logger } from "nestjs-pino";

import { enableCorsFromEnv } from "@openkt/platform-cors";

import { AppModule } from "./app.module";

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
  app.setGlobalPrefix("v1", {
    exclude: [
      { path: "mcp", method: RequestMethod.ALL },
      { path: "connect", method: RequestMethod.GET },
      { path: ".well-known/(.*)", method: RequestMethod.ALL },
      { path: "oauth/(.*)", method: RequestMethod.ALL },
    ],
  });
  enableCorsFromEnv(app);
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle("OpenKT SGS API")
    .setDescription(
      "Canonical NestJS backend contract for OpenKT. Success responses use `{ data, error, meta }` envelopes and JWT-authenticated routes expect `Authorization: Bearer <token>`.",
    )
    .setVersion("1.0.0")
    .addBearerAuth(
      {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "Supabase access token for user-authenticated SGS routes.",
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
