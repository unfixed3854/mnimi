export class AuthError extends Error {
  constructor(
    readonly title: string,
    message: string,
    readonly technicalDetails?: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}
