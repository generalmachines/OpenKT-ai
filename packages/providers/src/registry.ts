// Provider registry (Spec 05 §2): anyone adds a provider by implementing
// ToolProvider and registering it here — no core change.

import type { ToolProvider } from "./types.js";
import { InvalidInputError } from "./errors.js";

const providers = new Map<string, ToolProvider>();

/** Register a provider under its `id`. A duplicate id throws. */
export function register(provider: ToolProvider): void {
  if (providers.has(provider.id)) {
    throw new InvalidInputError(`provider already registered: ${provider.id}`);
  }
  providers.set(provider.id, provider);
}

export function get(id: string): ToolProvider | undefined {
  return providers.get(id);
}

export function list(): ToolProvider[] {
  return [...providers.values()];
}
