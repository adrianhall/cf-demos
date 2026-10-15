import { problemDetails } from '@adrianhall/cloudflare-toolkit/problem-details';

/**
 * One-minute fixed-window policy for web mutations.
 */
export const WEB_MUTATION_LIMIT = 30;

/**
 * D1-backed, identity-keyed fixed-window limiter.
 *
 * The key contains only a verified identity key and route family; it deliberately never stores a
 * question or any browser-supplied value. D1's upsert keeps the state durable across isolate
 * eviction, unlike a module-level counter.
 */
export class D1RateLimiter {
  /**
   * @param database Authoritative D1 binding.
   */
  public constructor(private readonly database: D1Database) {}

  /**
   * Consume an operation slot or reject the request.
   *
   * @param identityKey Verified actor identity key.
   * @param operation Bounded route-family name.
   * @param now Evaluation instant.
   * @returns A promise fulfilled after one slot is consumed.
   * @throws {ProblemDetailsError} A 429 problem when the fixed window has no remaining capacity.
   * @throws {Error} When D1 rejects the counter write.
   */
  public async consume(identityKey: string, operation: string, now: Date): Promise<void> {
    const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
    const key = `${identityKey}:${operation}:${windowStart}`;
    await this.database
      .prepare(
        'INSERT INTO rate_limit_windows (key, window_start, count) VALUES (?1, ?2, 1) ON CONFLICT(key) DO UPDATE SET count = count + 1'
      )
      .bind(key, windowStart)
      .run();
    const row = await this.database
      .prepare('SELECT count FROM rate_limit_windows WHERE key = ?1')
      .bind(key)
      .first<{ count: number }>();
    if ((row?.count ?? WEB_MUTATION_LIMIT + 1) > WEB_MUTATION_LIMIT) {
      throw problemDetails({
        status: 429,
        title: 'Too Many Requests',
        detail: 'Too many requests. Please wait one minute before trying again.',
        extensions: { retryAfterSeconds: 60 }
      });
    }
  }
}
