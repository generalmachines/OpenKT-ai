import { DomainError } from "./domain.error";

export class ValidationDomainError extends DomainError {
  constructor(message: string, details: unknown = null) {
    super("validation_error", message, details);
  }
}
