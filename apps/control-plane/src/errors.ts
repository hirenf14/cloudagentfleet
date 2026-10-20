/**
 * An error that carries the HTTP status the Controller should answer with.
 * Untyped errors map to 400.
 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string) {
    super(404, message);
    this.name = "NotFoundError";
  }
}

export class UnavailableError extends HttpError {
  constructor(message: string) {
    super(503, message);
    this.name = "UnavailableError";
  }
}

/** The instance exists, but its backend does not offer this feature. */
export class UnsupportedError extends HttpError {
  constructor(message: string) {
    super(409, message);
    this.name = "UnsupportedError";
  }
}
