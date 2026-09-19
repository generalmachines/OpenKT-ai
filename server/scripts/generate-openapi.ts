import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

import { AppModule } from "../apps/server/src/app.module";

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix("v1");

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

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  const outputDir = join(process.cwd(), "docs", "openapi");
  const outputPath = join(outputDir, "server.v1.json");

  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  await app.close();

  process.stdout.write(`${outputPath}\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
