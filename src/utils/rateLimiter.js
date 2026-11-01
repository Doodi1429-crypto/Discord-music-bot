/** Sliding-window rate limiter keyed by an arbitrary string (e.g. `${userId}:${command}`). */
export class RateLimiter {
  constructor({ limit, windowMs, now = () => Date.now() }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }

  /** Returns 0 if allowed, otherwise the milliseconds to wait. */
  check(key) {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((time) => t - time < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return this.windowMs - (t - recent[0]);
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) this.prune(t);
    return 0;
  }

  prune(t = this.now()) {
    for (const [key, times] of this.hits) {
      if (!times.some((time) => t - time < this.windowMs)) this.hits.delete(key);
    }
  }
}
