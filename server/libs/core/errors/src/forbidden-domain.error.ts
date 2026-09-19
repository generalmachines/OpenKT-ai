import { DomainError } from "./domain.error";

export class ForbiddenDomainError extends DomainError {
  // `code` defaults to "forbidden"; a more specific one (e.g. "insufficient_scope") keeps the 403.
  constructor(message = "Forbidden", details: unknown = null, code = "forbidden") {
    super(code, message, details);
  }
}
