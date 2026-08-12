/**
 * Typed exchange errors.
 *
 * Adapters used to swallow 429/418/!ok responses by returning empty arrays.
 * Downstream (fetchCandlesSeamless, chunked history) treats an empty result
 * as END-OF-HISTORY — so a throttled chunk silently looked like "the pair has
 * no older data", yielding short/empty charts. These typed errors let the
 * history layer distinguish "throttled, retry later" from "history ended".
 */
export class RateLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RateLimitError'
  }
}

export class ExchangeRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExchangeRequestError'
  }
}