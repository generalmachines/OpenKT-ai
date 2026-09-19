import {
  type ApiEnvironment,
  apiEnvironmentSchema,
  type WorkerEnvironment,
  workerEnvironmentSchema,
} from "./env.schemas";

function toErrorMessage(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
    .join("; ");
}

export function validateApiEnvironment(config: Record<string, unknown>): ApiEnvironment {
  const result = apiEnvironmentSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Invalid OpenKT API environment: ${toErrorMessage(result.error.issues)}`);
  }
  return result.data;
}

export function validateWorkerEnvironment(
  config: Record<string, unknown>,
): WorkerEnvironment {
  const result = workerEnvironmentSchema.safeParse(config);
  if (!result.success) {
    throw new Error(
      `Invalid OpenKT worker environment: ${toErrorMessage(result.error.issues)}`,
    );
  }
  return result.data;
}
