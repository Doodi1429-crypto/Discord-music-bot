import { logger } from '../utils/logger.js';

export class AIProviderError extends Error {
  constructor(code, message = 'AI provider request failed') {
    super(message);
    this.name = 'AIProviderError';
    this.code = code;
  }
}

/**
 * Redacts anything that looks like a credential/secret from a string before it is
 * logged: the configured API key value itself (if present verbatim), Authorization
 * headers, and generic key=/token=/secret= style fields. Used for provider error
 * diagnostics, which may otherwise echo request fragments back from the API.
 */
export function redactSecrets(text, sensitiveValues = []) {
  if (!text || typeof text !== 'string') return text;
  let sanitized = text;
  for (const value of sensitiveValues) {
    if (value && typeof value === 'string' && value.length > 3) {
      sanitized = sanitized.split(value).join('[REDACTED]');
    }
  }
  return sanitized
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, '******')
    .replace(/((?:authorization|api[-_]?key|access[-_]?token|secret|password)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s&;,"']+)/gi, '$1[REDACTED]');
}

export class AIProvider {
  constructor({ apiKey, model, apiUrl, timeoutMs, fetchImpl = fetch, provider = 'gemini' }) {
    if (!apiKey) throw new AIProviderError('missing_credentials', 'AI credentials are not configured');
    this.apiKey = apiKey;
    this.model = model;
    this.apiUrl = apiUrl;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.provider = provider;
    logger.info('AI provider initialized', { provider, model });
  }

  /**
   * Best-effort extraction of a short, redacted error message/code from a failed
   * provider HTTP response, for safe diagnostics only. Never throws: any failure to
   * read/parse the body simply yields no message. The API key/authorization header
   * are never part of a response body, but this still redacts defensively in case the
   * provider ever echoes request fragments back in its error payload.
   */
  async describeErrorResponse(response) {
    try {
      const text = await response.text?.();
      if (!text) return null;
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      const raw = parsed?.error?.message || parsed?.error?.code || parsed?.message || text;
      return redactSecrets(String(raw), [this.apiKey]).slice(0, 300);
    } catch {
      return null;
    }
  }

  async generate(messages) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.apiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.apiKey },
        body: JSON.stringify({ model: this.model, messages }),
        signal: controller.signal
      });
      if (!response.ok) {
        const code = response.status === 429 ? 'rate_limit' : response.status >= 500 ? 'outage' : 'provider_failure';
        const providerMessage = await this.describeErrorResponse(response);
        logger.warn('AI request failed', {
          provider: this.provider,
          code,
          status: response.status,
          providerMessage,
          durationMs: Date.now() - started
        });
        const error = new AIProviderError(code);
        error.logged = true;
        throw error;
      }
      let body;
      try { body = await response.json(); } catch { throw new AIProviderError('malformed_response'); }
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new AIProviderError('malformed_response');
      logger.info('AI request completed', { provider: this.provider, durationMs: Date.now() - started });
      return content.trim();
    } catch (error) {
      if (error instanceof AIProviderError) {
        if (!error.logged) logger.warn('AI request failed', { code: error.code, durationMs: Date.now() - started });
        throw error;
      }
      const code = error?.name === 'AbortError' ? 'timeout' : 'unavailable';
      logger.warn('AI request failed', { code, durationMs: Date.now() - started });
      throw new AIProviderError(code);
    } finally {
      clearTimeout(timer);
    }
  }
}
