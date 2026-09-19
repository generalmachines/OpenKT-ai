import { DomainError } from "./domain.error";

export class NotFoundDomainError extends DomainError {
  constructor(message = "Not found", details: unknown = null) {
    super("not_found", message, details);
  }
}
