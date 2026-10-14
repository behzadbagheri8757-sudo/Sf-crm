'use strict';
/* Request validation for POST /api/assistant/chat.
   Strict allow-list: only { message, history }. Anything else (tools, actions, model, system,
   operations ...) is rejected, so no write / tool / prompt-override path exists. */

const ALLOWED_BODY_KEYS = { message: true, history: true };
const ALLOWED_HISTORY_KEYS = { role: true, content: true };

function fail(code, message, status) {
  return { ok: false, status: status || 400, code: code, message: message };
}

function cleanText(s) {
  // drop control characters except tab / newline / carriage return
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
}

function validateChatBody(body, limits) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return fail('invalid_body', 'بدنهٔ درخواست باید یک شیء JSON باشد.');
  }
  const keys = Object.keys(body);
  for (let i = 0; i < keys.length; i++) {
    if (!ALLOWED_BODY_KEYS[keys[i]]) {
      return fail('unsupported_field', 'این نسخه فقط گفت‌وگوی خواندنی است؛ فیلد یا عملیات «' + keys[i].slice(0, 40) + '» پشتیبانی نمی‌شود.');
    }
  }

  if (typeof body.message !== 'string') return fail('invalid_message', 'فیلد message باید متن باشد.');
  const message = cleanText(body.message);
  if (!message) return fail('empty_message', 'پیام خالی است.');
  if (message.length > limits.maxMessageChars) {
    return fail('message_too_long', 'پیام بیش از حد طولانی است (حداکثر ' + limits.maxMessageChars + ' نویسه).');
  }

  let history = [];
  if (body.history !== undefined) {
    if (!Array.isArray(body.history)) return fail('invalid_history', 'فیلد history باید آرایه باشد.');
    if (body.history.length > limits.maxHistoryMessages) {
      return fail('history_too_long', 'تاریخچهٔ گفت‌وگو بیش از حد است (حداکثر ' + limits.maxHistoryMessages + ' پیام).');
    }
    for (let i = 0; i < body.history.length; i++) {
      const m = body.history[i];
      if (m === null || typeof m !== 'object' || Array.isArray(m)) return fail('invalid_history', 'ساختار history نامعتبر است.');
      const mk = Object.keys(m);
      for (let j = 0; j < mk.length; j++) {
        if (!ALLOWED_HISTORY_KEYS[mk[j]]) return fail('invalid_history', 'ساختار history نامعتبر است.');
      }
      if (m.role !== 'user' && m.role !== 'assistant') {
        return fail('invalid_history', 'نقش پیام در history باید user یا assistant باشد.');
      }
      if (typeof m.content !== 'string') return fail('invalid_history', 'متن پیام در history نامعتبر است.');
      const c = cleanText(m.content);
      if (!c || c.length > limits.maxMessageChars) return fail('invalid_history', 'متن پیام در history نامعتبر یا طولانی است.');
      history.push({ role: m.role, content: c });
    }
  }
  return { ok: true, value: { message: message, history: history } };
}

module.exports = { validateChatBody };
