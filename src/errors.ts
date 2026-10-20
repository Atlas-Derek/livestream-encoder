/** Domain error carrying the HTTP status the API should answer with. */
export class AppError extends Error {
  readonly status: number;

  constructor(message: string, status = 500, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AppError';
    this.status = status;
  }
}
