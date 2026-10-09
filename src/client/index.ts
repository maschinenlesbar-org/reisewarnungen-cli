// Public entry point for the API client library.

export { ReisewarnungenClient, assertContentId, isWarned } from "./client.js";
export type { SummariesOptions, TravelAdvice } from "./client.js";
export { ADVICE_PATTERNS, TRAVEL_PATTERN, adviceSentences, isAdviceSentence, splitSentences } from "./advice.js";
export type { AdviceSentence } from "./advice.js";
export {
  RequestEngine,
  DEFAULT_BASE_URL,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  assertHeaderValue,
  cleartextProblem,
  intOption,
  isTransientNetworkError,
  parseRetryAfter,
  serverTextForMessage,
  validateBaseUrl,
} from "./engine.js";
export type { EngineOptions, RawResponse } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport, sizeLimitMessage } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export type { QueryParams, QueryValue } from "./query.js";
export {
  assertKnownKeys,
  assertValid,
  baseUrlProblem,
  booleanProblem,
  headerValueProblem,
  intInRangeProblem,
} from "./validate.js";
export type { Problem } from "./validate.js";
export {
  ReiseError,
  ReiseApiError,
  ReiseNotFoundError,
  ReiseNetworkError,
  ReiseParseError,
  ReiseValidationError,
  MAX_QUOTED_LENGTH,
  credentialsIn,
  cutForMessage,
  cutText,
  redactCredentials,
  redactUrl,
  toWellFormed,
} from "./errors.js";

export * from "./types.js";
