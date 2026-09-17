/**
 * Error vocabulary shared by Core, Providers and the MCP layer.
 *
 * Every error that leaves a module MUST be a `BrokerError` (or be wrapped in
 * one). Error messages must never embed secrets, Authorization headers or full
 * request URLs that carry credentials - see `src/security/redaction.ts`.
 */

export const ErrorCodes = {
  INVALID_INPUT: "INVALID_INPUT",
  WORKER_NOT_FOUND: "WORKER_NOT_FOUND",
  WORKER_DISABLED: "WORKER_DISABLED",
  WORKER_UNAVAILABLE: "WORKER_UNAVAILABLE",
  WORKER_UNHEALTHY: "WORKER_UNHEALTHY",
  PATH_NOT_ALLOWED: "PATH_NOT_ALLOWED",
  FILE_NOT_FOUND: "FILE_NOT_FOUND",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  TRACE_NOT_FOUND: "TRACE_NOT_FOUND",
  TIMEOUT: "TIMEOUT",
  CANCELLED: "CANCELLED",
  INTERRUPTED: "INTERRUPTED",
  PROVIDER_ERROR: "PROVIDER_ERROR",
  PROVIDER_AUTH: "PROVIDER_AUTH",
  PROVIDER_RATE_LIMITED: "PROVIDER_RATE_LIMITED",
  PROVIDER_HTTP_5XX: "PROVIDER_HTTP_5XX",
  PROVIDER_BAD_RESPONSE: "PROVIDER_BAD_RESPONSE",
  PROVIDER_NOT_IMPLEMENTED: "PROVIDER_NOT_IMPLEMENTED",
  /**
   * The request was (probably) delivered but the connection died before we saw
   * the response. Retrying could duplicate work / double-bill, so this is
   * explicitly NOT auto-retryable.
   */
  CONNECTION_LOST_AFTER_SEND: "CONNECTION_LOST_AFTER_SEND",
  CONNECTION_FAILED: "CONNECTION_FAILED",
  CONFIG_ERROR: "CONFIG_ERROR",
  SECRET_MISSING: "SECRET_MISSING",
  INTERNAL: "INTERNAL",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** Codes where an automatic retry is allowed (bounded by `limits.maxRetries`). */
const RETRYABLE: ReadonlySet<string> = new Set<string>([
  ErrorCodes.PROVIDER_RATE_LIMITED,
  ErrorCodes.CONNECTION_FAILED,
  ErrorCodes.PROVIDER_HTTP_5XX,
  ErrorCodes.PROVIDER_ERROR,
  ErrorCodes.TIMEOUT,
]);

export interface BrokerErrorOptions {
  retryable?: boolean;
  cause?: unknown;
  /** Sanitized details - never secrets. */
  details?: Record<string, unknown>;
  /** HTTP status when the failure came from an HTTP call. */
  httpStatus?: number;
}

export class BrokerError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  readonly httpStatus?: number;

  constructor(code: ErrorCode, message: string, options: BrokerErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "BrokerError";
    this.code = code;
    this.details = options.details;
    this.httpStatus = options.httpStatus;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
  }

  toJSON(): { code: string; message: string; retryable: boolean } {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

export function isBrokerError(value: unknown): value is BrokerError {
  return value instanceof BrokerError;
}

/** Wrap any thrown value into a BrokerError without losing the code. */
export function toBrokerError(value: unknown, fallbackCode: ErrorCode = ErrorCodes.INTERNAL): BrokerError {
  if (isBrokerError(value)) return value;
  if (value instanceof Error) {
    if (value.name === "AbortError") {
      return new BrokerError(ErrorCodes.TIMEOUT, "Operation aborted (timeout or cancellation)", {
        retryable: false,
        cause: value,
      });
    }
    return new BrokerError(fallbackCode, value.message, { cause: value });
  }
  return new BrokerError(fallbackCode, String(value));
}

/**
 * Classify an HTTP status into the broker error vocabulary.
 * Only the 5xx values that are safe to retry are retryable; 500 is treated as
 * ambiguous and stays non-retryable by default.
 */
export function httpStatusToErrorCode(status: number): ErrorCode {
  if (status === 401 || status === 403) return ErrorCodes.PROVIDER_AUTH;
  if (status === 429) return ErrorCodes.PROVIDER_RATE_LIMITED;
  if (status === 500) return ErrorCodes.PROVIDER_HTTP_5XX;
  if (status >= 502 && status <= 504) return ErrorCodes.PROVIDER_HTTP_5XX;
  if (status >= 500) return ErrorCodes.PROVIDER_HTTP_5XX;
  if (status >= 400) return ErrorCodes.PROVIDER_ERROR;
  return ErrorCodes.PROVIDER_ERROR;
}

export function retryableHttpStatus(status: number): boolean {
  // 429 and the "not sure it was processed" 5xx set are retried; 500 is not,
  // because the provider may have already produced (and billed) an answer.
  return status === 429 || (status >= 502 && status <= 504);
}
