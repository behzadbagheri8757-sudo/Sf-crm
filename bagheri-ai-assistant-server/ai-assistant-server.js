'use strict';
/* BAGHERI CRM — AI assistant server (standalone, read-only, no CRM data access).
   Zero dependencies: Node >= 18 (built-in http + global fetch).
   Endpoints:  GET /health   POST /api/assistant/chat   (+ GET /test, /test.js when ENABLE_TEST_PAGE=true) */

const http = require('http');
const { loadConfig } = require('./lib/config');
const { buildMessages } = require('./lib/prompt');
const { validateChatBody } = require('./lib/validate');
const { createGroqClient } = require('./lib/groq');
const testPage = require('./lib/test-page');
const {
  sendJson, errorBody, readBody, SlidingWindowLimiter, clientKey, safeEqual, createLogger,
} = require('./lib/http-utils');

const SERVICE = 'bagheri-ai-assistant';
const VERSION = '0.1.0';

function createApp(config, deps) {
  deps = deps || {};
  const logger = deps.logger || createLogger(config.logLevel, [config.groq.apiKey, config.auth.token]);
  const groq = deps.groq || createGroqClient(config, deps.fetch);
  const limiter = new SlidingWindowLimiter(config.rate.max, config.rate.windowMs, deps.now);
  const authFailures = new SlidingWindowLimiter(config.rate.authFailMax, config.rate.authFailWindowMs, deps.now);
  const daily = { day: '', count: 0 };
  let inflight = 0;
  const startedAt = Date.now();

  function today() { return (deps.now ? new Date(deps.now()) : new Date()).toISOString().slice(0, 10); }

  function originCheck(req) {
    const origin = req.headers.origin;
    if (!origin) return { ok: true, headers: {} };
    let sameOrigin = false;
    try { sameOrigin = new URL(origin).host === req.headers.host; } catch (e) { sameOrigin = false; }
    if (sameOrigin) return { ok: true, headers: {} };
    if (config.allowedOrigins.indexOf(origin) >= 0) {
      return { ok: true, headers: { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } };
    }
    return { ok: false, headers: {} };
  }

  function bearer(req) {
    const h = String(req.headers.authorization || '');
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return m ? m[1].trim() : '';
  }

  function health(req, res) {
    const body = {
      status: 'ok',
      service: SERVICE,
      version: VERSION,
      mode: 'standalone',
      crmData: false,
      groqConfigured: !!config.groq.apiKey,
      authConfigured: !!config.auth.token || config.auth.allowUnauthenticated,
      model: config.groq.model,
      modelSource: config.groq.modelFromEnv ? 'env' : 'default-unverified',
      capabilities: { chat: true, crmContext: true, crmTools: false, writes: false },
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    };
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    sendJson(res, 200, body);
  }

  async function chat(req, res) {
    const origin = originCheck(req);
    if (!origin.ok) { sendJson(res, 403, errorBody('origin_not_allowed', 'این مبدأ مجاز نیست.')); return; }
    const cors = origin.headers;
    const reply = function (status, body, extra) { sendJson(res, status, body, Object.assign({}, cors, extra || {})); };

    const key = clientKey(req, config.trustProxy);

    // 1) rate limit (before auth, so token guessing is throttled too)
    const rl = limiter.hit(key);
    if (!rl.allowed) {
      reply(429, errorBody('rate_limited', 'تعداد درخواست‌ها زیاد است. کمی بعد دوباره تلاش کنید.', { retryAfterSec: rl.retryAfterSec }),
        { 'Retry-After': String(rl.retryAfterSec) });
      return;
    }
    const blocked = authFailures.check(key);
    if (!blocked.allowed) {
      reply(429, errorBody('too_many_auth_failures', 'تلاش‌های ناموفق زیاد بود. بعداً دوباره تلاش کنید.', { retryAfterSec: blocked.retryAfterSec }),
        { 'Retry-After': String(blocked.retryAfterSec) });
      return;
    }

    // 2) authentication (fail closed unless explicitly disabled for development)
    if (!config.auth.allowUnauthenticated) {
      if (!config.auth.token) { reply(503, errorBody('auth_not_configured', 'دسترسی دستیار هنوز پیکربندی نشده است.')); return; }
      const presented = bearer(req);
      if (!presented || !safeEqual(presented, config.auth.token)) {
        authFailures.record(key);
        reply(401, errorBody('unauthorized', 'توکن دسترسی نامعتبر است.'), { 'WWW-Authenticate': 'Bearer' });
        return;
      }
    }

    // 3) body
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (ct.indexOf('application/json') !== 0) { reply(415, errorBody('unsupported_media_type', 'Content-Type باید application/json باشد.')); return; }
    let raw;
    try { raw = await readBody(req, config.limits.maxBodyBytes, 10000); }
    catch (e) {
      const status = e && e.status ? e.status : 400;
      reply(status, errorBody(e && e.code ? e.code : 'bad_request', status === 413 ? 'حجم درخواست بیش از حد مجاز است.' : 'درخواست نامعتبر است.'),
        status === 413 ? { 'Connection': 'close' } : {});
      return;
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { reply(400, errorBody('invalid_json', 'بدنهٔ درخواست JSON معتبر نیست.')); return; }
    const v = validateChatBody(parsed, config.limits);
    if (!v.ok) { reply(v.status, errorBody(v.code, v.message)); return; }

    // 4) service readiness, quota, concurrency
    if (!config.groq.apiKey) { reply(503, errorBody('assistant_not_configured', 'سرویس دستیار هنوز پیکربندی نشده است.')); return; }
    const d = today();
    if (daily.day !== d) { daily.day = d; daily.count = 0; }
    if (daily.count >= config.rate.dailyCap) {
      reply(429, errorBody('daily_cap_reached', 'سقف درخواست روزانه پر شده است.'));
      return;
    }
    if (inflight >= config.limits.maxConcurrentUpstream) {
      reply(503, errorBody('busy', 'سرور مشغول است. کمی بعد دوباره تلاش کنید.'), { 'Retry-After': '5' });
      return;
    }

    // 5) upstream call
    daily.count++;
    inflight++;
    try {
      const out = await groq.chat(buildMessages(v.value.history, v.value.message, v.value.context, v.value.scope));
      const body = { ok: true, reply: out.reply, model: out.model, mode: !v.value.context ? 'standalone'
          : (v.value.scope === 'all' ? 'all-customers' : 'crm-context'), crmData: !!v.value.context };
      if (out.usage) body.usage = out.usage;
      reply(200, body);
    } catch (e) {
      const code = e && e.code ? e.code : 'internal_error';
      const status = e && e.httpStatus ? e.httpStatus : 500;
      logger.error('upstream_failure', { code: code, status: status });
      const messages = {
        upstream_timeout: 'پاسخ سرویس هوش مصنوعی دیر رسید. دوباره تلاش کنید.',
        upstream_rate_limited: 'سرویس هوش مصنوعی موقتاً محدود شده است. کمی بعد دوباره تلاش کنید.',
        upstream_unavailable: 'سرویس هوش مصنوعی در دسترس نیست. کمی بعد دوباره تلاش کنید.',
        assistant_not_configured: 'سرویس دستیار هنوز پیکربندی نشده است.',
      };
      const extra = e && e.retryAfterSec ? { 'Retry-After': String(e.retryAfterSec) } : {};
      reply(status, errorBody(code, messages[code] || 'خطا در ارتباط با سرویس هوش مصنوعی.',
        e && e.retryAfterSec ? { retryAfterSec: e.retryAfterSec } : undefined), extra);
    } finally {
      inflight--;
    }
  }

  async function route(req, res) {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (e) { pathname = '/'; }

    if (pathname === '/health') {
      if (req.method === 'GET' || req.method === 'HEAD') { health(req, res); return; }
      sendJson(res, 405, errorBody('method_not_allowed', 'متد مجاز نیست.'), { Allow: 'GET, HEAD' });
      return;
    }

    if (pathname === '/api/assistant/chat') {
      if (req.method === 'OPTIONS') {
        const o = originCheck(req);
        if (!o.ok) { sendJson(res, 403, errorBody('origin_not_allowed', 'این مبدأ مجاز نیست.')); return; }
        res.writeHead(204, Object.assign({
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Max-Age': '600',
          'Cache-Control': 'no-store',
        }, o.headers));
        res.end();
        return;
      }
      if (req.method === 'POST') { await chat(req, res); return; }
      sendJson(res, 405, errorBody('method_not_allowed', 'متد مجاز نیست.'), { Allow: 'POST, OPTIONS' });
      return;
    }

    if (config.enableTestPage && req.method === 'GET' && (pathname === '/test' || pathname === '/test.js')) {
      const isHtml = pathname === '/test';
      res.writeHead(200, {
        'Content-Type': isHtml ? 'text/html; charset=utf-8' : 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': testPage.PAGE_CSP,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(isHtml ? testPage.HTML : testPage.JS);
      return;
    }

    sendJson(res, 404, errorBody('not_found', 'مسیر پیدا نشد.'));
  }

  const server = http.createServer(function (req, res) {
    const t0 = Date.now();
    res.on('finish', function () {
      let p = '/';
      try { p = new URL(req.url, 'http://localhost').pathname; } catch (e) { /* keep '/' */ }
      logger.info('request', { method: req.method, path: p.slice(0, 80), status: res.statusCode, ms: Date.now() - t0 });
    });
    route(req, res).catch(function (e) {
      logger.error('unhandled', { message: e && e.message ? String(e.message).slice(0, 200) : 'unknown' });
      if (!res.headersSent) sendJson(res, 500, errorBody('internal_error', 'خطای داخلی سرور.'));
      else res.end();
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;

  const pruner = setInterval(function () { limiter.prune(); authFailures.prune(); }, 60000);
  pruner.unref();
  server.on('close', function () { clearInterval(pruner); });
  return server;
}

function start() {
  let config;
  try { config = loadConfig(process.env); }
  catch (e) { process.stderr.write('Configuration error: ' + e.message + '\n'); process.exit(1); return null; }
  const logger = createLogger(config.logLevel, [config.groq.apiKey, config.auth.token]);
  const server = createApp(config, { logger: logger });
  server.listen(config.port, '0.0.0.0', function () {
    logger.info('listening', {
      port: server.address().port,
      groqConfigured: !!config.groq.apiKey,
      authConfigured: !!config.auth.token || config.auth.allowUnauthenticated,
      model: config.groq.model,
      modelSource: config.groq.modelFromEnv ? 'env' : 'default-unverified',
      testPage: config.enableTestPage,
    });
    if (!config.groq.apiKey) logger.error('startup_warning', { message: 'GROQ_API_KEY is not set: chat will return 503' });
    if (!config.auth.token && !config.auth.allowUnauthenticated) logger.error('startup_warning', { message: 'ASSISTANT_ACCESS_TOKEN is not set: chat will return 503' });
    if (config.auth.allowUnauthenticated) logger.error('startup_warning', { message: 'ALLOW_UNAUTHENTICATED=true: endpoint is PUBLIC (development only)' });
  });
  function shutdown() { server.close(function () { process.exit(0); }); setTimeout(function () { process.exit(0); }, 5000).unref(); }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}

if (require.main === module) start();

module.exports = { createApp, start, SERVICE, VERSION };
