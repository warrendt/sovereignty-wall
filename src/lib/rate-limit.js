/**
 * Fixed-cost sliding-window rate limiter.
 *
 * In-process only, which is fine because this app is pinned to a single
 * instance (the SSE fan-out requires that anyway).
 */
export const createRateLimiter = ({ max, windowMs, now = () => Date.now(), maxKeys = 10_000 }) => {
  if (!Number.isFinite(max) || max <= 0) throw new TypeError('max must be a positive number');
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new TypeError('windowMs must be a positive number');
  }

  /** @type {Map<string, number[]>} key -> hit timestamps, ascending */
  const hits = new Map();

  const pruneKey = (key, cutoff) => {
    const timestamps = hits.get(key);
    if (!timestamps) return null;

    // Timestamps are ascending, so drop from the front.
    let firstLive = 0;
    while (firstLive < timestamps.length && timestamps[firstLive] <= cutoff) firstLive += 1;

    if (firstLive === timestamps.length) {
      hits.delete(key);
      return null;
    }
    if (firstLive > 0) timestamps.splice(0, firstLive);
    return timestamps;
  };

  /** Drop every fully expired key. Cheap, and keeps the map bounded. */
  const sweep = (timestamp = now()) => {
    const cutoff = timestamp - windowMs;
    for (const key of [...hits.keys()]) pruneKey(key, cutoff);
  };

  /**
   * Record an attempt for `key`.
   * @returns {{allowed: boolean, remaining: number, retryAfterMs: number}}
   */
  const consume = (key) => {
    const timestamp = now();
    const cutoff = timestamp - windowMs;
    const id = String(key ?? 'unknown');

    if (hits.size > maxKeys) sweep(timestamp);

    const timestamps = pruneKey(id, cutoff) ?? [];

    if (timestamps.length >= max) {
      const retryAfterMs = Math.max(1, timestamps[0] + windowMs - timestamp);
      return { allowed: false, remaining: 0, retryAfterMs };
    }

    timestamps.push(timestamp);
    if (!hits.has(id)) hits.set(id, timestamps);

    return { allowed: true, remaining: max - timestamps.length, retryAfterMs: 0 };
  };

  return {
    consume,
    sweep,
    get size() {
      return hits.size;
    },
  };
};
