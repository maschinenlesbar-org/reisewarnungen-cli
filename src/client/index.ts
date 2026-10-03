// Public entry point for the API client library.

export { ReisewarnungenClient, assertContentId, isWarned } from "./client.js";
export type { SummariesOptions } from "./client.js";
export {
  RequestEngine,
  DEFAULT_BASE_URL,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  assertHeaderValue,
  intOption,
  parseRetryAfter,
} from "./engine.js";
export type { EngineOptions, RawResponse } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export type { QueryParams, QueryValue } from "./query.js";
export { assertValid, booleanProblem, headerValueProblem, intInRangeProblem } from "./validate.js";
export type { Problem } from "./validate.js";
export {
  ReiseError,
  ReiseApiError,
  ReiseNotFoundError,
  ReiseNetworkError,
  ReiseParseError,
  ReiseValidationError,
} from "./errors.js";

export * from "./types.js";
