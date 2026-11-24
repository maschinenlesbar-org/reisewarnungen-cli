// Public entry point for the API client library.

export { ReisewarnungenClient, assertContentId, canonicalContentId, isWarned } from "./client.js";
export type { SummariesOptions, TravelAdvice } from "./client.js";
export { ADVICE_PATTERNS, TRAVEL_PATTERN, TRAVEL_PATTERN_CASED, adviceSentences, advisoryBlocks, isAdviceSentence, isTravelSentence, splitSentences } from "./advice.js";
export type { AdviceSentence, AdvisoryBlock } from "./advice.js";
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
export type { EngineOptions, RawResponse, RetryEvent } from "./engine.js";
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
  normalizeToken,
  tokenProblem,
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
  echoedCredentialForms,
  redactCredentials,
  redactSecrets,
  quoteValue,
  redactUrl,
  toWellFormed,
} from "./errors.js";

export * from "./types.js";

export {
  COUNTRY_ALIASES,
  MAX_RECENT,
  MAX_TRIP_COUNTRIES,
  findCountry,
  getAdvisory,
  getTravelAdvice,
  getWarnedCountries,
  getWarningChanges,
  listCountries,
  parseSnapshot,
  snapshotOf,
  statusOf,
  warningLevel,
} from "./operations.js";
export type {
  AdvisoryAnswer,
  AdvisoryInput,
  CountryLookup,
  CountryRef,
  CountryStatus,
  LevelChange,
  ListCountriesInput,
  MatchedBy,
  TripAdvice,
  TravelAdviceInput,
  TripCountry,
  TripLookupFailure,
  TripReadFailure,
  Snapshot,
  TripVerdict,
  WarnedCountries,
  WarnedCountriesInput,
  WarningChanges,
  WarningChangesAnswer,
  WarningChangesInput,
  WarningLevel,
} from "./operations.js";
