// Copyright 2026 The OpenKT Authors. SPDX-License-Identifier: Apache-2.0

/** The client is misconfigured (no base URL, bad option). Thrown. */
export class LlmConfigError extends Error {
  override name = "LlmConfigError";
}

/** The endpoint could not be reached or answered outside the protocol. Thrown. */
export class LlmTransportError extends Error {
  override name = "LlmTransportError";
  constructor(message: string, readonly status?: number, readonly body?: string) {
    super(message);
  }
}

/** The caller passed input outside the agent's contract (too many neighbours, no facts…). Thrown. */
export class AgentInputError extends Error {
  override name = "AgentInputError";
}
