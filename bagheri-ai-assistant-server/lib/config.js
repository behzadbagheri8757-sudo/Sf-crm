'use strict';
/* Environment parsing. Pure: takes an env object, returns a frozen config. Never logs values. */

const DEFAULT_GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
// Placeholder default: NOT verified against current Groq documentation from the build environment.
const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile';

function intEnv(env, name, def, min, max) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error('Invalid value for ' + name + ' (expected integer ' + min + '..' + max + ')');
  }
  return n;
}

function boolEnv(env, name, def) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === '') return def;
  const v = String(raw).trim().toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw new Error('Invalid value for ' + name + ' (expected true/false)');
}

function listEnv(env, name) {
  const raw = env[name];
  if (!raw) return [];
  return String(raw).split(',').map(function (s) { return s.trim().replace(/\/+$/, ''); }).filter(Boolean);
}

function validBaseUrl(u) {
  if (/^https:\/\//i.test(u)) return true;
  // plain http only for loopback (used by tests against a mock upstream)
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(u);
}

function loadConfig(env) {
  env = env || process.env;
  const baseUrl = (env.GROQ_BASE_URL && String(env.GROQ_BASE_URL).trim()) || DEFAULT_GROQ_BASE_URL;
  if (!validBaseUrl(baseUrl)) throw new Error('GROQ_BASE_URL must be https (or loopback http for tests)');
  const apiKey = (env.GROQ_API_KEY && String(env.GROQ_API_KEY).trim()) || '';
  const token = (env.ASSISTANT_ACCESS_TOKEN && String(env.ASSISTANT_ACCESS_TOKEN).trim()) || '';
  const modelFromEnv = !!(env.GROQ_MODEL && String(env.GROQ_MODEL).trim());

  const cfg = {
    port: intEnv(env, 'PORT', 3000, 0, 65535),
    groq: {
      apiKey: apiKey,
      model: modelFromEnv ? String(env.GROQ_MODEL).trim() : DEFAULT_GROQ_MODEL,
      modelFromEnv: modelFromEnv,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      timeoutMs: intEnv(env, 'GROQ_TIMEOUT_MS', 20000, 100, 120000),
      maxCompletionTokens: intEnv(env, 'GROQ_MAX_COMPLETION_TOKENS', 800, 16, 4096),
    },
    auth: {
      token: token,
      allowUnauthenticated: boolEnv(env, 'ALLOW_UNAUTHENTICATED', false),
    },
    allowedOrigins: listEnv(env, 'ALLOWED_ORIGINS'),
    trustProxy: boolEnv(env, 'TRUST_PROXY', false),
    rate: {
      max: intEnv(env, 'RATE_LIMIT_MAX', 20, 1, 10000),
      windowMs: intEnv(env, 'RATE_LIMIT_WINDOW_MS', 60000, 100, 3600000),
      dailyCap: intEnv(env, 'DAILY_REQUEST_CAP', 500, 1, 1000000),
      authFailMax: 10,
      authFailWindowMs: 600000,
    },
    limits: {
      maxMessageChars: intEnv(env, 'MAX_MESSAGE_CHARS', 2000, 1, 20000),
      maxHistoryMessages: intEnv(env, 'MAX_HISTORY_MESSAGES', 10, 0, 50),
      maxBodyBytes: intEnv(env, 'MAX_BODY_BYTES', 16384, 512, 1048576),
      maxConcurrentUpstream: intEnv(env, 'MAX_CONCURRENT_UPSTREAM', 4, 1, 100),
      maxReplyChars: 6000,
    },
    enableTestPage: boolEnv(env, 'ENABLE_TEST_PAGE', false),
    logLevel: ['error', 'info', 'debug'].indexOf(env.LOG_LEVEL) >= 0 ? env.LOG_LEVEL : 'info',
  };
  return Object.freeze(cfg);
}

module.exports = { loadConfig, DEFAULT_GROQ_BASE_URL, DEFAULT_GROQ_MODEL };
