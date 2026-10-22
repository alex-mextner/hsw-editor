/** An error that maps straight to an HTTP status and the `{ error: { code, message, details? } }` body. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
