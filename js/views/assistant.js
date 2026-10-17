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
  function cleanReply(text) {
    return String(text == null ? '' : text)
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .replace(/(^|[^\*])\*([^\*\n]+)\*(?!\*)/g, '$1$2')
      .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1$2')
      .replace(/^\s*(?:---|___|\*\*\*)\s*$/gm, '')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/^\s*[-*]\s+/gm, '• ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
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
    const invoices = customerInvoicesAll.slice().sort(byDateDesc).slice(0, 8).map(function (inv) {
      return {
        date: safeText(inv.date, 20),
        total: Number(inv.total) || 0,
        items: (Array.isArray(inv.items) ? inv.items : []).slice(0, 12).map(function (it) {
          return { product: safeText(products[String(it.productId)] || 'کالای نامشخص', 80), qty: Number(it.qty) || 0 };
        })
      };
    });
    const visits = (Array.isArray(c.visits) ? c.visits : []).slice().sort(byDateDesc).slice(0, 8).map(function (v) {
      return {
        date: safeText(v.date, 20),
        result: safeText(v.result, 80),
        reason: safeText(v.reason || v.obstacle, 100),
        opportunity: safeText(v.opportunity, 100),
        nextAction: safeText(v.nextAction, 120),
        note: safeText(v.note || v.notes, 180)
      };
    });
    const payments = (data.payments || [])
      .filter(function (p) { return p && String(p.customerId) === String(c.id); })
      .slice().sort(byDateDesc).slice(0, 8)
      .map(function (p) {
        return {
          date: safeText(p.date, 20),
          amount: Number(p.amount) || 0,
          method: safeText(p.method, 20),
          note: safeText(p.note, 120)
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
      recentPayments: payments,
      note: 'همهٔ مبالغ به تومان است. تاریخها میلادی (YYYY-MM-DD).',
      existingCrmRecommendation: action ? {
        action: safeText(action.action, 240),
        reason: safeText(action.reason, 240),
        urgency: safeText(action.urgency, 40),
        riskLevel: safeText(action.riskLevel, 40)
      } : null
    };
    let serialized = JSON.stringify(snapshot, null, 2);
    while (serialized.length > 7000 && snapshot.recentVisits.length) {
      snapshot.recentVisits.pop();
      serialized = JSON.stringify(snapshot, null, 2);
    }
    while (serialized.length > 7000 && snapshot.recentInvoices.length) {
      snapshot.recentInvoices.pop();
      serialized = JSON.stringify(snapshot, null, 2);
    }
    if (serialized.length > 7000) {
      snapshot.existingCrmRecommendation = null;
      serialized = JSON.stringify(snapshot, null, 2);
    }
    return serialized;
  }

  function buildSelectedCustomersContext(ids) {
    if (typeof data === 'undefined' || !data || !Array.isArray(data.customers)) return '';
    if (!Array.isArray(ids) || ids.length === 0) return '';
    const idSet = Object.create(null);
    ids.forEach(function (id) { idSet[String(id)] = true; });
    const customers = data.customers
      .filter(function (c) { return c && c.id != null && idSet[String(c.id)]; })
      .map(function (c) {
        const totals = typeof customerTotals === 'function' ? customerTotals(c.id) : null;
        const invoices = (data.invoices || [])
          .filter(function (i) { return i && String(i.customerId) === String(c.id); })
          .slice().sort(byDateDesc).slice(0, 5)
          .map(function (inv) { return { date: safeText(inv.date, 20), total: Number(inv.total) || 0 }; });
        const visits = (Array.isArray(c.visits) ? c.visits : []).slice().sort(byDateDesc).slice(0, 5).map(function (v) {
          return {
            date: safeText(v.date, 20),
            result: safeText(v.result, 80),
            reason: safeText(v.reason || v.obstacle, 100),
            nextAction: safeText(v.nextAction, 120)
          };
        });
        const payments = (data.payments || [])
          .filter(function (p) { return p && String(p.customerId) === String(c.id); })
          .slice().sort(byDateDesc).slice(0, 5)
          .map(function (p) {
            return {
              date: safeText(p.date, 20),
              amount: Number(p.amount) || 0,
              method: safeText(p.method, 20)
            };
          });
        return {
          name: safeText(c.name, 100),
          status: c.active === false ? 'inactive' : 'active',
          balance: totals ? Number(totals.balance) || 0 : null,
          recentInvoices: invoices,
          recentVisits: visits,
          recentPayments: payments
        };
      });
    return JSON.stringify({
      note: 'همهٔ مبالغ به تومان است. تاریخ‌ها میلادی (YYYY-MM-DD). فقط مشتریان انتخاب‌شده. هر بخش حداکثر ۵ مورد آخر.',
      customers: customers
    });
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
        <label class="baqeri-ai-label">انتخاب مشتری‌ها (حداکثر ۵ نفر برای هر پیام)</label>
        <div class="baqeri-ai-picker">
          <div class="baqeri-ai-picker-list" data-customer-list></div>
          <p class="baqeri-ai-counter" data-customer-counter>هیچ مشتری انتخاب نشده — پیام عمومی ارسال می‌شود</p>
        </div>
        <label class="baqeri-ai-consent"><input type="checkbox" data-chat-consent> اجازه می‌دهم خلاصهٔ محدود مشتریان انتخاب‌شده برای این گفت‌وگو ارسال شود.</label>
        <div class="baqeri-ai-messages" data-chat-messages aria-live="polite"><div class="baqeri-ai-message is-assistant">برای شروع، توکن سرور را وارد کن. می‌توانی گفت‌وگوی عمومی داشته باشی یا مشتری مشخصی را انتخاب کنی.</div></div>
        <div class="baqeri-ai-composer">
          <textarea class="baqeri-ai-input baqeri-ai-textarea" data-chat-input rows="3" maxlength="2000" placeholder="مثلاً برای ویزیت بعدی این مشتری چه پیشنهادی بدهم؟"></textarea>
          <button class="btn primary" type="button" data-chat-send>ارسال پیام</button>
        </div>
        <p class="baqeri-ai-status" data-chat-status role="status"></p>
        <button class="btn secondary" type="button" data-chat-clear>شروع گفت‌وگوی تازه</button>
      </section>
      <style>
        .baqeri-ai-page{width:100%;max-width:760px;min-width:0;box-sizing:border-box;margin:0 auto;padding:14px 14px calc(32px + env(safe-area-inset-bottom));color:var(--vg-color-text);display:flex;flex-direction:column;gap:14px;overflow-wrap:anywhere}
        .baqeri-ai-heading{display:flex;align-items:center;gap:12px;min-width:0}.baqeri-ai-heading>div:last-child{min-width:0}.baqeri-ai-heading h2{margin:0;font-size:1.12rem;line-height:1.5;font-weight:800;color:var(--vg-color-text)}.baqeri-ai-heading p{margin:4px 0 0;font-size:.82rem;line-height:1.7;color:var(--vg-color-text-muted)}
        .baqeri-ai-mark{flex:0 0 42px;width:42px;height:42px;border-radius:var(--vg-radius-soft);background:var(--vg-color-primary-soft);display:grid;place-items:center;color:var(--vg-color-primary);font-size:1.4rem}
        .baqeri-ai-notice{font-size:.82rem;line-height:1.9;padding:12px 14px;border-radius:var(--vg-radius-soft);background:var(--vg-color-surface-soft);color:var(--vg-color-text-muted);border:1px solid var(--vg-color-divider)}
        .baqeri-ai-label{font-size:.86rem;font-weight:var(--vg-weight-title);margin-bottom:-7px;color:var(--vg-color-text)}
        .baqeri-ai-input{display:block;width:100%;min-width:0;box-sizing:border-box;border:1px solid var(--vg-color-border);border-radius:var(--vg-radius-soft);padding:12px 13px;font:inherit;font-size:16px;line-height:1.65;background:var(--vg-color-surface);color:var(--vg-color-text)}
        .baqeri-ai-consent{display:flex;gap:9px;align-items:flex-start;font-size:.82rem;line-height:1.8;color:var(--vg-color-text-muted)}.baqeri-ai-consent input{margin-top:6px;flex-shrink:0}
        .baqeri-ai-messages{display:flex;flex-direction:column;align-items:stretch;gap:12px;width:100%;min-width:0;min-height:180px;max-height:min(58dvh, 620px);overflow-x:hidden;overflow-y:auto;overscroll-behavior-y:contain;-webkit-overflow-scrolling:touch;scrollbar-gutter:stable;padding:8px 2px 12px;box-sizing:border-box;border:1px solid var(--vg-color-border);border-radius:var(--vg-radius-raised);background:var(--vg-color-surface)}
        .baqeri-ai-message{display:block;box-sizing:border-box;white-space:pre-wrap;overflow-wrap:anywhere;word-break:normal;line-height:1.9;font-size:1rem;padding:13px 14px;border-radius:var(--vg-radius-soft);width:100%;max-width:100%;min-width:0;margin:0}
        .baqeri-ai-message.is-assistant{align-self:stretch;background:var(--vg-color-surface-soft);color:var(--vg-color-text)}.baqeri-ai-message.is-user{align-self:flex-end;width:auto;max-width:92%;background:var(--vg-color-primary-soft);color:var(--vg-color-text)}
        .baqeri-ai-composer{display:flex;flex-direction:column;gap:9px;min-width:0}.baqeri-ai-textarea{resize:vertical;min-height:88px;max-height:32vh}.baqeri-ai-composer .btn{min-height:48px;font-size:.95rem}
        .baqeri-ai-status{font-size:.82rem;line-height:1.7;color:var(--vg-color-text-muted);margin:0;min-height:1.2em}.baqeri-ai-status.is-error{color:var(--vg-color-danger)}
        .baqeri-ai-page button,.baqeri-ai-page select,.baqeri-ai-page textarea,.baqeri-ai-page input{touch-action:manipulation}
        @media(max-width:480px){.baqeri-ai-page{padding-inline:10px;gap:12px}.baqeri-ai-message{font-size:.98rem;padding:12px 12px;line-height:1.9}.baqeri-ai-messages{max-height:56dvh}.baqeri-ai-notice{padding:11px 12px}}
        @media(prefers-reduced-motion:reduce){.baqeri-ai-messages{scroll-behavior:auto}}
        .baqeri-ai-picker{
          background:var(--vg-color-surface);
          border:1px solid var(--vg-color-border);
          border-radius:var(--vg-radius-raised);
          box-shadow:var(--vg-shadow-group);
          overflow:hidden;
          min-width:0;
        }
        .baqeri-ai-picker-list{
          display:flex;
          flex-direction:column;
          max-height:260px;
          overflow-y:auto;
          overflow-x:hidden;
          -webkit-overflow-scrolling:touch;
          overscroll-behavior:contain;
          min-width:0;
        }
        .baqeri-ai-picker-row{
          position:relative;
          display:flex;
          align-items:flex-start;
          gap:10px;
          min-height:48px;
          padding:11px 14px;
          font-size:.9rem;
          line-height:1.55;
          color:var(--vg-color-text);
          cursor:pointer;
          box-sizing:border-box;
          min-width:0;
          -webkit-tap-highlight-color:transparent;
          transition:background-color 120ms ease;
        }
        .baqeri-ai-picker-row + .baqeri-ai-picker-row::before{
          content:'';
          position:absolute;
          top:0;
          inset-inline-start:14px;
          inset-inline-end:14px;
          height:1px;
          background:var(--vg-color-divider);
          pointer-events:none;
        }
        .baqeri-ai-picker-row:active{background:var(--vg-color-surface-soft);}
        .baqeri-ai-picker-row.is-selected{background:var(--vg-color-primary-soft);}
        .baqeri-ai-picker-row input[type=checkbox]{
          flex:0 0 auto;
          margin:3px 0 0 0;
          accent-color:var(--vg-color-primary);
          cursor:pointer;
        }
        .baqeri-ai-picker-row > span{
          flex:1 1 auto;
          min-width:0;
          overflow-wrap:anywhere;
          word-break:break-word;
        }
        .baqeri-ai-picker-row.is-disabled{
          opacity:.45;
          cursor:not-allowed;
        }
        .baqeri-ai-picker-row.is-disabled input[type=checkbox]{cursor:not-allowed;}
        .baqeri-ai-counter{
          margin:0;
          padding:9px 14px;
          border-top:1px solid var(--vg-color-divider);
          background:var(--vg-color-surface-soft);
          font-size:var(--vg-type-meta);
          line-height:1.5;
          color:var(--vg-color-text-muted);
          text-align:center;
        }
      </style>`;
    const MAX_SELECTED = 5;
    const listEl = root.querySelector('[data-customer-list]');
    const counterEl = root.querySelector('[data-customer-counter]');
    const customerCheckboxes = [];
    (data.customers || [])
      .filter(function (c) { return c && c.id != null && c.active !== false; })
      .slice()
      .sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || ''), 'fa'); })
      .forEach(function (c) {
        const row = document.createElement('label');
        row.className = 'baqeri-ai-picker-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = String(c.id);
        const span = document.createElement('span');
        span.textContent = safeText(c.name || 'مشتری بدون نام', 100);
        row.appendChild(cb);
        row.appendChild(span);
        listEl.appendChild(row);
        customerCheckboxes.push({ cb: cb, row: row });
      });

    function selectedIds() {
      return customerCheckboxes
        .filter(function (x) { return x.cb.checked; })
        .map(function (x) { return x.cb.value; });
    }

    function updateCounter() {
      const n = selectedIds().length;
      counterEl.textContent = n === 0
        ? 'هیچ مشتری انتخاب نشده — پیام عمومی ارسال می‌شود'
        : (n === 1
            ? 'یک مشتری انتخاب شده — تحلیل تک‌مشتری'
            : (n + ' از ' + MAX_SELECTED + ' مشتری انتخاب شده'));
      customerCheckboxes.forEach(function (x) {
        const atLimit = !x.cb.checked && n >= MAX_SELECTED;
        x.cb.disabled = atLimit;
        x.row.classList.toggle('is-disabled', atLimit);
        x.row.classList.toggle('is-selected', x.cb.checked);
      });
    }

    customerCheckboxes.forEach(function (x) {
      x.cb.addEventListener('change', updateCounter);
    });
    updateCounter();

    async function send() {
      if (busy) return;
      const tokenInput = root.querySelector('#baqeri-ai-token');
      const messageInput = root.querySelector('[data-chat-input]');
      const ids = selectedIds();
      const hasSelection = ids.length > 0;
      const isSingle = ids.length === 1;
      const message = String(messageInput.value || '').trim();
      const token = String(tokenInput.value || '').trim();
      if (!token) { setStatus('توکن دسترسی سرور را وارد کن.', true); tokenInput.focus(); return; }
      if (!message) { setStatus('پیام خالی است.', true); messageInput.focus(); return; }
      if (hasSelection && !root.querySelector('[data-chat-consent]').checked) {
        setStatus('برای ارسال خلاصهٔ مشتری، ابتدا رضایت ارسال را فعال کن.', true); return;
      }
      const context = isSingle
        ? buildCustomerContext(ids[0])
        : (hasSelection ? buildSelectedCustomersContext(ids) : '');
      if (hasSelection && !context) {
        setStatus('خلاصهٔ CRM ساخته نشد؛ دوباره صفحه را باز کن.', true); return;
      }
      appendMessage('user', message);
      history.push({ role: 'user', content: message });
      messageInput.value = '';
      updateBusy(true);
      setStatus(context ? 'در حال ارسال پیام همراه خلاصهٔ انتخابی CRM…' : 'در حال دریافت پاسخ…', false);
      try {
        const response = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({
            message: message,
            history: trimHistory(history.slice(0, -1), context ? 1500 : 3000),
            context: context || undefined,
            scope: isSingle ? 'single' : (hasSelection ? 'all' : 'single')
          })
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
        appendMessage('assistant', cleanReply(body.reply));
        history.push({ role: 'assistant', content: body.reply });
        if (history.length > 10) history = history.slice(-10);
        setStatus(
          isSingle ? 'پاسخ بر اساس خلاصهٔ مشتری انتخاب‌شده تولید شد؛ صحت توصیه را با داده‌ها تطبیق بده.'
                  : (hasSelection ? 'پاسخ بر اساس ' + ids.length + ' مشتری انتخاب‌شده تولید شد؛ صحت توصیه را با داده‌ها تطبیق بده.'
                                  : 'پاسخ دریافت شد.'),
          false
        );
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
      appendMessage('assistant', 'گفت‌وگوی تازه شروع شد. اگر لازم است، دوباره مشتری‌ها را انتخاب و ارسال اطلاعات را تأیید کن.');
      setStatus('', false);
      customerCheckboxes.forEach(function (x) { x.cb.checked = false; });
      updateCounter();
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
