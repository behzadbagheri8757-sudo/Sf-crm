'use strict';
/* Small HTTP helpers: JSON responses, bounded body reader, sliding-window limiter, logger. */

const crypto = require('crypto');

function sendJson(res, status, body, extraHeaders) {
  const payload = JSON.stringify(body);
  const headers = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  }, extraHeaders || {});
  res.writeHead(status, headers);
  res.end(payload);
}

function errorBody(code, message, extra) {
  return { ok: false, error: Object.assign({ code: code, message: message }, extra || {}) };
}

/* Reads at most maxBytes. Rejects with { status, code } (413 too large, 408 timeout, 400 aborted). */
function readBody(req, maxBytes, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject({ status: 413, code: 'body_too_large' });
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    const timer = setTimeout(function () {
      if (done) return; done = true;
      reject({ status: 408, code: 'body_timeout' });
    }, timeoutMs || 10000);
    function finish(fn, arg) { if (done) return; done = true; clearTimeout(timer); fn(arg); }
    req.on('data', function (c) {
      if (done) return;
      size += c.length;
      if (size > maxBytes) { finish(reject, { status: 413, code: 'body_too_large' }); return; }
      chunks.push(c);
    });
    req.on('end', function () { finish(resolve, Buffer.concat(chunks).toString('utf8')); });
    req.on('error', function () { finish(reject, { status: 400, code: 'body_aborted' }); });
    req.on('aborted', function () { finish(reject, { status: 400, code: 'body_aborted' }); });
  });
}

/* Sliding-window counter per key. check() does not record; hit() = check + record. */
class SlidingWindowLimiter {
  constructor(max, windowMs, now) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now || Date.now;
    this.map = new Map();
  }
  _live(key) {
    const t = this.now();
    const arr = (this.map.get(key) || []).filter(function (x) { return x > t - this.windowMs; }, this);
    if (arr.length) this.map.set(key, arr); else this.map.delete(key);
    return arr;
  }
  check(key) {
    const arr = this._live(key);
    if (arr.length < this.max) return { allowed: true, retryAfterSec: 0 };
    const retry = Math.ceil((arr[0] + this.windowMs - this.now()) / 1000);
    return { allowed: false, retryAfterSec: Math.max(1, retry) };
  }
  record(key) {
    const arr = this._live(key);
    arr.push(this.now());
    this.map.set(key, arr);
  }
  hit(key) {
    const r = this.check(key);
    if (r.allowed) this.record(key);
    return r;
  }
  prune() {
    const self = this;
    Array.from(this.map.keys()).forEach(function (k) { self._live(k); });
  }
}

function clientKey(req, trustProxy) {
  if (trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] || '');
    const parts = xff.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    // the LAST entry is the one appended by the nearest trusted proxy; earlier ones are client-controlled
    if (parts.length) return parts[parts.length - 1];
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest(); }

function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

/* JSON-lines logger. Never logs bodies / headers / tokens; scrubs configured secrets and gsk_ keys. */
function createLogger(level, secrets, sink) {
  const order = { error: 0, info: 1, debug: 2 };
  const out = sink || function (line) { process.stdout.write(line + '\n'); };
  const secretList = (secrets || []).filter(function (s) { return s && String(s).length >= 6; }).map(String);
  function scrub(v) {
    if (typeof v !== 'string') return v;
    let s = v;
    secretList.forEach(function (sec) { s = s.split(sec).join('[redacted]'); });
    return s.replace(/gsk_[A-Za-z0-9_\-]+/g, '[redacted]');
  }
  function log(lvl, event, fields) {
    if (order[lvl] > order[level]) return;
    const rec = { t: new Date().toISOString(), level: lvl, event: event };
    Object.keys(fields || {}).forEach(function (k) {
      const v = fields[k];
      rec[k] = (typeof v === 'string') ? scrub(v) : (typeof v === 'number' || typeof v === 'boolean' ? v : undefined);
    });
    out(JSON.stringify(rec));
  }
  return {
    error: function (e, f) { log('error', e, f); },
    info: function (e, f) { log('info', e, f); },
    debug: function (e, f) { log('debug', e, f); },
  };
}

module.exports = { sendJson, errorBody, readBody, SlidingWindowLimiter, clientKey, safeEqual, createLogger };
