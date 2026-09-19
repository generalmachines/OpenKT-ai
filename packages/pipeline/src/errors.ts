/** Thrown when a caller passes input that violates a function's documented contract. */
export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInputError";
  }
}
