import "./instrument";
import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";

import { WorkerModule } from "./worker.module";

async function bootstrap(): Promise<void> {
  const logger = new Logger("worker");
  logger.log("Booting worker application context");

  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ["log", "error", "warn", "debug"],
  });

  logger.log("Worker application context booted");

  app.enableShutdownHooks();
}

void bootstrap();
