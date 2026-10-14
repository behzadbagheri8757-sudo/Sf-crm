'use strict';
/* Test helpers: a mock Groq upstream and an app launcher. No real network, no real keys. */
const http = require('http');
const { loadConfig } = require('../lib/config');
const { createApp } = require('../ai-assistant-server');
const { createLogger } = require('../lib/http-utils');

const FAKE_KEY = 'gsk_FAKE_TEST_KEY_do_not_use_1234567890';
const FAKE_TOKEN = 'test-access-token-abcdefghijklmnopqrstuvwxyz';

function listen(server) {
  return new Promise(function (resolve) { server.listen(0, '127.0.0.1', function () { resolve(server.address().port); }); });
}
function close(server) {
  return new Promise(function (resolve) { server.closeAllConnections && server.closeAllConnections(); server.close(function () { resolve(); }); });
}

/* Mock upstream. behaviour(req, body) -> { status, body, headers, delayMs } */
async function startMockGroq(behaviour) {
  const calls = [];
  const server = http.createServer(function (req, res) {
    const chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      const raw = Buffer.concat(chunks).toString('utf8');
      let json = null; try { json = JSON.parse(raw); } catch (e) { /* ignore */ }
      calls.push({ url: req.url, method: req.method, headers: req.headers, body: json });
      const r = (behaviour && behaviour(req, json, calls.length)) || {};
      const send = function () {
        res.writeHead(r.status || 200, Object.assign({ 'Content-Type': 'application/json' }, r.headers || {}));
        res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body !== undefined ? r.body : okBody('پاسخ آزمایشی')));
      };
      if (r.delayMs) setTimeout(send, r.delayMs); else send();
    });
  });
  const port = await listen(server);
  return { port: port, calls: calls, baseUrl: 'http://127.0.0.1:' + port + '/openai/v1', close: function () { return close(server); } };
}

function okBody(text, extra) {
  return Object.assign({
    id: 'x', object: 'chat.completion', model: 'mock-model',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
  }, extra || {});
}

/* Start the app against a mock upstream. envOverrides replace defaults; pass null to delete a key. */
async function startApp(envOverrides, opts) {
  opts = opts || {};
  const upstream = opts.upstream === false ? null : await startMockGroq(opts.behaviour);
  const env = Object.assign({
    GROQ_API_KEY: FAKE_KEY,
    ASSISTANT_ACCESS_TOKEN: FAKE_TOKEN,
    GROQ_MODEL: 'mock-model',
    GROQ_BASE_URL: upstream ? upstream.baseUrl : 'http://127.0.0.1:1/openai/v1',
    LOG_LEVEL: 'debug',
  }, envOverrides || {});
  Object.keys(env).forEach(function (k) { if (env[k] === null) delete env[k]; });
  const config = loadConfig(env);
  const logs = [];
  const logger = createLogger(config.logLevel, [config.groq.apiKey, config.auth.token], function (line) { logs.push(line); });
  const server = createApp(config, { logger: logger, now: opts.now });
  const port = await listen(server);
  const base = 'http://127.0.0.1:' + port;
  return {
    base: base, port: port, config: config, logs: logs, upstream: upstream,
    stop: async function () { await close(server); if (upstream) await upstream.close(); },
  };
}

async function post(app, body, headers, path) {
  const res = await fetch(app.base + (path || '/api/assistant/chat'), {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + FAKE_TOKEN }, headers || {}),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, headers: res.headers, text: text, json: json };
}

module.exports = { startMockGroq, startApp, post, okBody, FAKE_KEY, FAKE_TOKEN, listen, close };
