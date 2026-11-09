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

  // Provider messages can echo conversation text. Log only bounded structured codes.
  async describeErrorResponse(response) {
    try {
      const text = await response.text?.();
      if (!text) return null;
      const parsed = JSON.parse(text);
      const safeCode = value => {
        const code = String(value ?? '');
        return /^[a-zA-Z0-9_.-]{1,80}$/.test(code) && !code.includes(this.apiKey) ? code : undefined;
      };
      return { providerCode: safeCode(parsed?.error?.code), providerType: safeCode(parsed?.error?.type || parsed?.error?.status) };
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
        const providerDetails = await this.describeErrorResponse(response);
        const code = providerDetails?.providerCode === 'context_length_exceeded' ? 'context_too_large'
          : response.status === 401 || response.status === 403 ? 'authentication'
          : response.status === 404 ? 'model_or_endpoint_not_found'
            : response.status === 429 ? 'rate_limit' : response.status >= 500 ? 'outage' : 'provider_failure';
        logger.warn('AI request failed', {
          provider: this.provider,
          model: this.model,
          code,
          status: response.status,
          ...providerDetails,
          durationMs: Date.now() - started
        });
        const error = new AIProviderError(code);
        error.logged = true;
        throw error;
      }
      let body;
      try { body = await response.json(); } catch (error) {
        if (controller.signal.aborted) throw error;
        throw new AIProviderError('malformed_response');
      }
      const choice = body?.choices?.[0];
      const finishReason = choice?.finish_reason;
      if (finishReason && finishReason !== 'stop') {
        logger.warn('AI response incomplete', { provider: this.provider, model: this.model, finishReason, durationMs: Date.now() - started });
        const error = new AIProviderError('incomplete_response');
        error.logged = true;
        throw error;
      }
      const content = choice?.message?.content;
      if (typeof content !== 'string') throw new AIProviderError('malformed_response');
      if (!content.trim()) throw new AIProviderError('empty_response');
      logger.info('AI request completed', {
        provider: this.provider, model: this.model, durationMs: Date.now() - started, finishReason,
        promptTokens: body?.usage?.prompt_tokens, completionTokens: body?.usage?.completion_tokens
      });
      return content.trim();
    } catch (error) {
      if (error instanceof AIProviderError) {
        if (!error.logged) logger.warn('AI request failed', { provider: this.provider, model: this.model, code: error.code, durationMs: Date.now() - started });
        throw error;
      }
      const code = controller.signal.aborted ? 'timeout' : 'unavailable';
      logger.warn('AI request failed', { provider: this.provider, model: this.model, code, name: error?.name, causeCode: error?.cause?.code, durationMs: Date.now() - started });
      throw new AIProviderError(code);
    } finally {
      clearTimeout(timer);
    }
  }
}
