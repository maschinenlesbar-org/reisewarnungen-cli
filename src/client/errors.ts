// Error types raised by the client. Kept free of any I/O so they are trivial to
// construct in tests and to `instanceof`-check by consumers.

/** Base class for every error originating from this client. */
export class ReiseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The API responded with a non-2xx status code. `detail` holds a human-readable
 * message extracted from the response body when one is present.
 */
export class ReiseApiError extends ReiseError {
  readonly status: number;
  readonly detail: string | undefined;
  readonly url: string;
  readonly method: string;
  readonly body: string;

  constructor(args: {
    status: number;
    url: string;
    method: string;
    body: string;
    detail?: string;
  }) {
    const detailPart = args.detail ? `: ${args.detail}` : "";
    super(`HTTP ${args.status} for ${args.method} ${args.url}${detailPart}`);
    this.status = args.status;
    this.url = args.url;
    this.method = args.method;
    this.body = args.body;
    this.detail = args.detail;
  }

  /** True for statuses the API documents as transient and retry-able. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 503;
  }
}

/**
 * A requested entry was not present in an otherwise successful (2xx) response.
 * The upstream may answer `200` with an empty or differently-keyed envelope
 * instead of a `404`; this surfaces that absence as a typed, observable error.
 * Carries a synthetic `status` of 404 so the CLI maps it to the same exit code
 * as a real upstream 404.
 */
export class ReiseNotFoundError extends ReiseError {
  readonly status = 404;
  readonly contentId: string;

  constructor(contentId: string) {
    super(`No travel warning found for content id "${contentId}"`);
    this.contentId = contentId;
  }
}

/** A transport-level failure (DNS, connection reset, timeout, ...). */
export class ReiseNetworkError extends ReiseError {}

/** The response body could not be parsed as the expected JSON shape. */
export class ReiseParseError extends ReiseError {}
