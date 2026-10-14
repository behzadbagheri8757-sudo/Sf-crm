'use strict';
/* Groq chat-completions client (OpenAI-compatible endpoint). Server-side only.
   - The API key is read from config (process.env.GROQ_API_KEY) and only ever placed in the
     Authorization header of the upstream request.
   - Upstream response bodies / error texts are NEVER forwarded to callers or logs. */

class UpstreamError extends Error {
  constructor(code, httpStatus, retryAfterSec) {
    super(code);
    this.name = 'UpstreamError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryAfterSec = retryAfterSec || null;
  }
}

function parseRetryAfter(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.ceil(n), 120);
}

function mapStatus(status, retryAfterHeader) {
  if (status === 401 || status === 403) return new UpstreamError('upstream_auth_failed', 502);
  if (status === 429) return new UpstreamError('upstream_rate_limited', 429, parseRetryAfter(retryAfterHeader));
  if (status === 404) return new UpstreamError('upstream_model_unavailable', 502);
  if (status === 400 || status === 422) return new UpstreamError('upstream_bad_request', 502);
  if (status >= 500) return new UpstreamError('upstream_unavailable', 503);
  return new UpstreamError('upstream_error', 502);
}

function pickUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const out = {};
  ['prompt_tokens', 'completion_tokens', 'total_tokens'].forEach(function (k) {
    if (typeof u[k] === 'number' && Number.isFinite(u[k])) out[k] = u[k];
  });
  return Object.keys(out).length ? out : null;
}

function createGroqClient(config, fetchImpl) {
  const doFetch = fetchImpl || fetch;

  async function chat(messages) {
    if (!config.groq.apiKey) throw new UpstreamError('assistant_not_configured', 503);

    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, config.groq.timeoutMs);
    let status;
    let retryAfter = null;
    let text;
    try {
      const res = await doFetch(config.groq.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + config.groq.apiKey,
        },
        body: JSON.stringify({
          model: config.groq.model,
          messages: messages,
          temperature: 0.3,
          max_completion_tokens: config.groq.maxCompletionTokens,
        }),
        signal: controller.signal,
      });
      status = res.status;
      retryAfter = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
      text = await res.text();               // body read is covered by the same timeout
    } catch (e) {
      if (e && e.name === 'AbortError') throw new UpstreamError('upstream_timeout', 504);
      throw new UpstreamError('upstream_unreachable', 502);
    } finally {
      clearTimeout(timer);
    }

    if (status < 200 || status >= 300) throw mapStatus(status, retryAfter);
    if (typeof text !== 'string' || text.length === 0 || text.length > 1000000) {
      throw new UpstreamError('upstream_bad_response', 502);
    }

    let data;
    try { data = JSON.parse(text); } catch (e) { throw new UpstreamError('upstream_bad_response', 502); }
    const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
    const content = choice && choice.message && typeof choice.message.content === 'string'
      ? choice.message.content.trim() : '';
    if (!content) throw new UpstreamError('upstream_bad_response', 502);

    const max = config.limits.maxReplyChars;
    return {
      reply: content.length > max ? content.slice(0, max) + '…' : content,
      model: typeof data.model === 'string' ? data.model.slice(0, 80) : config.groq.model,
      usage: pickUsage(data.usage),
    };
  }

  return { chat: chat };
}

module.exports = { createGroqClient, UpstreamError };
