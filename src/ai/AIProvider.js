import { logger } from '../utils/logger.js';

export class AIProviderError extends Error {
  constructor(code, message = 'AI provider request failed') {
    super(message);
    this.name = 'AIProviderError';
    this.code = code;
  }
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
      if (response.status === 429) throw new AIProviderError('rate_limit');
      if (!response.ok) throw new AIProviderError(response.status >= 500 ? 'outage' : 'provider_failure');
      let body;
      try { body = await response.json(); } catch { throw new AIProviderError('malformed_response'); }
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new AIProviderError('malformed_response');
      logger.info('AI request completed', { provider: this.provider, durationMs: Date.now() - started });
      return content.trim();
    } catch (error) {
      if (error instanceof AIProviderError) {
        logger.warn('AI request failed', { code: error.code, durationMs: Date.now() - started });
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
