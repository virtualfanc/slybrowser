export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export function invalidRequest(message: string): never {
  throw new ServiceError("invalid_request", message, 400);
}
