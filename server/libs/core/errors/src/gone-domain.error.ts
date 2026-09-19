import { DomainError } from "./domain.error";

export class GoneDomainError extends DomainError {
  constructor(message = "Gone", details: unknown = null) {
    super("gone", message, details);
  }
}
