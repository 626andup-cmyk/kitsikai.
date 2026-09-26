/**
 * Errors with a meaning the server understands, so it can answer with the
 * right status (see the error handling in `src/server.ts`).
 *
 * Copied from Aettica.
 */

/** Thrown when something is looked up by an id that doesn't exist. */
export class NotFoundError extends Error {
  constructor(what: string) {
    super(`That ${what} doesn't exist.`);
    this.name = "NotFoundError";
  }
}

/**
 * Thrown when a request contains invalid data, or asks for something that
 * doesn't make sense: a missing name, a temperature out of range. The
 * message says what's wrong and is shown to you.
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
