import { DomainError } from "./domain.error";

export class ForbiddenDomainError extends DomainError {
  constructor(message = "Forbidden", details: unknown = null) {
    super("forbidden", message, details);
  }
}
