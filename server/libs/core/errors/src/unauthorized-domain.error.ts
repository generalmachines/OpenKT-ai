import { DomainError } from "./domain.error";

export class UnauthorizedDomainError extends DomainError {
  constructor(message = "Unauthorized", details: unknown = null) {
    super("unauthorized", message, details);
  }
}
