/**
 * The Rate Limiting binding takes `delta`, the amount a call adds to the count
 * (https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/),
 * and wrangler 4.157's local runtime honours it, but the types it generates
 * don't declare it yet. Delete this once `npm run cf-typegen` does.
 */
interface RateLimitOptions {
  /** A positive integer; 1 when left out. */
  delta?: number;
}
