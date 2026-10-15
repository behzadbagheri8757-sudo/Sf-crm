/* js/views/assistant.js — Read-only, user-triggered CRM context for BAGHERI AI assistant.
   Sends only a selected customer's bounded summary after explicit consent.
   Access token is memory-only and never persisted. No CRM writes. */
'use strict';
(function (global) {
  const API_URL = 'https://sf-crm.onrender.com/api/assistant/chat';
  let currentRoot = null;
  let history = [];
  let busy = false;

  function safeText(v, max) {
    return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max || 240);
  }
  function money(v) {
    if (typeof toman === 'function') return safeText(toman(Math.abs(Number(v) || 0)), 40);
    return (Number(v) || 0).toLocaleString('fa-IR') + ' تومان';
  }
  function byDateDesc(a, b) {
    return String(b && b.date || '').localeCompare(String(a && a.date || ''));
  }
  function trimHistory(items, maxChars) {
    const out = [];
    let used = 0;
    for (let i = items.length - 1; i >= 0 && out.length < 6; i--) {
      const m = items[i];
      const remaining = maxChars - used;
      if (remaining <= 0) break;
      const content = safeText(m.content, Math.min(2000, remaining));
      if (!content) continue;
      out.unshift({ role: m.role, content: content });
      used += content.length;
    }
    return out;
  }
  function buildCustomerContext(cid) {
    if (!cid || typeof data === 'undefined' || !data) return '';
    const c = (data.customers || []).find(function (x) { return x && String(x.id) === String(cid); });
    if (!c) return '';
    const totals = typeof customerTotals === 'function' ? customerTotals(c.id) : null;
    const products = Object.create(null);
    (data.products || []).forEach(function (p) { if (p && p.id != null) products[String(p.id)] = p.name || p.title || 'کالای بدون نام'; });
    const customerInvoicesAll = (data.invoices || []).filter(function (i) { return i && String(i.customerId) === String(c.id); });
    const invoices = customerInvoicesAll.slice().sort(byDateDesc).slice(0, 5).map(function (inv) {
      return {
        date: safeText(inv.date, 20),
        total: Number(inv.total) || 0,
        items: (Array.isArray(inv.items) ? inv.items : []).slice(0, 12).map(function (it) {
          return { product: safeText(products[String(it.productId)] || 'کالای نامشخص', 80), qty: Number(it.qty) || 0 };
        })
      };
    });
    const visits = (Array.isArray(c.visits) ? c.visits : []).slice().sort(byDateDesc).slice(0, 4).map(function (v) {
      return {
        date: safeText(v.date, 20),
        result: safeText(v.result, 80),
        reason: safeText(v.reason || v.obstacle, 100),
        opportunity: safeText(v.opportunity, 100),
        nextAction: safeText(v.nextAction, 120),
        note: safeText(v.note || v.notes, 180)
      };
    });
    let action = null;
    try {
      const priority = typeof calculateCustomerPriority === 'function' ? calculateCustomerPriority(c.id) : null;
      action = typeof calculateCustomerAction === 'function' ? calculateCustomerAction(c.id, priority) : null;
    } catch (_e) {}
    const snapshot = {
      customer: safeText(c.name, 100),
      status: c.active === false ? 'inactive' : 'active',
      balanceFromCrmCalculation: totals ? Number(totals.balance) || 0 : null,
      invoiceCount: customerInvoicesAll.length,
      recentInvoices: invoices,
      recentVisits: visits,
      existingCrmRecommendation: action ? {
        action: safeText(action.action, 240),
        reason: safeText(action.reason, 240),
        urgency: safeText(action.urgency, 40),
        riskLevel: safeText(action.riskLevel, 40)
      } : null
    };
    let serialized = JSON.stringify(snapshot, null, 2);
    while (serialized.length > 2800 && snapshot.recentVisits.length) {
      snapshot.recentVisits.pop();
      serialized = JSON.stringify(snapshot, null, 2);
    }
    while (serialized.length > 2800 && snapshot.recentInvoices.length) {
      snapshot.recentInvoices.pop();
      serialized = JSON.stringify(snapshot, null, 2);
    }
    if (serialized.length > 2800) {
      snapshot.existingCrmRecommendation = null;
      serialized = JSON.stringify(snapshot, null, 2);
    }
    return serialized;
  }

  function appendMessage(role, content) {
    const list = currentRoot && currentRoot.querySelector('[data-chat-messages]');
    if (!list) return;
    const item = document.createElement('div');
    item.className = 'baqeri-ai-message ' + (role === 'user' ? 'is-user' : 'is-assistant');
    item.textContent = content;
    list.appendChild(item);
    list.scrollTop = list.scrollHeight;
  }
  function setStatus(msg, isError) {
    const el = currentRoot && currentRoot.querySelector('[data-chat-status]');
    if (el) { el.textContent = msg || ''; el.classList.toggle('is-error', !!isError); }
  }
  function updateBusy(value) {
    busy = value;
    if (!currentRoot) return;
    const b = currentRoot.querySelector('[data-chat-send]');
    const input = currentRoot.querySelector('[data-chat-input]');
    if (b) { b.disabled = value; b.textContent = value ? 'در حال پاسخ‌گویی…' : 'ارسال پیام'; }
    if (input) input.disabled = value;
  }

  function mount(root) {
    currentRoot = root;
    history = [];
    busy = false;
    root.innerHTML = `
      <section class="baqeri-ai-page" dir="rtl">
        <header class="baqeri-ai-heading">
          <div class="baqeri-ai-mark" aria-hidden="true">✦</div>
          <div><h2>دستیار فروش باقری</h2><p>مشاوره فروش با امکان استفادهٔ انتخابی از داده‌های CRM</p></div>
        </header>
        <div class="baqeri-ai-notice"><strong>حریم خصوصی:</strong> توکن فقط در حافظهٔ همین صفحه می‌ماند. اگر مشتری انتخاب کنی و رضایت ارسال را فعال کنی، خلاصهٔ محدود او برای تحلیل به سرور و سرویس Groq ارسال می‌شود. هیچ داده‌ای در CRM ثبت یا تغییر نمی‌کند.</div>
        <label class="baqeri-ai-label" for="baqeri-ai-token">توکن دسترسی سرور</label>
        <input id="baqeri-ai-token" class="baqeri-ai-input" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="توکن ASSISTANT_ACCESS_TOKEN را وارد کن">
        <label class="baqeri-ai-label" for="baqeri-ai-customer">زمینهٔ گفت‌وگو</label>
   <select id="baqeri-ai-customer" class="baqeri-ai-input" data-chat-customer>
          <option value="">گفت‌وگوی عمومی، بدون ارسال اطلاعات CRM</option>
        </select>
        <label class="baqeri-ai-consent"><input type="checkbox" data-chat-consent> اجازه می‌دهم خلاصهٔ محدود مشتری انتخاب‌شده برای این گفت‌وگو ارسال شود.</label>
        <div class="baqeri-ai-messages" data-chat-messages aria-live="polite"><div class="baqeri-ai-message is-assistant">برای شروع، توکن سرور را وارد کن. می‌توانی گفت‌وگوی عمومی داشته باشی یا مشتری مشخصی را انتخاب کنی.</div></div>
        <div class="baqeri-ai-composer">
          <textarea class="baqeri-ai-input baqeri-ai-textarea" data-chat-input rows="3" maxlength="2000" placeholder="مثلاً برای ویزیت بعدی این مشتری چه پیشنهادی بدهم؟"></textarea>
          <button class="btn primary" type="button" data-chat-send>ارسال پیام</button>
        </div>
        <p class="baqeri-ai-status" data-chat-status role="status"></p>
        <button class="btn secondary" type="button" data-chat-clear>شروع گفت‌وگوی تازه</button>
      </section>
      <style>
        .baqeri-ai-page{width:100%;max-width:760px;min-width:0;box-sizing:border-box;margin:0 auto;padding:14px 14px calc(32px + env(safe-area-inset-bottom));color:var(--ink);display:flex;flex-direction:column;gap:14px;overflow-wrap:anywhere}
        .baqeri-ai-heading{display:flex;align-items:center;gap:12px;min-width:0}.baqeri-ai-heading>div:last-child{min-width:0}.baqeri-ai-heading h2{margin:0;font-size:1.12rem;line-height:1.5;font-weight:800}.baqeri-ai-heading p{margin:4px 0 0;font-size:.82rem;line-height:1.7;color:var(--ink-soft)}
        .baqeri-ai-mark{flex:0 0 42px;width:42px;height:42px;border-radius:14px;background:var(--surface-raised,#eef5ff);display:grid;place-items:center;color:#0070D2;font-size:1.4rem}
        .baqeri-ai-notice{font-size:.82rem;line-height:1.9;padding:12px 14px;border-radius:14px;background:var(--surface-secondary,#f5f6f8);color:var(--ink-soft)}
        .baqeri-ai-label{font-size:.86rem;font-weight:700;margin-bottom:-7px}.baqeri-ai-input{display:block;width:100%;min-width:0;box-sizing:border-box;border:1px solid var(--line,#d9dce2);border-radius:13px;padding:12px 13px;font:inherit;font-size:16px;line-height:1.65;background:var(--surface,#fff);color:var(--ink)}
        .baqeri-ai-consent{display:flex;gap:9px;align-items:flex-start;font-size:.82rem;line-height:1.8;color:var(--ink-soft)}.baqeri-ai-consent input{margin-top:6px;flex-shrink:0}
        .baqeri-ai-messages{display:flex;flex-direction:column;align-items:stretch;gap:12px;width:100%;min-width:0;min-height:180px;max-height: min(58dvh, 620px);overflow-x:hidden;overflow-y:auto;overscroll-behavior-y:contain;-webkit-overflow-scrolling:touch;scrollbar-gutter:stable;padding:8px 2px 12px;box-sizing:border-box;border:1px solid var(--line,#e0e3e8);border-radius:16px;background:var(--surface,#fff)}
        .baqeri-ai-message{display:block;box-sizing:border-box;white-space:pre-wrap;overflow-wrap:anywhere;word-break:normal;line-height:1.9;font-size:1rem;padding:13px 14px;border-radius:14px;width:100%;max-width:100%;min-width:0;margin:0}
        .baqeri-ai-message.is-assistant{align-self:stretch;background:var(--surface-secondary,#f3f4f6);color:var(--ink)}.baqeri-ai-message.is-user{align-self:flex-end;width:auto;max-width:92%;background:#e7f1ff;color:#12375b}
        .baqeri-ai-composer{display:flex;flex-direction:column;gap:9px;min-width:0}.baqeri-ai-textarea{resize:vertical;min-height:88px;max-height:32vh}.baqeri-ai-composer .btn{min-height:48px;font-size:.95rem}
        .baqeri-ai-status{font-size:.82rem;line-height:1.7;color:var(--ink-soft);margin:0;min-height:1.2em}.baqeri-ai-status.is-error{color:#c43d35}
        .baqeri-ai-page button,.baqeri-ai-page select,.baqeri-ai-page textarea,.baqeri-ai-page input{touch-action:manipulation}
        @media(max-width:480px){.baqeri-ai-page{padding-inline:10px;gap:12px}.baqeri-ai-message{font-size:.98rem;padding:12px 12px;line-height:1.9}.baqeri-ai-messages{max-height:56dvh}.baqeri-ai-notice{padding:11px 12px}}
        @media(prefers-reduced-motion:reduce){.baqeri-ai-messages{scroll-behavior:auto}}
      </style>`;
    const customerSelect = root.querySelector('[data-chat-customer]');
    (data.customers || []).filter(function (c) { return c && c.id != null; }).slice().sort(function (a, b) {
      return String(a.name || '').localeCompare(String(b.name || ''), 'fa');
    }).forEach(function (c) {
      const option = document.createElement('option');
      option.value = String(c.id);
      option.textContent = safeText(c.name || 'مشتری بدون نام', 100);
      customerSelect.appendChild(option);
    });

    async function send() {
      if (busy) return;
      const tokenInput = root.querySelector('#baqeri-ai-token');
      const messageInput = root.querySelector('[data-chat-input]');
      const customerId = customerSelect.value;
      const message = String(messageInput.value || '').trim();
      const token = String(tokenInput.value || '').trim();
      if (!token) { setStatus('توکن دسترسی سرور را وارد کن.', true); tokenInput.focus(); return; }
      if (!message) { setStatus('پیام خالی است.', true); messageInput.focus(); return; }
      if (customerId && !root.querySelector('[data-chat-consent]').checked) {
        setStatus('برای ارسال خلاصهٔ مشتری، ابتدا رضایت ارسال را فعال کن.', true); return;
      }
      const context = customerId ? buildCustomerContext(customerId) : '';
      if (customerId && !context) { setStatus('خلاصهٔ مشتری ساخته نشد؛ دوباره صفحه را باز کن.', true); return; }
      appendMessage('user', message);
      history.push({ role: 'user', content: message });
      messageInput.value = '';
      updateBusy(true);
      setStatus(context ? 'در حال ارسال پیام همراه خلاصهٔ انتخابی CRM…' : 'در حال دریافت پاسخ…', false);
      try {
        const response = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ message: message, history: trimHistory(history.slice(0, -1), context ? 1500 : 3000), context: context || undefined })
        });
        let body;
        try { body = await response.json(); } catch (_e) { body = null; }
        if (!response.ok || !body || !body.ok || typeof body.reply !== 'string') {
          const code = body && body.error && body.error.code;
          const messages = {
            unauthorized: 'توکن دسترسی نادرست است.',
            origin_not_allowed: 'مبدأ CRM هنوز در ALLOWED_ORIGINS سرور مجاز نشده است.',
            upstream_model_unavailable: 'مدل تنظیم‌شده در Groq در دسترس نیست.',
            daily_cap_reached: 'سقف روزانهٔ درخواست‌های سرور پر شده است.',
            rate_limited: 'تعداد درخواست‌ها زیاد است؛ کمی بعد دوباره تلاش کن.',
            context_too_long: 'خلاصهٔ CRM بیش از حد طولانی است.'
          };
          throw new Error(messages[code] || ('پاسخ سرور ناموفق بود' + (code ? ' (' + code + ')' : '') + '.'));
        }
        appendMessage('assistant', body.reply);
        history.push({ role: 'assistant', content: body.reply });
        if (history.length > 10) history = history.slice(-10);
        setStatus(context ? 'پاسخ بر اساس خلاصهٔ انتخابی CRM تولید شد؛ صحت توصیه را با داده‌ها تطبیق بده.' : 'پاسخ دریافت شد.', false);
      } catch (e) {
        // Do not log token, payload, or customer context.
        history.pop();
        setStatus(e && e.message ? e.message : 'خطا در ارتباط با سرور.', true);
      } finally {
        updateBusy(false);
      }
    }

    root.querySelector('[data-chat-send]').addEventListener('click', send);
    root.querySelector('[data-chat-input]').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    root.querySelector('[data-chat-clear]').addEventListener('click', function () {
      history = [];
      const messages = root.querySelector('[data-chat-messages]');
      messages.textContent = '';
      appendMessage('assistant', 'گفت‌وگوی تازه شروع شد. اگر لازم است، دوباره مشتری را انتخاب و ارسال اطلاعات را تأیید کن.');
      setStatus('', false);
    });
    return function unmount() {
      history = [];
      currentRoot = null;
      busy = false;
      root.innerHTML = '';
    };
  }
  global.AssistantView = { mount: mount };
})(typeof window !== 'undefined' ? window : this);
