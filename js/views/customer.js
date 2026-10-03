/* js/views/customer.js — SPA Customer detail view (Phase 4).
   Extracted from customer.html. Uses customerTotals/customerProfit/customerBehavior
   and existing mutation APIs (openAddInvoice/openAddTransaction/openAddCheck/openAddVisit/
   openAddCustomer) exactly as the MPA page does. No new financial logic.
*/
'use strict';

(function (global) {
  /* Same defensive helper as payments view — customer payment rows call this. */
  if (typeof global.paymentMethodLabel !== 'function') {
    global.paymentMethodLabel = function paymentMethodLabel(method) {
      var map = {
        cash: 'نقد',
        card: 'کارت',
        transfer: 'انتقال',
        return: 'برگشت',
        check: 'چک',
        discount: 'تخفیف',
        supplier: 'پرداخت به تامین‌کننده'
      };
      if (method == null || method === '') return '—';
      return map[method] || String(method);
    };
  }

  let currentCustomerId = null;
  let rootEl = null;
  function customersHref() {
    return '#/customers';
  }

  function navigateToCustomer(cid) {
    AppRouter.navigate('/customer', { id: cid });
  }

  function invoicePayStatus(inv) {
    const paid =
      typeof invoiceEffectivePaid === 'function'
        ? invoiceEffectivePaid(inv)
        : (inv.cashPaid || 0) + (inv.cardPaid || 0) + (inv.transferPaid || 0) + (inv.checkPaid || 0);
    const total = inv.total || 0;
    if (total <= 0) return { label: '—', cls: '' };
    if (paid <= 0) return { label: 'پرداخت‌نشده', cls: 'accent-rust' };
    if (paid + 0.5 >= total) return { label: 'تسویه روی فاکتور', cls: 'accent-olive' };
    return { label: 'پرداخت جزئی', cls: 'accent-amber' };
  }

  /* --- خلاصهٔ وضعیت (برای مرور سریع بین دو مغازه) ---
     فقط از خروجی customerBehavior() تغذیه می‌شود، هیچ متریکی را دوباره
     محاسبه یا تغییر نمی‌دهد. صرفاً نتایج موجود را برای تصمیم سریع کنار هم می‌گذارد. */
  function customerBehaviorSummary(bb) {
    if (!bb) return null;
    if (bb.invoiceCount < 2) {
      return {
        level: 'insufficient',
        lines: [
          bb.invoiceCount === 0
            ? 'هنوز فاکتوری برای این مشتری ثبت نشده است.'
            : 'فقط یک فاکتور ثبت شده — برای تشخیص الگوی خرید حداقل ۲ فاکتور لازم است.'
        ]
      };
    }
    const risk = [];
    const good = [];
    if (bb.behindPattern === true) {
      risk.push(
        'از الگوی معمول خرید عقب افتاده — ' +
          Math.round(bb.daysSinceLast) +
          ' روز از آخرین خرید گذشته (الگو: هر ' +
          Math.round(bb.avgIntervalDays) +
          ' روز)'
      );
    } else if (bb.behindPattern === false) {
      good.push('در محدودهٔ الگوی معمول خرید است');
    }
    if (bb.amountTrend === 'down') {
      risk.push('روند مبلغ خرید در ۳۰ روز اخیر کاهشی است');
    } else if (bb.amountTrend === 'up') {
      good.push('روند مبلغ خرید در ۳۰ روز اخیر افزایشی است');
    }
    if (bb.decliningProducts && bb.decliningProducts.length) {
      risk.push(
        'افت خرید در: ' +
          bb.decliningProducts
            .slice(0, 2)
            .map(function (p) {
              return p.name;
            })
            .join('، ')
      );
    }
    if (bb.consecutiveNoOrder >= 2) {
      risk.push('آخرین ' + bb.consecutiveNoOrder + ' ویزیت بدون سفارش بوده');
    }
    if (bb.conversionRate != null && bb.visitCount >= 2 && bb.conversionRate >= 0.5) {
      good.push('نرخ تبدیل ویزیت به سفارش بالا: ' + Math.round(bb.conversionRate * 100) + '٪');
    }
    let level = 'normal';
    if (risk.length >= 2) level = 'risk';
    else if (risk.length === 1) level = 'watch';
    else if (good.length) level = 'good';
    const reminder = bb.topProducts && bb.topProducts[0] ? 'کالای اصلی: ' + bb.topProducts[0].name : null;
    const action = bb.lastNextAction ? 'اقدام یادداشت‌شده از ویزیت قبل: ' + bb.lastNextAction : null;
    return { level: level, risk: risk, good: good, reminder: reminder, action: action };
  }

  /* --- Watch / Early Warning Layer (frozen spec §15) ---
     Runs BOTH extractCustomerSignals() (Confirmed) and
     extractWatchObservations() (Watch), as required by the spec.
     NOTE: this codebase does not currently render extractCustomerSignals()
     anywhere in the Customer View (it is only used by app.js for the
     "no purchase reason" prompt on invoices) — there was no existing
     Confirmed display here to preserve. To satisfy "Confirmed signals
     طبق منطق فعلی نمایش داده شوند" + "UI باید distinction واضح داشته
     باشد", a minimal read-only Confirmed list (active signals only,
     using the signals' own existing reason/productName fields — no new
     business logic) is shown alongside the new Watch list. This is an
     explicitly reported interpretation, not a silent guess. No action
     buttons are added for either list. */
  /* ============================================================
     PRODUCT REJECTION INSIGHT (UI-only, read-only)
     Source: customerBehavior(cid).offeredProductStats
     Not a Watch / Alert / Score / Recommendation / Action.
     Threshold configurable via localStorage key below.
     ============================================================ */
  var PRODUCT_REJECTION_THRESHOLD_KEY = 'baqeri_product_rejection_threshold_v1';
  var PRODUCT_REJECTION_THRESHOLD_DEFAULT = 3;

  function getProductRejectionThreshold() {
    try {
      if (typeof localStorage !== 'undefined' && localStorage) {
        var raw = localStorage.getItem(PRODUCT_REJECTION_THRESHOLD_KEY);
        if (raw != null && raw !== '') {
          var n = Number(raw);
          if (Number.isFinite(n) && n >= 1) return Math.floor(n);
        }
      }
    } catch (e) { /* ignore */ }
    return PRODUCT_REJECTION_THRESHOLD_DEFAULT;
  }

  function setProductRejectionThreshold(value) {
    var n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 1) n = PRODUCT_REJECTION_THRESHOLD_DEFAULT;
    try {
      if (typeof localStorage !== 'undefined' && localStorage) {
        localStorage.setItem(PRODUCT_REJECTION_THRESHOLD_KEY, String(n));
      }
    } catch (e) { /* ignore */ }
    return n;
  }

  var REJECTION_REASON_LABELS = {
    price: 'قیمت',
    quality: 'کیفیت',
    competitor: 'رقیب',
    unavailable: 'ناموجود',
    no_need: 'عدم نیاز',
    still_stock: 'موجود داشت',
    other: 'سایر'
  };

  function rejectionReasonLabel(code) {
    if (!code) return '—';
    return REJECTION_REASON_LABELS[code] || String(code);
  }

  /**
   * Build rejection insights for ONE customer from offeredProductStats.
   * Only products with rejectedCount >= threshold are returned.
   * Pure / read-only — does not write DB or mutate CRM.
   */
  function buildProductRejectionInsights(customerId, threshold, ctx) {
    var out = [];
    if (!customerId || typeof customerBehavior !== 'function') return out;
    var thr = (threshold != null && Number.isFinite(Number(threshold)))
      ? Math.floor(Number(threshold))
      : getProductRejectionThreshold();
    if (thr < 1) thr = PRODUCT_REJECTION_THRESHOLD_DEFAULT;

    var b;
    try { b = customerBehavior(customerId, ctx); } catch (e) { return out; }
    if (!b || !Array.isArray(b.offeredProductStats)) return out;

    for (var i = 0; i < b.offeredProductStats.length; i++) {
      var st = b.offeredProductStats[i];
      if (!st || st.productId == null) continue;
      var rejected = Number(st.rejectedCount) || 0;
      var offered = Number(st.offeredCount) || 0;
      if (rejected < thr) continue; // 1st and 2nd never shown
      if (offered < 1) continue;

      var ratio = rejected / offered;
      // Contract from calc.js: use st.rejectionReasons only (not topRejectionReason/reasonCounts)
      var topReason = null;
      if (st.rejectionReasons && typeof st.rejectionReasons === 'object') {
        var bestCode = null;
        var bestN = -1;
        var codes = Object.keys(st.rejectionReasons).sort(); // alphabetical deterministic tie-break
        for (var c = 0; c < codes.length; c++) {
          var n = Number(st.rejectionReasons[codes[c]]);
          if (!Number.isFinite(n) || n <= 0) continue;
          if (n > bestN) { bestN = n; bestCode = codes[c]; }
        }
        topReason = bestCode;
      }

      var name = st.productName || null;
      if (!name && typeof data !== 'undefined' && Array.isArray(data.products)) {
        var p = data.products.find(function (x) { return x && x.id === st.productId; });
        if (p) name = p.name;
      }

      out.push({
        productId: st.productId,
        productName: name || String(st.productId),
        offeredCount: offered,
        rejectedCount: rejected,
        rejectionRatio: ratio,
        topRejectionReason: topReason,
        lastOfferedDate: st.lastOfferedDate || null
      });
    }

    // Sort: most rejections first, then name (deterministic)
    out.sort(function (a, b) {
      if (b.rejectedCount !== a.rejectedCount) return b.rejectedCount - a.rejectedCount;
      return String(a.productName || '').localeCompare(String(b.productName || ''), 'fa');
    });
    return out;
  }

  function productRejectionInsightsHtml(customerId, ctx) {
    var items = [];
    try {
      items = buildProductRejectionInsights(customerId, undefined, ctx);
    } catch (e) {
      return '';
    }
    if (!items.length) return ''; // rule 15: hide section entirely

    var rows = items.map(function (it) {
      var reasonTxt = it.topRejectionReason
        ? ('دلیل غالب: ' + rejectionReasonLabel(it.topRejectionReason))
        : 'دلیل غالب: —';
      return '<div class="ledger-row customer-static-row">' +
        '<span class="name">' + esc(it.productName) +
          '<span class="sub">' + reasonTxt + '</span></span>' +
        '<span class="filler"></span>' +
        '<span class="amount customer-static-value">' +
          esc(String(it.rejectedCount)) + ' بار رد شده</span></div>';
    }).join('');

    return '<h3 class="sub-title">کالاهای ردشده توسط مشتری</h3>' +
      '<div class="dash-activity customer-rejection-list">' + rows + '</div>';
  }

  function watchQtyText(q, productId) {
    if (q == null || !isFinite(Number(q))) return '';
    var p = (typeof data !== 'undefined' && Array.isArray(data.products))
      ? data.products.find(function (x) { return x && x.id === productId; }) : null;
    var unit = p && p.packageWeight ? 'بسته' : 'کیلو';
    return String(q) + ' ' + unit;
  }

  function pendingFollowUpHtml(cid) {
    if (typeof getPendingWatchFollowUps !== 'function') return '';
    var rows = [];
    try { rows = getPendingWatchFollowUps(cid) || []; } catch (e) { rows = []; }
    if (!rows.length) return '';
    var html = rows.map(function (o) {
      var human = humanizeWatch(o);
      var followEv = human.evidence;
      return '<div class="watch-followup-row" data-followup-id="' + esc(o.id) + '">' +
        '<div class="watch-followup-main"><div><strong>پیگیری بعدی</strong> · ' + esc(human.title) + '</div>' +
        (followEv ? '<div class="watch-evidence"><span class="watch-evidence-label">شاهد:</span> ' + esc(followEv) + '</div>' : '') +
        (o.reason && o.reason.comment ? '<div class="watch-reason">یادداشت قبلی: ' + esc(o.reason.comment) + '</div>' : '') + '</div>' +
        '<div class="watch-followup-actions"><button type="button" class="btn secondary small" data-followup-complete="' + esc(o.id) + '">ثبت نتیجه</button>' +
        '<button type="button" class="btn secondary small" data-followup-cancel="' + esc(o.id) + '">لغو پیگیری</button></div></div>';
    }).join('');
    return '<div class="card wide watch-followup-card"><div class="label">پیگیری‌های منتظر</div>' +
      '<div class="report-note watch-note">این موارد فقط هنگام مواجهه با همین مشتری یادآوری می‌شوند و تا ثبت نتیجه یا لغو صریح باقی می‌مانند.</div>' + html + '</div>';
  }

  function humanizeWatch(o) {
    o = o || {};
    var category = o.watchCategory || o.category || '';
    var product = o.productName ? ('«' + o.productName + '»') : '';
    var e = o.evidence || {};

    var title = '';
    var days = (e.daysSinceLast != null) ? Math.round(e.daysSinceLast) : null;
    var avg = (e.averageIntervalDays != null) ? Math.round(e.averageIntervalDays) : null;
    var gap = (e.currentGap != null) ? Math.round(e.currentGap) : null;
    var cycle = (e.typicalCycle != null) ? Math.round(e.typicalCycle) : null;

    switch (category) {
      case 'SKU_DELAY_WATCH':
        title = product
          ? ('خرید ' + product + ' به تأخیر افتاده')
          : 'خرید یک کالا به تأخیر افتاده';
        break;
      case 'SKU_QUANTITY_DROP_WATCH':
        title = product
          ? ('مقدار خرید ' + product + ' کم شده')
          : 'مقدار خرید یک کالا کم شده';
        break;
      case 'SKU_FREQUENCY_DROP_WATCH':
        title = product
          ? ('تعداد خرید ' + product + ' کمتر شده')
          : 'تعداد خرید یک کالا کمتر شده';
        break;
      case 'LINE_DROP_WATCH':
        title = product
          ? ('حضور ' + product + ' در سبد خرید کم شده')
          : 'حضور یک کالا در سبد خرید کم شده';
        break;
      case 'BASKET_SHRINK_WATCH':
        title = 'حجم خرید سبد مشتری کم شده';
        break;
      case 'KEY_PRODUCT_LOST_WATCH':
        title = product
          ? (product + ' دیگر خریده نمی‌شود')
          : 'یک کالای کلیدی دیگر خریده نمی‌شود';
        break;
      case 'COMBINED_SKU_WATCH':
        title = product
          ? ('چند کالا همزمان در خرید ضعیف شده — ' + product)
          : 'چند کالا همزمان در خرید ضعیف شده';
        break;
      case 'PURCHASE_DECLINE_WATCH':
        title = 'خرید این مشتری کاهش یافته';
        break;
      case 'BEHIND_PATTERN_WATCH':
        title = 'از الگوی معمول خرید عقب افتاده';
        break;
      default:
        title = String(o.generatedReason || o.reason || 'مورد نیازمند توجه').trim();
        // Display-only fallback: do not expose technical category/ID tokens.
        title = title.replace(/\b[A-Z][A-Z0-9_-]{5,}\b/g, '').replace(/\b[a-z0-9]{8,}\b/gi, function (m) {
          return /[A-Z]/.test(m) || /[0-9_-]/.test(m) ? '' : m;
        }).replace(/\s{2,}/g, ' ').trim() || 'مورد نیازمند توجه';
        break;
    }

    var parts = [];
    if (days != null && avg != null) {
      parts.push('آخرین خرید ' + enToFaDigits(String(days)) + ' روز پیش بود؛ روال معمول این مشتری خرید هر ' + enToFaDigits(String(avg)) + ' روز است');
    } else if (gap != null && cycle != null) {
      parts.push('فاصله فعلی ' + enToFaDigits(String(gap)) + ' روز است، در حالی که چرخه معمول خرید این کالا ' + enToFaDigits(String(cycle)) + ' روز بود');
    }
    if (e.salesPrevious30 != null && e.salesRecent30 != null) {
      parts.push('خرید ۳۰ روز اخیر ' + toman(e.salesRecent30) + ' تومان در برابر ' + toman(e.salesPrevious30) + ' تومان دوره قبل');
    }
    if (Array.isArray(e.affectedProducts) && e.affectedProducts.length) {
      var list = e.affectedProducts.slice(0, 3).map(function (x) {
        var nm = x.productName || x.productId || 'کالا';
        var early = watchQtyText(x.earlyQty, x.productId);
        var late = watchQtyText(x.lateQty, x.productId);
        return '«' + nm + '» از ' + early + ' به ' + late + ' رسیده';
      });
      parts.push(list.join('؛ '));
    }
    if (Array.isArray(e.lostProducts) && e.lostProducts.length) {
      var lp = e.lostProducts.slice(0, 3).map(function (x) {
        return '«' + (x.productName || x.productId || 'کالا') + '» کاملاً از سبد حذف شده';
      });
      parts.push(lp.join('؛ '));
    }
    if (e.recentQuantity != null && e.typicalQuantity != null) {
      parts.push('مقدار خرید اخیر ' + watchQtyText(e.recentQuantity, o.productId) + ' بود، در برابر ' + watchQtyText(e.typicalQuantity, o.productId) + ' مورد انتظار');
    }
    if (e.recentFrequency != null && e.expectedFrequency != null) {
      parts.push('تعداد دفعات خرید اخیر ' + enToFaDigits(String(e.recentFrequency)) + ' بار بود، در برابر ' + enToFaDigits(String(Math.round(e.expectedFrequency * 10) / 10)) + ' بار مورد انتظار');
    }
    if (e.historicalPresenceRate != null && e.currentBasketPresence != null) {
      parts.push('حضور در سبد از ' + enToFaDigits(String(Math.round(e.historicalPresenceRate * 100))) + '٪ به ' + enToFaDigits(String(Math.round(e.currentBasketPresence * 100))) + '٪ کاهش یافته');
    }

    return { title: title, evidence: parts.join('؛ ') };
  }

  function attentionEvidenceHtml(text) {
    return text ? '<div class="customer-focus-why">' + esc(text) + '</div>' : '';
  }

  function buildCustomerAttentionItems(cid, ctx) {
    var out = [], occs = [];
    try { if (typeof getActiveWatchOccurrences === 'function') occs = getActiveWatchOccurrences(cid) || []; } catch (e) { occs = []; }
    occs.forEach(function(o){ var h=humanizeWatch(o); out.push({title:h.title,evidence:h.evidence,watchId:o.id||null,level:o.level||'low'}); });
    if (typeof extractCustomerSignals === 'function') {
      var signals=[]; try { signals=extractCustomerSignals(cid,ctx)||[]; } catch(e2) { signals=[]; }
      signals.filter(function(s){return s&&s.status==='active';}).forEach(function(s){ var h=humanizeWatch({watchCategory:s.category,productName:s.productName,generatedReason:s.reason,evidence:s.evidence}); out.push({title:h.title,evidence:h.evidence,watchId:null,level:s.severity||'low'}); });
    }
    return out;
  }

  function intelligenceWatchHtml(cid, ctx) {
    if (typeof extractCustomerSignals !== 'function' && typeof extractWatchObservations !== 'function' && typeof getActiveWatchOccurrences !== 'function') return '';

    var confirmed = [];
    if (typeof extractCustomerSignals === 'function') {
      try { confirmed = extractCustomerSignals(cid, ctx) || []; } catch (e) { confirmed = []; }
    }
    var activeConfirmed = confirmed.filter(function (s) { return s && s.status === 'active'; });

    // Lifecycle occurrences (preferred) — already reconciled by caller when possible
    var occs = [];
    if (typeof getActiveWatchOccurrences === 'function') {
      try { occs = getActiveWatchOccurrences(cid) || []; } catch (eOcc) { occs = []; }
    }
    // Fallback to raw generation if lifecycle absent. Guarded against
    // inactive customers too (W-BUG-02): this path bypasses
    // reconcileWatchLifecycle's own active-customer check entirely, so an
    // inactive customer must never reach it even as a display-only fallback.
    var custIsActive = true;
    if (typeof data !== 'undefined' && Array.isArray(data.customers)) {
      var custRec = data.customers.find(function (x) { return x && x.id === cid; });
      custIsActive = !!(custRec && custRec.active !== false);
    }
    if (!occs.length && custIsActive && typeof extractWatchObservations === 'function') {
      try {
        var raw = extractWatchObservations(cid, confirmed, ctx) || [];
        // id:null fallback must honor seller decisions (dismiss / still stock /
        // not wanted / follow-up) exactly like the lifecycle does.
        if (typeof filterSuppressedWatchObservations === 'function') {
          try { raw = filterSuppressedWatchObservations(cid, raw, ctx) || []; } catch (eF) { /* fail-open */ }
        }
        occs = raw.map(function (w, idx) {
          return {
            id: null,
            customerId: cid,
            productId: w.productId,
            productName: w.productName,
            watchCategory: w.category,
            level: w.level,
            generatedReason: w.reason,
            reason: null,
            evidence: w.evidence || null,
            watchComponents: w.watchComponents || null,
            status: 'active'
          };
        });
      } catch (e2) { occs = []; }
    }

    if (!occs.length && !activeConfirmed.length) return '';

    function levelClass(level) {
      return level === 'critical' ? 'watch-level-critical' : level === 'high' ? 'watch-level-high' : level === 'medium' ? 'watch-level-medium' : 'watch-level-low';
    }
    function levelLabel(level) {
      return level === 'critical' ? 'بحرانی' : level === 'high' ? 'زیاد' : level === 'medium' ? 'متوسط' : 'کم';
    }

    var confirmedHtml = '';
    if (activeConfirmed.length) {
      var crows = activeConfirmed.map(function (s) {
        var label = (s.productName ? ('«' + esc(s.productName) + '» — ') : '') + esc(s.reason || '');
        /* P3 (UI only) — explainability inside the existing row. Reads existing
           fields only; no raw confidence/riskModifier. The seasonal note is added
           only if the reason text does not already carry it (seasonality.js appends
           «کاهش فصلی مورد انتظار» to reason), so it is never shown twice. */
        var explainBits = [];
        if (s.occurrenceCount >= 2) explainBits.push('تکرار: ' + esc(String(s.occurrenceCount)) + ' بار');
        if (s.seasonallySuppressed === true && String(s.reason || '').indexOf('فصلی') === -1) explainBits.push('کاهش فصلی مورد انتظار');
        if (explainBits.length) {
          label += ' <span style="color:var(--vg-color-text-muted);font-size:.78rem;">· ' + explainBits.join(' · ') + '</span>';
        }
        return '<div class="watch-confirmed-row">' +
          '<span>• ' + label + '</span>' +
          '<span class="watch-level-label ' + levelClass(s.severity) + '">' + esc(levelLabel(s.severity)) + '</span>' +
          '</div>';
      }).join('');
      confirmedHtml = '<div class="card wide watch-confirmed-card">' +
        '<div class="label">هوش تجاری — تأییدشده</div>' +
        '<div class="watch-confirmed-list">' + crows + '</div></div>';
    }

    var watchHtml = '';
    if (occs.length) {
      var wrows = occs.map(function (o) {
        var human = humanizeWatch(o);
        var label = esc(human.title);
        var reviewed = !!(o.reason);
        var badge = reviewed
          ? '<span class="watch-reviewed">بررسی شده</span>'
          : '<span class="watch-level-unreviewed">بررسی نشده</span>';
        var reasonBit = '';
        if (reviewed && o.reason) {
          var rlabel = (typeof watchReasonLabel === 'function') ? watchReasonLabel(o.reason.code) : (o.reason.code || '');
          reasonBit = '<div class="watch-reason">علت: ' + esc(rlabel) +
            (o.reason.comment ? (' — ' + esc(o.reason.comment)) : '') + '</div>';
        }
        var clickable = o.id
          ? (' data-watch-occ="' + esc(o.id) + '" role="button" tabindex="0"')
          : '';
        var ev = human.evidence;
        return '<div class="watch-occ-row"' + clickable + '>' +
          '<div class="watch-occ-head">' +
            '<span>• ' + label + '</span>' +
            '<span class="watch-occ-status">' + badge +
              '<div class="watch-level-label ' + levelClass(o.level) + '">' + esc(levelLabel(o.level)) + '</div>' +
            '</span>' +
          '</div>' + reasonBit + (ev ? '<div class="watch-evidence"><span class="watch-evidence-label">شاهد:</span> ' + esc(ev) + '</div>' : '') +
        '</div>';
      }).join('');
      watchHtml = '<div class="card wide watch-lifecycle-card" id="watch-lifecycle-card">' +
        '<div class="label">هشدارهای زودهنگام</div>' +
        '<div class="report-note watch-note">برای ثبت پاسخ، روی مورد بزنید. «هنوز موجودی دارد»، «این محصول را نمی‌خواهد» و «بعداً پیگیری می‌کنم» هشدار را می‌بندند؛ سایر علت‌ها فقط ثبت می‌شوند.</div>' +
        '<div class="watch-occ-list">' + wrows + '</div></div>';
    }

    var followUpHtml = pendingFollowUpHtml(cid);
    return followUpHtml + confirmedHtml + watchHtml;
  }

  function openWatchReasonSheet(occurrenceId, onDone) {
    if (!occurrenceId || typeof recordWatchReason !== 'function') return;
    var options = (typeof getWatchResponseOptions === 'function')
      ? getWatchResponseOptions(occurrenceId)
      : (typeof WATCH_REASON_OPTIONS !== 'undefined' && Array.isArray(WATCH_REASON_OPTIONS))
      ? WATCH_REASON_OPTIONS
      : [
          { code: 'still_stock', label: 'هنوز موجودی دارد' },
          { code: 'price', label: 'قیمت' },
          { code: 'competitor', label: 'خرید از رقیب' },
          { code: 'no_need', label: 'فعلاً نیاز ندارد' },
          { code: 'quality', label: 'مشکل کیفیت' },
          { code: 'other', label: 'سایر' }
        ];
    var optsHtml = options.map(function (o) {
      return '<button type="button" class="btn secondary small" data-watch-reason="' + esc(o.code) + '" style="width:100%;margin-bottom:6px;text-align:right;">' +
        esc(o.label) + '</button>';
    }).join('');
    if (typeof openSheet !== 'function') return;
    openSheet(
      '<div class="sheet-title">ثبت علت هشدار</div>' +
      '<div class="report-note" style="margin-bottom:10px;">سه پاسخ اول هشدار را می‌بندند و همان مورد را فوراً برنمی‌گردانند؛ سایر علت‌ها فقط ثبت می‌شوند.</div>' +
      '<div id="watch-reason-list">' + optsHtml + '</div>' +
      '<div class="field" style="margin-top:10px;"><label>یادداشت (اختیاری)</label>' +
      '<input type="text" id="watch-reason-note" autocomplete="off" placeholder="توضیح کوتاه..."></div>' +
      '<div class="btn-row" style="margin-top:12px;justify-content:space-between;">' +
      '<button type="button" class="btn secondary" id="watch-dismiss-btn">بستن هشدار</button>' +
      '<button type="button" class="btn secondary" id="watch-reason-cancel">انصراف</button></div>'
    );
    var cancel = document.getElementById('watch-reason-cancel');
    if (cancel) cancel.onclick = function () { if (typeof closeModal === 'function') closeModal(); };
    var dismissBtn = document.getElementById('watch-dismiss-btn');
    if (dismissBtn) {
      dismissBtn.onclick = function () {
        if (typeof dismissWatchOccurrence !== 'function') return;
        var noteEl = document.getElementById('watch-reason-note');
        var note = noteEl ? noteEl.value : '';
        try {
          dismissWatchOccurrence(occurrenceId, note);
          if (typeof showToast === 'function') showToast('هشدار بسته شد');
        } catch (err) {
          console.error(err);
          if (typeof showToast === 'function') showToast('بستن هشدار ممکن نشد');
        }
        if (typeof closeModal === 'function') closeModal();
        if (typeof onDone === 'function') onDone();
      };
    }
    var list = document.getElementById('watch-reason-list');
    if (list) {
      list.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-watch-reason]');
        if (!btn) return;
        var code = btn.getAttribute('data-watch-reason');
        var noteEl = document.getElementById('watch-reason-note');
        var note = noteEl ? noteEl.value : '';
        try {
          recordWatchReason(occurrenceId, code, note);
          if (typeof showToast === 'function') showToast('علت ثبت شد');
        } catch (err) {
          console.error(err);
          if (typeof showToast === 'function') showToast('ثبت علت ممکن نشد');
        }
        if (typeof closeModal === 'function') closeModal();
        if (typeof onDone === 'function') onDone();
      });
    }
  }

  function openWatchFollowUpSheet(occurrenceId, cid, onDone) {
    if (!occurrenceId || typeof getPendingWatchFollowUps !== 'function' || typeof openSheet !== 'function') return;
    var pending = [];
    try { pending = getPendingWatchFollowUps(cid) || []; } catch (e) { pending = []; }
    var occ = pending.find(function (x) { return x && x.id === occurrenceId; });
    if (!occ) return;
    var options = [
      { code: 'still_stock', label: 'هنوز موجودی دارد' },
      { code: 'not_wanted', label: 'این محصول را نمی‌خواهد' },
      { code: 'dismiss', label: 'بررسی شد، فعلاً پیگیری نمی‌خواهم' },
      { code: 'price', label: 'قیمت' },
      { code: 'competitor', label: 'خرید از رقیب' },
      { code: 'no_need', label: 'فعلاً نیاز ندارد' },
      { code: 'quality', label: 'مشکل کیفیت' },
      { code: 'other', label: 'سایر' }
    ].filter(function (x) { return x.code !== 'not_wanted' || !!occ.productId; });
    var buttons = options.map(function (o) { return '<button type="button" class="btn secondary small" data-followup-result="' + esc(o.code) + '" style="width:100%;margin-bottom:6px;text-align:right;">' + esc(o.label) + '</button>'; }).join('');
    var followEv = humanizeWatch(occ).evidence;
    openSheet('<div class="sheet-title">ثبت نتیجه پیگیری</div>' + (followEv ? '<div class="watch-evidence"><span class="watch-evidence-label">شاهد:</span> ' + esc(followEv) + '</div>' : '') + '<div id="watch-followup-results">' + buttons + '</div>' + '<div class="field" style="margin-top:10px;"><label>یادداشت (اختیاری)</label><input id="watch-followup-note" type="text" autocomplete="off"></div>' + '<div class="btn-row" style="margin-top:10px;"><button type="button" class="btn secondary" id="watch-followup-cancel-sheet">انصراف</button></div>');
    var cancel = document.getElementById('watch-followup-cancel-sheet');
    if (cancel) cancel.onclick = function () { if (typeof closeModal === 'function') closeModal(); };
    var list = document.getElementById('watch-followup-results');
    if (list) list.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-followup-result]'); if (!btn) return;
      var note = document.getElementById('watch-followup-note');
      var code = btn.getAttribute('data-followup-result');
      var result = null;
      if (code === 'dismiss') {
        // Explicit completion of the pending follow-up; do not turn it into not_wanted.
        result = typeof completeWatchFollowUp === 'function' ? completeWatchFollowUp(occurrenceId, 'dismiss', note ? note.value : '') : null;
      } else if (typeof completeWatchFollowUp === 'function') {
        result = completeWatchFollowUp(occurrenceId, code, note ? note.value : '');
      }
      if (typeof showToast === 'function') showToast(result ? 'نتیجه پیگیری ثبت شد' : 'ثبت نتیجه ممکن نشد');
      if (typeof closeModal === 'function') closeModal();
      if (typeof onDone === 'function') onDone();
    });
  }

  function bindWatchFollowUps(root, cid) {
    if (!root) return;
    root.querySelectorAll('[data-followup-complete]').forEach(function (el) {
      el.addEventListener('click', function () {
        openWatchFollowUpSheet(el.getAttribute('data-followup-complete'), cid, function () { drawCustomerPage(rootEl || root); });
      });
    });
    root.querySelectorAll('[data-followup-cancel]').forEach(function (el) {
      el.addEventListener('click', function () {
        if (typeof reverseWatchDecision !== 'function') return;
        var id = el.getAttribute('data-followup-cancel');
        var ok = false;
        try { ok = !!reverseWatchDecision(id); } catch (e) { ok = false; }
        if (typeof showToast === 'function') showToast(ok ? 'پیگیری لغو شد' : 'لغو پیگیری ممکن نشد');
        drawCustomerPage(rootEl || root);
      });
    });
  }

  function bindWatchLifecycleRows(root) {
    if (!root) return;
    root.querySelectorAll('[data-watch-occ]').forEach(function (el) {
      el.addEventListener('click', function () {
        var id = el.getAttribute('data-watch-occ');
        openWatchReasonSheet(id, function () {
          if (typeof drawCustomerPage === 'function') drawCustomerPage(rootEl || root);
        });
      });
    });
  }

  function drawCustomerPage(root, ctx) {
    if (!root) return;
    root.classList.add('customer-detail-view'); // UPDATED: Added for CSS scoping

    const id = currentCustomerId;

    if (!id) {
      root.innerHTML =
        '<div class="empty">شناسه مشتری مشخص نشده است.</div>' +
        '<div class="btn-row"><a class="btn secondary" href="' +
        customersHref() +
        '">بازگشت به لیست مشتریان</a></div>';
      return;
    }
    const c = data.customers.find(function (x) {
      return x.id === id;
    });
    if (!c) {
      root.innerHTML =
        '<div class="empty">مشتری با این شناسه پیدا نشد.</div>' +
        '<div class="btn-row"><a class="btn secondary" href="' +
        customersHref() +
        '">بازگشت به لیست مشتریان</a></div>';
      return;
    }

    if (typeof setHeaderTitle === 'function') {
      setHeaderTitle(c.name, { isRoot: false });
    }

    const t = customerTotals(c.id, ctx);
    const profit = customerProfit(c.id, ctx);
    const word = balanceStatusWord(t.balance);
    const color = t.balance > 0 ? 'accent-rust' : t.balance < 0 ? 'accent-olive' : 'accent-olive';
    const balanceLine = t.balance === 0 ? word : word + ': ' + toman(Math.abs(t.balance)) + ' ت';

    /* Unified Summary — visually combines three EXISTING, already-frozen
       outputs (calculateCustomerPriority → riskLevel + customerStory,
       and calculateCustomerAction → next action) into ONE decision block.
       No new score, no new health model, no new thresholds: this is a
       read-only merge of data the system already computes elsewhere
       (the same functions power the Dashboard Action Queue). */
    let unifiedSummaryHtml = '';
    let recommendedAction = null;
    {
      let priority = null, action = null;
      try { if (typeof calculateCustomerPriority === 'function') priority = calculateCustomerPriority(c.id, { ctx: ctx }); } catch (eP) { priority = null; }
      try { if (typeof calculateCustomerAction === 'function') action = calculateCustomerAction(c.id, priority, { ctx: ctx }); } catch (eA) { action = null; }
      recommendedAction = action && action.actionType !== 'no_action' ? action : null;
      const riskLevel = priority ? priority.riskLevel : null;
      const storyText = (priority && priority.customerStory && priority.customerStory.summary) ? priority.customerStory.summary : '';
      if (storyText) {
        unifiedSummaryHtml =
          '<div class="cust-summary ' + (riskLevel ? 'radar-risk-' + esc(riskLevel) : '') + '">' +
          '<div class="cust-summary-story">' + esc(storyText) + '</div>' +
          '</div>';
      }
    }

    const invs = customerInvoices(c.id, ctx)
      .slice()
      .sort(function (a, b) {
        return (b.date || '').localeCompare(a.date || '') || String(b.number).localeCompare(String(a.number));
      });
    const pays = customerPayments(c.id, ctx)
      .slice()
      .sort(function (a, b) {
        return (b.date || '').localeCompare(a.date || '');
      });
    const chks = customerChecks(c.id, ctx)
      .slice()
      .sort(function (a, b) {
        return (b.dueDate || '').localeCompare(a.dueDate || '');
      });
    const visits = (c.visits || []).slice().sort(function (a, b) {
      return (b.date || '').localeCompare(a.date || '') || (b.time || '').localeCompare(a.time || '');
    });

    const invRows = invs.length
      ? invs
          .map(function (inv) {
            const st = invoicePayStatus(inv);
            return (
              '<a class="ledger-row customer-invoice-row" href="#/invoice?id=' +
              encodeURIComponent(inv.id) +
              '" style="text-decoration:none;color:inherit;">' +
              '<span class="name">#' +
              esc(String(inv.number || '')) +
              '<span class="sub">' +
              faDate(inv.date) +
              ' — <span class="' +
              st.cls +
              '">' +
              st.label +
              '</span></span></span>' +
              '<span class="filler"></span>' +
              '<span class="amount">' +
              toman(inv.total) +
              ' ت</span></a>'
            );
          })
          .join('')
      : '<div class="empty" style="padding:12px 0;">فاکتوری ثبت نشده</div>';

    const payRows = pays.length
      ? pays
          .map(function (p) {
            const method = paymentMethodLabel(p.method);
            return (
              '<div class="ledger-row">' +
              '<span class="name">' +
              esc(method) +
              (p.note ? '<span class="sub">' + esc(p.note) + '</span>' : '') +
              '<span class="sub">' +
              faDate(p.date) +
              '</span></span>' +
              '<span class="filler"></span>' +
              '<span class="amount">' +
              toman(p.amount) +
              ' ت</span></div>'
            );
          })
          .join('')
      : '<div class="empty" style="padding:12px 0;">پرداختی ثبت نشده</div>';

    const chkRows = chks.length
      ? chks
          .map(function (ch) {
            const st = ch.status === 'cleared' ? 'پاس‌شده' : 'در جریان';
            const stCls = ch.status === 'cleared' ? 'accent-olive' : 'accent-amber';
            return (
              '<div class="ledger-row">' +
              '<span class="name">' +
              esc(ch.checkNumber || 'چک') +
              '<span class="sub">سررسید: ' +
              faDate(ch.dueDate) +
              ' — <span class="' +
              stCls +
              '">' +
              st +
              '</span></span></span>' +
              '<span class="filler"></span>' +
              '<span class="amount">' +
              toman(ch.amount) +
              ' ت</span></div>'
            );
          })
          .join('')
      : '<div class="empty" style="padding:12px 0;">چکی ثبت نشده</div>';

    const visitRows = visits.length
      ? visits
          .slice(0, 30)
          .map(function (v) {
            const scoreBit = typeof v.score === 'number' ? ' — امتیاز: ' + v.score + ' از ۱۰۰' : '';
            const extraBits = [];
            if (v.reason) extraBits.push('دلیل: ' + v.reason);
            if (v.opportunity) extraBits.push('فرصت (مشاهده): ' + v.opportunity);
            if (v.threat) extraBits.push('تهدید (مشاهده): ' + v.threat);
            if (v.nextAction) extraBits.push('اقدام بعدی: ' + v.nextAction);
            if (Array.isArray(v.tags) && v.tags.length) extraBits.push('برچسب: ' + v.tags.join('، '));
            if (Array.isArray(v.offeredProducts) && v.offeredProducts.length) {
              var rxMap = { accepted: 'قبول', rejected: 'رد', deferred: 'بعداً' };
              var rrMap = { price: 'قیمت', quality: 'کیفیت', competitor: 'رقیب', unavailable: 'ناموجود', no_need: 'عدم نیاز', still_stock: 'موجود داشت', other: 'سایر' };
              var bits = v.offeredProducts.map(function (op) {
                var prod = (data.products || []).find(function (p) { return p.id === op.productId; });
                var name = prod ? prod.name : (op.productId || '—');
                var s = name + ' (' + (rxMap[op.reaction] || op.reaction || '—') + ')';
                if (op.reaction === 'rejected' && op.rejectionReason) s += ' — ' + (rrMap[op.rejectionReason] || op.rejectionReason);
                return s;
              });
              extraBits.push('پیشنهاد: ' + bits.join('؛ '));
            }
            if (v.note) extraBits.push(v.note);
            const extraHtml = extraBits
              .map(function (x) {
                return '<span class="sub customer-visit-row-detail">' + esc(x) + '</span>';
              })
              .join('');
            const ordered = v.ordered || v.result === (typeof VISIT_RESULTS !== 'undefined' && VISIT_RESULTS[0]);
            return (
              '<div class="ledger-row" style="cursor:default;">' +
              '<span class="name">' +
              esc(v.result || 'ویزیت') +
              '<span class="sub">' +
              faDate(v.date) +
              (v.time ? ' — ' + esc(v.time) : '') +
              scoreBit +
              '</span>' +
              extraHtml +
              '</span>' +
              '<span class="filler"></span>' +
              '<span class="amount ' +
              (ordered ? 'accent-olive' : '') +
              '">' +
              (ordered ? 'سفارش' : 'ویزیت') +
              '</span></div>'
            );
          })
          .join('')
      : '<div class="empty" style="padding:12px 0;">ویزیتی ثبت نشده</div>';

    let behaviorHtml = '';
    let behaviorData = null;
    if (typeof customerBehavior === 'function') {
      const b = customerBehavior(c.id, ctx);
      behaviorData = b;
      // customerBehaviorSummary's own bullet lines now render lower on the
      // page, inside "جزئیات کامل رفتار خرید" progressive disclosure —
      // the headline decision (risk/opportunity + next action) already
      // moved up into the Unified Summary block above the fold.
      let summaryHtml = '';
      const summary = customerBehaviorSummary(b);
      if (summary && summary.level === 'insufficient') {
        summaryHtml =
          '<div class="card wide" style="margin-bottom:10px;">' +
          '<div class="label">خلاصهٔ رفتار خرید</div>' +
          '<div class="value" style="font-size:.9rem;">' +
          esc(summary.lines[0]) +
          '</div></div>';
      } else if (summary) {
        const badgeMap = {
          risk: ['نیاز به توجه', 'accent-rust'],
          watch: ['قابل بررسی', 'accent-amber'],
          good: ['وضعیت مطلوب', 'accent-olive'],
          normal: ['عادی', '']
        };
        const bm = badgeMap[summary.level] || badgeMap.normal;
        const noteLines = summary.risk.concat(summary.good);
        const extraLines = [summary.reminder, summary.action].filter(Boolean);
        summaryHtml =
          '<div class="card wide" style="margin-bottom:10px;">' +
          '<div class="label">خلاصهٔ رفتار خرید</div>' +
          '<div class="value ' +
          bm[1] +
          '" style="font-size:1.05rem;">' +
          esc(bm[0]) +
          '</div>' +
          (noteLines.length
            ? '<div style="font-size:.85rem;line-height:1.9;margin-top:8px;color:var(--ink);">' +
              noteLines
                .map(function (x) {
                  return '• ' + esc(x);
                })
                .join('<br>') +
              '</div>'
            : '') +
          (extraLines.length
            ? '<div style="font-size:.85rem;line-height:1.9;margin-top:8px;padding-top:8px;border-top:1px dotted var(--line);color:var(--ink);">' +
              extraLines
                .map(function (x) {
                  return '🔹 ' + esc(x);
                })
                .join('<br>') +
              '</div>'
            : '') +
          '</div>';
      }

      const trendLabel =
        b.amountTrend === 'up' ? 'سیگنال افزایش' : b.amountTrend === 'down' ? 'سیگنال کاهش' : b.amountTrend === 'flat' ? 'تقریباً ثابت' : null;
      const trendCls = b.amountTrend === 'up' ? 'accent-olive' : b.amountTrend === 'down' ? 'accent-rust' : '';
      const intervalText = b.avgIntervalDays != null ? Math.round(b.avgIntervalDays * 10) / 10 + ' روز' : 'اطلاعات کافی نیست';
      const gapText = b.daysSinceLast != null ? Math.round(b.daysSinceLast) + ' روز' : '—';
      const behindHtml =
        b.behindPattern === true
          ? '<div class="card wide"><div class="label">نشانه</div><div class="value accent-amber" style="font-size:.95rem;">از الگوی معمول خرید عقب افتاده</div></div>'
          : b.behindPattern === false
            ? '<div class="card wide"><div class="label">وضعیت فاصله</div><div class="value accent-olive" style="font-size:.95rem;">در محدوده الگوی معمول</div></div>'
            : '';
      const topProdHtml =
        b.topProducts && b.topProducts.length
          ? b.topProducts
              .map(function (p) {
                return (
                  '<div class="ledger-row" style="cursor:default;"><span class="name">' +
                  esc(p.name) +
                  '<span class="sub">تعداد: ' +
                  fmtQtyDisplay(p.qty) +
                  '</span></span><span class="filler"></span><span class="amount">' +
                  toman(p.revenue) +
                  ' ت</span></div>'
                );
              })
              .join('')
          : '<div class="empty" style="padding:8px 0;">اطلاعات کافی نیست</div>';
      const decliningHtml =
        b.decliningProducts && b.decliningProducts.length
          ? b.decliningProducts
              .map(function (p) {
                return (
                  '<div class="ledger-row" style="cursor:default;"><span class="name">' +
                  esc(p.name) +
                  '<span class="sub">از ' +
                  fmtQtyDisplay(p.earlyQty) +
                  ' به ' +
                  fmtQtyDisplay(p.lateQty) +
                  '</span></span></div>'
                );
              })
              .join('')
          : '';
      const lv = b.lastVisit;
      const lastVisitBits = [];
      if (lv) {
        lastVisitBits.push(esc(lv.result || 'ویزیت'));
        if (lv.reason) lastVisitBits.push('دلیل: ' + esc(lv.reason));
        if (lv.nextAction) lastVisitBits.push('اقدام بعدی: ' + esc(lv.nextAction));
        if (lv.opportunity) lastVisitBits.push('فرصت (مشاهده): ' + esc(lv.opportunity));
        if (lv.threat) lastVisitBits.push('تهدید (مشاهده): ' + esc(lv.threat));
        if (Array.isArray(lv.tags) && lv.tags.length) lastVisitBits.push('برچسب: ' + esc(lv.tags.join('، ')));
      }
      const convText =
        b.conversionRate != null
          ? Math.round(b.conversionRate * 100) + '٪ (' + b.orderedCount + ' از ' + b.visitCount + ')'
          : b.visitCount
            ? '—'
            : 'ویزیتی ثبت نشده';

      const watchHtmlBlock = intelligenceWatchHtml(c.id, ctx);
      behaviorHtml =
        '<div class="customer-section-kicker">نشانه‌ها و هشدارها</div>' +
        (watchHtmlBlock
          ? '<details open class="customer-watch-details">' +
            '<summary class="customer-behavior-summary">جزئیات هشدارها</summary>' +
            '<div class="customer-detail-watch-body">' + watchHtmlBlock + '</div></details>'
          : '') +
        '<div class="customer-section-kicker">تحلیل رفتار خرید</div>' +
        '<details class="customer-behavior-details">' +
        '<summary class="customer-behavior-summary">جزئیات رفتار خرید</summary>' +
        summaryHtml +
        '<div class="cards">' +
        '<div class="card"><div class="label">اولین خرید</div><div class="value">' +
        (b.firstInvoiceDate ? faDate(b.firstInvoiceDate) : '—') +
        '</div></div>' +
        '<div class="card"><div class="label">آخرین خرید</div><div class="value">' +
        (b.lastInvoiceDate ? faDate(b.lastInvoiceDate) : '—') +
        '</div></div>' +
        '<div class="card"><div class="label">تعداد فاکتور</div><div class="value">' +
        b.invoiceCount +
        '</div></div>' +
        '<div class="card"><div class="label">میانگین مبلغ فاکتور</div><div class="value">' +
        (b.avgInvoice != null ? toman(b.avgInvoice) + ' ت' : '—') +
        '</div></div>' +
        '<div class="card"><div class="label">الگوی معمول خرید</div><div class="value">' +
        esc(String(intervalText)) +
        '</div></div>' +
        '<div class="card"><div class="label">فاصله از آخرین خرید</div><div class="value">' +
        esc(String(gapText)) +
        '</div></div>' +
        '<div class="card"><div class="label">خرید خالص ۳۰ روز</div><div class="value">' +
        toman(b.sales30 || 0) +
        ' ت</div></div>' +
        '<div class="card"><div class="label">خرید خالص ۹۰ روز</div><div class="value">' +
        toman(b.sales90 || 0) +
        ' ت</div></div>' +
        (b.returnTotal > 0
          ? '<div class="card wide"><div class="label">جمع برگشت از فروش (کل سابقه)</div><div class="value">' +
            toman(b.returnTotal) +
            ' ت</div></div>'
          : '') +
        (trendLabel
          ? '<div class="card wide"><div class="label">روند مبلغ (۳۰ روز اخیر نسبت به ۳۰ روز قبل)</div><div class="value ' +
            trendCls +
             '">' +
            trendLabel +
            '</div></div>'
          : '<div class="card wide"><div class="label">روند مبلغ</div><div class="value">اطلاعات کافی نیست</div></div>') +
        behindHtml +
        '<div class="card"><div class="label">تعداد ویزیت</div><div class="value">' +
        b.visitCount +
        '</div></div>' +
        '<div class="card"><div class="label">نرخ تبدیل ویزیت به سفارش</div><div class="value">' +
        esc(String(convText)) +
        '</div></div>' +
        '</div>' +
        '<div class="sub-title customer-detail-subtitle">کالاهای اصلی مشتری</div>' +
        '<div class="customer-tx-list customer-top-products">' + topProdHtml + '</div>' +
        (decliningHtml ? '<div class="sub-title customer-detail-subtitle customer-detail-subtitle-secondary">کالاهای با کاهش خرید (نسبت به نیمه اول سابقه)</div><div class="customer-tx-list customer-declining-products">' + decliningHtml + '</div>' : '') +
        (lv
          ? '<div class="card customer-last-visit-card">' +
            '<div class="label">آخرین ویزیت — ' +
            faDate(lv.date) +
            (lv.time ? ' ' + esc(lv.time) : '') +
            '</div>' +
            '<div class="customer-last-visit-body">' +
            lastVisitBits.join('<br>') +
            '</div></div>'
          : '<div class="empty customer-empty">ویزیتی ثبت نشده</div>') +
        '</details>';
    }

    /* P2 (UI only) — Identity card extras: read-only use of customerStatus()
       and customerBehavior() (same memoized ctx). No logic touched. */
    let identityStatusHtml = '';
    let identityBehindHtml = '';
    try {
      let stKey = (typeof customerStatus === 'function') ? customerStatus(c.id, ctx) : null;
      let stLabel = '';
      if (c.active === false) stLabel = 'غیرفعال شده';
      else if (stKey === 'active') stLabel = 'فعال';
      else if (stKey === 'new') stLabel = 'جدید';
      else if (stKey === 'inactive') stLabel = 'سرد شده';
      else if (stKey === 'lost') stLabel = 'از دست رفته';
      if (stLabel) identityStatusHtml = '<div>وضعیت: ' + esc(stLabel) + '</div>';
      if (typeof customerBehavior === 'function') {
        const idb = customerBehavior(c.id, ctx);
        if (idb && idb.behindPattern === true && idb.daysSinceLast != null && idb.avgIntervalDays != null) {
          const idBehind = Math.round(idb.daysSinceLast - idb.avgIntervalDays);
          if (idBehind > 0) identityBehindHtml = '<div>' + esc(String(idBehind)) + ' روز عقب‌تر از روال</div>';
        }
      }
    } catch (eIdentity) { /* display-only: ignore */ }

    var attentionItems = buildCustomerAttentionItems(c.id, ctx);
    var storyText = '';
    try {
      var pNow = (typeof calculateCustomerPriority === 'function') ? calculateCustomerPriority(c.id, { ctx: ctx }) : null;
      storyText = pNow && pNow.customerStory && pNow.customerStory.summary ? pNow.customerStory.summary : '';
    } catch (eStory) { storyText = ''; }
    var rejectionInsightsHtml = productRejectionInsightsHtml(c.id, ctx);
    var basketHtml = '';
    if (behaviorData && behaviorData.decliningProducts && behaviorData.decliningProducts.length) {
      basketHtml = '<div class="customer-basket-insight"><div class="customer-detail-subtitle">کالاهای با کاهش خرید</div><div class="customer-tx-list customer-declining-products">' + behaviorData.decliningProducts.slice(0,8).map(function(p){ return '<div class="ledger-row customer-static-row"><span class="name">' + esc(p.name) + '<span class="sub">از ' + fmtQtyDisplay(p.earlyQty) + ' به ' + fmtQtyDisplay(p.lateQty) + '</span></span></div>'; }).join('') + '</div></div>';
    }
    var focusItems = attentionItems.slice(0, recommendedAction ? 2 : 3);
    var focusHtml = '<section class="customer-section customer-focus-section"><div class="customer-section-kicker">نیازمند توجه</div><div class="customer-focus-list">' +
      (recommendedAction ? '<div class="customer-focus-item is-primary"><div class="customer-focus-title">' + esc(recommendedAction.action) + '</div><div class="customer-focus-why">' + esc(recommendedAction.reason || storyText || '') + '</div><button type="button" class="btn small" id="cust-recommended-action">انجام</button></div>' : '') +
      focusItems.map(function(it){ return '<div class="customer-focus-item' + (it.watchId ? ' is-actionable' : '') + '"' + (it.watchId ? ' data-watch-occ="' + esc(it.watchId) + '" role="button" tabindex="0"' : '') + '><div class="customer-focus-title">' + esc(it.title) + '</div>' + attentionEvidenceHtml(it.evidence) + '</div>'; }).join('') +
      '</div></section>';
    if (!recommendedAction && !focusItems.length) focusHtml = '';
    var behavior = behaviorData || {};
    var trendText = behavior.amountTrend === 'up' ? 'افزایشی' : behavior.amountTrend === 'down' ? 'کاهشی' : behavior.amountTrend === 'flat' ? 'ثابت' : '—';
    var summaryHtml = '<section class="customer-section customer-summary-section"><div class="customer-section-kicker">خلاصه</div><div class="customer-summary-grid">' +
      '<div><span>آخرین خرید</span><strong>' + (behavior.lastInvoiceDate ? faDate(behavior.lastInvoiceDate) : '—') + '</strong></div>' +
      '<div><span>روال معمول</span><strong>' + (behavior.avgIntervalDays != null ? enToFaDigits(String(Math.round(behavior.avgIntervalDays * 10) / 10)) + ' روز' : '—') + '</strong></div>' +
      '<div><span>روند مبلغ</span><strong>' + trendText + '</strong></div>' +
      '<div><span>مانده</span><strong class="' + color + '">' + (t.balance === 0 ? 'تسویه' : toman(Math.abs(t.balance)) + ' ت') + '</strong></div>' +
      '<div><span>خرید</span><strong>' + toman(t.invTotal) + ' ت</strong></div>' +
      '<div><span>پرداخت</span><strong>' + toman(t.payTotal) + ' ت</strong></div>' +
      '<div><span>چک</span><strong>' + toman(t.checkTotal) + ' ت</strong></div>' +
      '<div><span>سود</span><strong>' + toman(profit) + ' ت</strong></div></div></section>';
    var analysisDetails = '<section class="customer-details-section"><details class="customer-analysis-details"><summary>تحلیل کالا</summary>' + (basketHtml || '') + (rejectionInsightsHtml ? '<div class="customer-secondary-insight">' + rejectionInsightsHtml + '</div>' : '') + '</details>' +
      (behaviorHtml ? '<div class="customer-behavior-details-wrap">' + behaviorHtml + '</div>' : '') +
      '<details><summary>فاکتورها (' + invs.length + ')</summary><div class="customer-tx-list customer-invoice-list">' + invRows + '</div></details>' +
      '<details><summary>پرداخت‌ها (' + pays.length + ')</summary><div class="customer-tx-list customer-payment-list">' + payRows + '</div></details>' +
      '<details><summary>چک‌ها (' + chks.length + ')</summary><div class="customer-tx-list customer-check-list">' + chkRows + '</div></details>' +
      '<details><summary>ویزیت‌ها و ارزیابی‌ها (' + visits.length + ')</summary><div class="btn-row" style="margin-bottom:8px;"><button type="button" class="btn small" id="act-visit-section">ثبت ویزیت برای این مشتری</button><a class="btn small secondary" href="#/visits">همه ویزیت‌ها</a></div><div class="customer-tx-list customer-visit-list">' + visitRows + '</div></details>' +
      '</section>';

    root.innerHTML =
      '<div class="customer-master">' +
      '<div class="customer-topline"><a class="btn secondary small" href="' + customersHref() + '">مشتریان</a></div>' +
      '<section class="customer-section customer-identity-section"><div class="customer-identity-name">' + esc(c.name) + '</div><div class="customer-identity-meta">' + identityStatusHtml + (c.phone ? '<div>' + esc(c.phone) + '</div>' : '') + (c.locationId ? '<div>' + esc(getLocationDisplayString(c.locationId)) + '</div>' : ((c.region ? '<div>' + esc(c.region) + '</div>' : '') + (c.route ? '<div>' + esc(c.route) + '</div>' : ''))) + '</div></section>' +
      focusHtml +
      '<section class="customer-section customer-actions-section"><div class="customer-section-kicker">اقدام</div><div class="btn-row cust-actions-primary"><button type="button" class="btn" id="act-invoice">ثبت فاکتور</button><button type="button" class="btn secondary" id="act-visit">ثبت ویزیت</button><button type="button" class="btn secondary" id="act-pay">ثبت پرداخت</button><button type="button" class="btn secondary" id="act-more">سایر</button></div></section>' +
      summaryHtml + analysisDetails + '</div>';


    document.getElementById('act-invoice').onclick = function () {
      openAddInvoice(c.id);
    };
    document.getElementById('act-pay').onclick = function () {
      openAddTransaction(c.id);
    };
    document.getElementById('act-visit').onclick = function () {
      openAddVisit(c.id);
    };
    const visitSecBtn = document.getElementById('act-visit-section');
    if (visitSecBtn)
      visitSecBtn.onclick = function () {
        openAddVisit(c.id);
      };
    document.getElementById('act-more').onclick = function () {
      openSheet('<h3>سایر اقدام‌ها</h3><div class="btn-row" style="flex-direction:column;gap:8px;">' +
        '<button type="button" class="btn secondary" id="act-check">ثبت چک</button>' +
        '<button type="button" class="btn secondary" id="act-edit">ویرایش مشتری</button>' +
        '<button type="button" class="btn secondary" id="act-location">اختصاص موقعیت</button>' +
        '<button type="button" class="btn secondary" id="act-print-statement">صورت‌حساب</button>' +
        '<button type="button" class="btn secondary" id="act-toggle-active">' + (c.active === false ? 'فعال‌سازی' : 'غیرفعال‌سازی') + '</button></div>');
      document.getElementById('act-check').onclick = function () { openAddCheck(c.id); };
      document.getElementById('act-edit').onclick = function () { openAddCustomer(c.id); };
      document.getElementById('act-location').onclick = function () { openLocationAssignSheet({ title:'اختصاص موقعیت — ' + c.name, currentLocationId:c.locationId || null, onSave:async function(locationId){ await setCustomerLocation(c.id, locationId); showToast('موقعیت ذخیره شد'); render(); } }); };
      var printBtn = document.getElementById('act-print-statement');
      if (printBtn) printBtn.onclick = function () { if (typeof printCustomerStatement === 'function') printCustomerStatement(c.id); };
      var toggle = document.getElementById('act-toggle-active');
      if (toggle) toggle.onclick = toggleCustomerActive;
    };
    function toggleCustomerActive(ev) {
      return withSubmitGuard(ev && ev.currentTarget, async function () {
        var willDeactivate = c.active !== false;
        var msg = willDeactivate ? 'این مشتری غیرفعال شود؟ اطلاعات، فاکتورها، پرداخت‌ها، چک‌ها و سوابق او حذف نخواهد شد.' : 'مشتری «' + c.name + '» دوباره فعال شود؟';
        if (!(await appConfirm(msg))) throw new Error('validation');
        c.active = (c.active === false) ? true : false;
        await saveData(); drawCustomerPage(rootEl || root); showToast(c.active === false ? 'مشتری غیرفعال شد' : 'مشتری فعال شد');
      });
    }
    const recommendedBtn = document.getElementById('cust-recommended-action');
    if (recommendedBtn && recommendedAction) {
      recommendedBtn.onclick = function () {
        const type = recommendedAction.actionType;
        if (type === 'visit' || type === 'follow_up') {
          openAddVisit(c.id);
        } else if (type === 'check_followup') {
          openAddCheck(c.id);
        } else if (type === 'payment_followup') {
          openAddTransaction(c.id);
        } else {
          // For action types without a dedicated existing form (e.g. investigate,
          // manager_review, call), expose the existing explanation rather than
          // inventing a new workflow.
          const target = root.querySelector('.customer-behavior-details');
          if (target) target.open = true;
          if (target && typeof target.scrollIntoView === 'function') {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }
      };
    }

    const toggleActiveBtn = document.getElementById('act-toggle-active');
    if (toggleActiveBtn) {
      toggleActiveBtn.onclick = async function (ev) {
        await withSubmitGuard(ev.currentTarget, async () => {
          const willDeactivate = c.active !== false;
          const msg = willDeactivate
            ? 'این مشتری غیرفعال شود؟ اطلاعات، فاکتورها، پرداخت‌ها، چک‌ها و سوابق او حذف نخواهد شد.'
            : 'مشتری «' + c.name + '» دوباره فعال شود؟';
          if (!(await appConfirm(msg))) throw new Error('validation');
          c.active = (c.active === false) ? true : false;
          await saveData();
          drawCustomerPage(rootEl || root);
          showToast(c.active === false ? 'مشتری غیرفعال شد' : 'مشتری فعال شد');
        });
      };
    }
    bindWatchLifecycleRows(root);
    bindWatchFollowUps(root, id);
  }

  function mount(root, params) {
    let refreshToken = null;
    if (!root) return function () {};
    rootEl = root;

    const nav = document.getElementById('nav');
    if (nav) nav.style.display = '';

    currentCustomerId = params && params.id ? params.id : null;
    function refreshCustomer() {
      // Per-cycle, RAM-only Context: shared only so that reconcileWatchLifecycle's
      // Watch-observation pass and the subsequent Priority/Signals pass (both of
      // which independently derive the same per-customer SKU aggregation) don't
      // recompute _aggregatePairMap twice for the same data snapshot. Discarded
      // after this refreshCustomer() call; never persisted, never reused elsewhere.
      var ctx = typeof createComputationContext === 'function'
        ? createComputationContext({ data: data })
        : { aggregatePairMapCache: Object.create(null) };
      function paint() { drawCustomerPage(rootEl || root, ctx); }
      // Paint immediately so the page is never blank if lifecycle reconcile hangs.
      paint();
      if (typeof reconcileWatchLifecycle === 'function' && currentCustomerId) {
        reconcileWatchLifecycle(currentCustomerId, ctx).then(paint).catch(function () { paint(); });
      }
    }
    refreshCustomer();
    refreshToken = ViewHost.setRefresh(refreshCustomer);

    return function unmount() {
      ViewHost.clearRefresh(refreshToken);
      refreshToken = null;
      currentCustomerId = null;
      root.classList.remove('customer-detail-view'); // UPDATED: Added for CSS scoping cleanup
      root.innerHTML = '';
      rootEl = null;
    };
  }

  global.CustomerView = { mount: mount, unmount: function () {} };
  // Test / settings seams for Product Rejection Insight (UI-only)
  global.getProductRejectionThreshold = getProductRejectionThreshold;
  global.setProductRejectionThreshold = setProductRejectionThreshold;
  global.buildProductRejectionInsights = buildProductRejectionInsights;

})(typeof window !== 'undefined' ? window : this);
