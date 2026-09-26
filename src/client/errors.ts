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
 * message extracted from the response body when one is present. For a 3xx that was
 * not followed (not a followable status, a missing or malformed Location, or past
 * `maxRedirects`), `location` holds the redirect target (absolute, sanitised) and the
 * message names it.
 */
export class ReiseApiError extends ReiseError {
  readonly status: number;
  readonly detail: string | undefined;
  readonly url: string;
  readonly method: string;
  readonly body: string;
  readonly location: string | undefined;

  constructor(args: {
    status: number;
    url: string;
    method: string;
    body: string;
    detail?: string;
    location?: string;
    /** Redirects already followed when the `maxRedirects` limit stopped this one. */
    redirectsFollowed?: number;
  }) {
    const parts: string[] = [];
    if (args.detail) parts.push(args.detail);
    if (args.status >= 300 && args.status < 400) {
      const limit =
        args.redirectsFollowed !== undefined && args.redirectsFollowed > 0
          ? ` (stopped after ${args.redirectsFollowed} redirects)`
          : "";
      parts.push(
        args.location
          ? `redirect to ${args.location} not followed${limit}`
          : "redirect not followed (no Location header)",
      );
    }
    const detailPart = parts.length > 0 ? `: ${parts.join("; ")}` : "";
    super(`HTTP ${args.status} for ${args.method} ${args.url}${detailPart}`);
    this.status = args.status;
    this.url = args.url;
    this.method = args.method;
    this.body = args.body;
    this.detail = args.detail;
    this.location = args.location;
  }

  /** True for statuses the API documents as transient and retry-able. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 503;
  }
}

/**
 * A requested entry was not present in an otherwise successful (2xx) response.
 * The upstream may answer `200` with an envelope holding no country entry
 * instead of a `404`; this surfaces that absence as a typed, observable error.
 * (An envelope whose entries sit under other keys is a ReiseParseError instead.)
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
