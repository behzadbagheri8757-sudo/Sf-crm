/* js/intelligence/action.js — Action Engine (Patch-only, on top of
   Signal Engine + Risk Engine + Priority Engine).
   ============================================================
   READ-ONLY layer:

     calculateCustomerPriority(cid)   [js/intelligence/priority.js]
           |
     THIS FILE (action.js)
           |
        { customerId, action, actionType, urgency, reason,
          primarySignal, priorityScore, riskLevel }

   Unified Daily Work Queue (additive):
     calculateAllActions() merges customer + prospect actions with
     unifiedScore = urgency + impact + timing. Fully read-only.
   ============================================================ */
'use strict';

(function (global) {

  // Fixed action-selection order, exactly as specified for this engine.
  const ACTION_PRIORITY_ORDER = [
    'CHECK_BOUNCED',
    'PAYMENT_OVERDUE',
    'PURCHASE_DECLINE_SEVERE',
    'MULTI_SKU_DECLINE',
    'COMBINED_SKU_DETERIORATION',
    'BEHIND_PATTERN',
    'CONSECUTIVE_NO_ORDER',
    'SKU_DELAY',
    'SKU_QUANTITY_DROP',
    'SKU_FREQUENCY_DROP',
    'LINE_DROP',
    'KEY_PRODUCT_LOST',
    'BASKET_SHRINK',
    'PURCHASE_DECLINE_MILD',
    'LONG_NO_VISIT',
    'VISIT_OVERDUE',
    'VISIT_CONVERSION_LOW',
    'PURCHASE_GROWTH',
  ];

  // category -> { actionType, urgency, action (Persian, user-facing) }
  const ACTION_RULES = {
    CHECK_BOUNCED: {
      actionType: 'check_followup',
      urgency: 'critical',
      action: 'پیگیری فوری چک برگشتی',
    },
    PAYMENT_OVERDUE: {
      actionType: 'payment_followup',
      urgency: 'high',
      action: 'پیگیری وصول مطالبات سررسیدگذشته',
    },
    PURCHASE_DECLINE_SEVERE: {
      actionType: 'visit',
      urgency: 'high',
      action: 'ویزیت حضوری برای بررسی افت شدید خرید',
    },
    BEHIND_PATTERN: {
      actionType: 'visit',
      urgency: 'high',
      action: 'ویزیت حضوری — مشتری از الگوی خرید عقب افتاده',
    },
    CONSECUTIVE_NO_ORDER: {
      actionType: 'visit',
      urgency: 'high',
      action: 'ویزیت حضوری برای شکستن روند بدون‌سفارشی',
    },
    MULTI_SKU_DECLINE: {
      actionType: 'manager_review',
      urgency: 'high',
      action: 'بررسی مدیر — افت چندمحصولی حساب',
    },
    COMBINED_SKU_DETERIORATION: {
      actionType: 'manager_review',
      urgency: 'high',
      action: 'بررسی مدیر — چند مشکل همزمان روی یک محصول',
    },
    SKU_DELAY: {
      actionType: 'visit',
      urgency: 'high',
      action: 'ویزیت حضوری برای بررسی تأخیر خرید محصول',
    },
    SKU_QUANTITY_DROP: {
      actionType: 'investigate',
      urgency: 'medium',
      action: 'بررسی علت کاهش مقدار خرید محصول',
    },
    SKU_FREQUENCY_DROP: {
      actionType: 'call',
      urgency: 'medium',
      action: 'تماس امروز درباره کاهش تعداد خرید محصول',
    },
    LINE_DROP: {
      actionType: 'visit',
      urgency: 'medium',
      action: 'ویزیت حضوری برای بررسی حذف محصول از سبد',
    },
    KEY_PRODUCT_LOST: {
      actionType: 'visit',
      urgency: 'medium',
      action: 'ویزیت حضوری برای بررسی توقف خرید محصول کلیدی',
    },
    BASKET_SHRINK: {
      actionType: 'visit',
      urgency: 'medium',
      action: 'ویزیت حضوری برای بررسی کوچک‌شدن سبد خرید',
    },
    PURCHASE_DECLINE_MILD: {
      actionType: 'visit',
      urgency: 'medium',
      action: 'ویزیت حضوری برای بررسی کاهش خفیف خرید',
    },
    LONG_NO_VISIT: {
      actionType: 'visit',
      urgency: 'medium',
      action: 'ویزیت حضوری — مدتی است مشتری دیده نشده',
    },
    VISIT_OVERDUE: {
      actionType: 'visit',
      urgency: 'medium',
      action: 'ویزیت حضوری — از الگوی ویزیت عقب افتاده',
    },
    VISIT_CONVERSION_LOW: {
      actionType: 'visit',
      urgency: 'low',
      action: 'بررسی نرخ تبدیل ویزیت به سفارش',
    },
    PURCHASE_GROWTH: {
      actionType: 'follow_up',
      urgency: 'low',
      action: 'پیگیری تلفنی برای تثبیت و تقویت رشد خرید',
    },
  };

  const NO_ACTION_RESULT_BASE = {
    action: 'اقدامی لازم نیست',
    actionType: 'no_action',
    urgency: 'low',
    reason: 'بدون Signal فعال',
  };

  function _actionPriorityRank(category) {
    const idx = ACTION_PRIORITY_ORDER.indexOf(category);
    return idx === -1 ? ACTION_PRIORITY_ORDER.length : idx;
  }

  function _pickActionSignal(signals) {
    if (!signals || !signals.length) return null;
    let best = null;
    let bestScore = -Infinity;
    let bestRank = Infinity;
    signals.forEach(function (s) {
      if (!s || !ACTION_RULES[s.category]) return;
      // BUGFIX (proven by runtime repro): this selection ignored two
      // explicit flags that upstream stages compute for exactly this
      // purpose — persistence.js's s.status ("pending" = not yet
      // confirmed by a second occurrence; immediate categories are
      // already 'active' on first hit, so they are unaffected) and
      // seasonality.js's s.seasonallySuppressed (explicitly marked as a
      // likely false decline). Without these checks, a single unconfirmed
      // or seasonally-explained detection could still generate a concrete
      // operational action. Missing/undefined status is still treated as
      // active, matching the existing convention in risk.js/priority.js.
      if (s.status === 'pending') return;
      if (s.seasonallySuppressed === true) return;
      const r = _actionPriorityRank(s.category);
      // Risk and opportunity share one evidence scale. Category order is only
      // a deterministic tie-breaker, not a risk-first preference.
      const base = (typeof s.severityPoints === 'number' && isFinite(s.severityPoints))
        ? s.severityPoints
        : ({ critical: 100, high: 70, medium: 40, low: 20 }[s.severity] || 0);
      const score = base + (s.productId && s.productId !== 'multi' ? 0.5 : 0);
      if (score > bestScore || (score === bestScore && r < bestRank)) {
        bestRank = r;
        bestScore = score;
        best = s;
      }
    });
    return best;
  }

  /* P-07: operational contexts — only from real data; never invent. */
  function stockContext(productId, signal) {
    if (productId == null || productId === '' || productId === 'multi') return null;
    // Family signals: productId is only the display representative, so stock is
    // decided over the whole Family (any usable member => not out of stock).
    if (signal && signal.familyId != null && signal.familyId !== '' && typeof familyStockOut === 'function') {
      var famMembers = (signal.evidence && Array.isArray(signal.evidence.memberProductIds)) ? signal.evidence.memberProductIds : null;
      return familyStockOut(signal.familyId, famMembers, productId) ? 'موجودی انبار تمام است' : null;
    }
    if (typeof data === 'undefined' || !Array.isArray(data.products)) return null;
    var p = null;
    for (var i = 0; i < data.products.length; i++) {
      if (data.products[i] && data.products[i].id === productId) {
        p = data.products[i];
        break;
      }
    }
    if (!p || typeof p.stockQty !== 'number' || !isFinite(p.stockQty)) return null;
    if (p.stockQty <= 0) return 'موجودی انبار تمام است';
    return null; // positive stock is not actionable context for the allowed samples
  }

  function visitContext(customerId, ctx) {
    if (!customerId) return null;
    // A customer with no recorded visits has no visit cadence context; do not
    // label it "due soon" merely because an external overdue helper returns 0.
    var contextCustomer = null;
    if (ctx && typeof ctx.customerById === 'function') {
      contextCustomer = ctx.customerById(customerId);
    } else if (typeof data !== 'undefined' && Array.isArray(data.customers)) {
      for (var cvi = 0; cvi < data.customers.length; cvi++) {
        if (data.customers[cvi] && data.customers[cvi].id === customerId) {
          contextCustomer = data.customers[cvi];
          break;
        }
      }
    }
    var hasVisits = !!(contextCustomer && Array.isArray(contextCustomer.visits) && contextCustomer.visits.length);
    // Prefer existing visitOverdueDays helper when present
    if (typeof visitOverdueDays === 'function') {
      try {
        var overdue = visitOverdueDays(customerId, ctx);
        if (overdue != null && isFinite(overdue) && overdue > 0) {
          // "ویزیت نزدیک" only when slightly overdue / due soon — keep short
          if (overdue <= 7) return 'در ویزیت بعدی';
          return null; // large overdue already covered by action reason/whyNow
        }
        if (overdue === 0 && hasVisits) return 'در ویزیت بعدی';
      } catch (e) { /* ignore */ }
    }
    // Fallback: visitCadence + last visit if both available
    if (typeof visitCadence === 'function' && typeof customerBehavior === 'function' && typeof daysAgo === 'function') {
      try {
        var cadence = visitCadence(customerId, ctx);
        var b = customerBehavior(customerId, ctx);
        if (cadence && b && b.lastVisit && b.lastVisit.date) {
          var days = daysAgo(b.lastVisit.date);
          if (days != null && isFinite(days) && days >= 0) {
            var buffer = Math.min(7, cadence * 0.5);
            // due soon: within cadence window (not heavily overdue)
            if (days <= cadence + buffer && days >= Math.max(0, cadence - buffer)) {
              return 'در ویزیت بعدی';
            }
          }
        }
      } catch (e2) { /* ignore */ }
    }
    return null;
  }

  function feedbackContext(signal) {
    if (!signal) return null;
    // Prefer fields already attached by P-03
    if (signal.feedbackHint) return signal.feedbackHint;
    if (signal.feedback && signal.feedback.reasonCode === 'competitor_bought') {
      return 'از رقیب خریداری شده';
    }
    if (signal.feedback && signal.feedback.reasonCode === 'still_stock') {
      return 'موجودی نزد مشتری';
    }
    if (signal.feedback && signal.feedback.reasonCode === 'no_need') return 'فعلاً نیاز ندارد';
    if (signal.feedback && signal.feedback.reasonCode === 'price_issue') return 'اعتراض قیمت';
    if (signal.feedback && signal.feedback.reasonCode === 'quality') return 'اعتراض کیفیت';
    // Live lookup only if API exists and nothing attached yet
    if (typeof getFeedbackForSignal === 'function') {
      try {
        var fb = getFeedbackForSignal(signal);
        if (!fb || !fb.reasonCode) return null;
        if (fb.reasonCode === 'competitor_bought') return 'از رقیب خریداری شده';
        if (fb.reasonCode === 'still_stock') return 'موجودی نزد مشتری';
        if (fb.reasonCode === 'no_need') return 'فعلاً نیاز ندارد';
        if (fb.reasonCode === 'price_issue') return 'اعتراض قیمت';
        if (fb.reasonCode === 'quality') return 'اعتراض کیفیت';
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  function _applyCurrentContextFilter(cid, signals, ctx) {
    if (!Array.isArray(signals) || !signals.length) return signals || [];

    const skuCategories = {
      SKU_DELAY: true,
      SKU_QUANTITY_DROP: true,
      SKU_FREQUENCY_DROP: true,
      LINE_DROP: true,
      COMBINED_SKU_DETERIORATION: true,
    };

    let customer = null;
    if (ctx && typeof ctx.customerById === 'function') {
      customer = ctx.customerById(cid);
    } else if (typeof data !== 'undefined' && Array.isArray(data.customers)) {
      for (let i = 0; i < data.customers.length; i++) {
        if (data.customers[i] && data.customers[i].id === cid) {
          customer = data.customers[i];
          break;
        }
      }
    }

    const visits = customer && Array.isArray(customer.visits) ? customer.visits : [];

    function validISODate(value) {
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
    }

    // Family-aware (runtime): an offered product counts if it resolves to the
    // same Family (analysisGroupId||productId) as the signal. productId on
    // the signal stays untouched for display/context.
    const famOf = (typeof makeFamilyResolver === 'function')
      ? makeFamilyResolver(ctx)
      : function (pid) { return pid; };

    function latestProductContext(signal) {
      const productId = signal.productId;
      const familyKey = (signal.familyId != null && signal.familyId !== '')
        ? signal.familyId
        : famOf(productId);
      let latest = null;
      for (let vi = 0; vi < visits.length; vi++) {
        const visit = visits[vi];
        if (!visit || !validISODate(visit.date) || !Array.isArray(visit.offeredProducts)) continue;
        for (let oi = 0; oi < visit.offeredProducts.length; oi++) {
          const op = visit.offeredProducts[oi];
          if (!op || !op.productId) continue;
          if (op.productId !== productId && famOf(op.productId) !== familyKey) continue;
          const timeKey = _visitTimeKey(visit.time);
          if (!latest || visit.date > latest.date ||
              (visit.date === latest.date && timeKey > latest.timeKey) ||
              (visit.date === latest.date && timeKey === latest.timeKey && vi > latest.visitIndex) ||
              (visit.date === latest.date && timeKey === latest.timeKey && vi === latest.visitIndex && oi > latest.offerIndex)) {
            latest = {
              date: visit.date,
              timeKey: timeKey,
              visitIndex: vi,
              offerIndex: oi,
              reaction: op.reaction,
              rejectionReason: op.rejectionReason,
            };
          }
        }
      }
      return latest;
    }

    function latestNoOrderVisit() {
      let latest = null;
      for (let vi = 0; vi < visits.length; vi++) {
        const visit = visits[vi];
        if (!visit || !validISODate(visit.date)) continue;
        const noOrder = visit.ordered === false ||
          (typeof VISIT_RESULTS !== 'undefined' && visit.result !== VISIT_RESULTS[0]);
        if (!noOrder) continue;
        const timeKey = _visitTimeKey(visit.time);
        if (!latest || visit.date > latest.date ||
            (visit.date === latest.date && timeKey > latest.timeKey) ||
            (visit.date === latest.date && timeKey === latest.timeKey && vi > latest.visitIndex)) {
          latest = { date: visit.date, timeKey: timeKey, visitIndex: vi };
        }
      }
      return latest;
    }

    const noOrderVisit = latestNoOrderVisit();
    let laterInvoiceExists = false;
    if (noOrderVisit && typeof data !== 'undefined' && Array.isArray(data.invoices)) {
      for (let i = 0; i < data.invoices.length; i++) {
        const invoice = data.invoices[i];
        if (!invoice || invoice.customerId !== cid || !validISODate(invoice.date)) continue;
        if (invoice.date > noOrderVisit.date) {
          laterInvoiceExists = true;
          break;
        }
      }
    }

    return signals.filter(function (signal) {
      if (!signal || !signal.category) return true;

      if (skuCategories[signal.category] && signal.productId != null && signal.productId !== '' && signal.productId !== 'multi') {
        const context = latestProductContext(signal);
        if (context && context.reaction === 'rejected' &&
            (context.rejectionReason === 'still_stock' ||
             context.rejectionReason === 'no_need' ||
             context.rejectionReason === 'not_wanted' ||
             context.rejectionReason === 'unavailable')) {
          return false;
        }
      }

      if (signal.category === 'CONSECUTIVE_NO_ORDER' && laterInvoiceExists) {
        return false;
      }

      return true;
    });
  }

  /* Minimum weighted coverage of the declining products by recent still_stock /
     no_need visit outcomes for the action to be considered no longer needed.
     Product contract value (80%); the single place to change it. */
  const ACTION_ELIGIBILITY_MIN_COVERAGE = 0.80;

  /* Action Eligibility (read-only).
     Each candidate is checked independently while the action selector walks
     candidates in priority order. Signal / Risk / Priority / persistence are
     never touched; this only decides whether a candidate is still worth putting
     in today's queue. PURCHASE_DECLINE_SEVERE keeps its fail-open behavior for
     unprovable data. BEHIND_PATTERN is fail-closed: it requires a callable,
     valid customerBehavior result with a finite distinctIntervalCount >= 2 and
     behindPatternDistinct === true. A rejected candidate is not terminal; the
     selector continues to the next candidate.

     For PURCHASE_DECLINE_SEVERE, the signal is customer-level and carries no product, so its "topic" is the
     existing customerBehavior().decliningProducts list, each entry weighted by its
     earlyQty. An entry is COVERED when its latest visit offer inside the existing
     episode window (PERSISTENCE_PARAMS.windowDays) is reaction 'rejected' with
     rejectionReason still_stock / no_need (same product, else same Family via the
     existing makeFamilyResolver). accepted / deferred / ordered never cover.
     The action is NOT eligible when coveredWeight / totalWeight >= 80%
     (ACTION_ELIGIBILITY_MIN_COVERAGE) and the customer has not bought any
     declining Family on an invoice dated after the visit that was matched to it.
      Anything not provable for PURCHASE_DECLINE_SEVERE (no visits, invalid
      decliningProducts / earlyQty / dates, unresolvable product, missing
      window, any error) => eligible (fail-open). */
  function _isActionEligible(winnerSignal, cid, ctx) {
    try {
      if (!winnerSignal) return true;
      // A persisted BEHIND_PATTERN candidate may outlive the generation
      // guard. Re-check the real customer history before promoting it as a
      // fallback: one interval is not an established purchase rhythm.
      if (winnerSignal.category === 'BEHIND_PATTERN') {
        try {
          if (typeof customerBehavior !== 'function') return false;
          var behind = customerBehavior(cid, ctx);
          if (!behind || typeof behind.distinctIntervalCount !== 'number' ||
              !isFinite(behind.distinctIntervalCount) ||
              behind.distinctIntervalCount < 2 ||
              behind.behindPatternDistinct !== true) return false;
          return true;
        } catch (eBehind) {
          return false;
        }
      }
      if (winnerSignal.category !== 'PURCHASE_DECLINE_SEVERE') return true;
      if (typeof customerBehavior !== 'function' || typeof daysAgo !== 'function') return true;
      if (typeof PERSISTENCE_PARAMS === 'undefined' || !PERSISTENCE_PARAMS ||
          typeof PERSISTENCE_PARAMS.windowDays !== 'number' ||
          !isFinite(PERSISTENCE_PARAMS.windowDays) || !(PERSISTENCE_PARAMS.windowDays > 0)) return true;
      const windowDays = PERSISTENCE_PARAMS.windowDays;

      const behavior = customerBehavior(cid, ctx);
      const declining = (behavior && Array.isArray(behavior.decliningProducts)) ? behavior.decliningProducts : [];
      if (!declining.length) return true;

      let customer = null;
      if (ctx && typeof ctx.customerById === 'function') {
        customer = ctx.customerById(cid);
      } else if (typeof data !== 'undefined' && Array.isArray(data.customers)) {
        for (let i = 0; i < data.customers.length; i++) {
          if (data.customers[i] && data.customers[i].id === cid) { customer = data.customers[i]; break; }
        }
      }
      const visits = customer && Array.isArray(customer.visits) ? customer.visits : [];
      if (!visits.length) return true;

      const famOf = (typeof makeFamilyResolver === 'function')
        ? makeFamilyResolver(ctx)
        : function (pid) { return pid; };
      const isoRe = /^\d{4}-\d{2}-\d{2}$/;
      const invoices = (typeof data !== 'undefined' && Array.isArray(data.invoices)) ? data.invoices : [];

      let totalWeight = 0;
      let coveredWeight = 0;
      for (let di = 0; di < declining.length; di++) {
        const entry = declining[di];
        const pid = entry && entry.productId;
        const weight = entry && entry.earlyQty;
        if (!pid || typeof weight !== 'number' || !isFinite(weight) || !(weight > 0)) return true;   // not reliable
        const topic = famOf(pid);
        if (topic == null || topic === '') return true;                                              // topic not resolvable
        totalWeight += weight;

        // latest visit offer for this topic (same product, or same Family) inside the window
        let latest = null;
        for (let vi = 0; vi < visits.length; vi++) {
          const visit = visits[vi];
          if (!visit || typeof visit.date !== 'string' || !isoRe.test(visit.date) ||
              !Array.isArray(visit.offeredProducts)) continue;
          const age = daysAgo(visit.date);
          if (age == null || !isFinite(age) || age < 0 || age > windowDays) continue;                // not a recent valid visit
          for (let oi = 0; oi < visit.offeredProducts.length; oi++) {
            const op = visit.offeredProducts[oi];
            if (!op || !op.productId || famOf(op.productId) !== topic) continue;
            const t = String(visit.time || '');
            if (!latest || visit.date > latest.date ||
                (visit.date === latest.date && (t > latest.time ||
                  (t === latest.time && (vi > latest.vi || (vi === latest.vi && oi > latest.oi)))))) {
              latest = { date: visit.date, time: t, vi: vi, oi: oi, op: op };
            }
          }
        }
        if (!latest) continue;                       // no recent related offer => uncovered

        // bought this Family after that visit => the recorded outcome is superseded: keep the action
        for (let ii = 0; ii < invoices.length; ii++) {
          const inv = invoices[ii];
          if (!inv || inv.customerId !== cid || typeof inv.date !== 'string' || !(inv.date > latest.date)) continue;
          const items = Array.isArray(inv.items) ? inv.items : [];
          for (let ti = 0; ti < items.length; ti++) {
            const it = items[ti];
            if (it && it.productId && it.qty > 0 && famOf(it.productId) === topic) return true;
          }
        }

        const op = latest.op;
        if (op.reaction === 'rejected' &&
            (op.rejectionReason === 'still_stock' || op.rejectionReason === 'no_need')) {
          coveredWeight += weight;
        }
      }
      // not eligible only when the weighted coverage reaches the contract threshold
      return !(totalWeight > 0 && (coveredWeight / totalWeight) >= ACTION_ELIGIBILITY_MIN_COVERAGE);
    } catch (e) {
      return true;    // never block an action because of an error
    }
  }

  function _productNamesForSignal(signal) {
    if (!signal) return [];
    var names = [];
    var lost = signal.evidence && Array.isArray(signal.evidence.hardLost) ? signal.evidence.hardLost : [];
    lost.forEach(function (p) {
      if (p && p.name && names.indexOf(p.name) === -1) names.push(p.name);
    });
    if (!names.length && signal.productName) names.push(signal.productName);
    return names;
  }

  // Minimal local time key for ordering visits within the same date.
// Assumption: valid values use 24-hour HH:MM (zero-padded). This does not
// validate or rewrite stored visit.time. Empty/invalid values sort before
// valid times; equal keys retain the existing visit/offer index fallback.
function _visitTimeKey(value) {
  if (typeof value !== 'string') return -1;
  var m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return m ? (Number(m[1]) * 60 + Number(m[2])) : -1;
}

function _latestVisitFeedback(cid, signal, ctx) {
    if (!signal || signal.productId == null || signal.productId === '' || signal.productId === 'multi') return null;
    var customer = ctx && typeof ctx.customerById === 'function' ? ctx.customerById(cid) : null;
    if (!customer && typeof data !== 'undefined' && Array.isArray(data.customers)) {
      customer = data.customers.find(function (c) { return c && c.id === cid; });
    }
    var visits = customer && Array.isArray(customer.visits) ? customer.visits : [];
    var famOf = typeof makeFamilyResolver === 'function' ? makeFamilyResolver(ctx) : function (pid) { return pid; };
    var family = signal.familyId != null && signal.familyId !== '' ? signal.familyId : famOf(signal.productId);
    var latest = null;
    visits.forEach(function (v, vi) {
      if (!v || !Array.isArray(v.offeredProducts) || typeof v.date !== 'string') return;
      var timeKey = _visitTimeKey(v.time);
      v.offeredProducts.forEach(function (op, oi) {
        if (!op || !op.productId || !famOf(op.productId) || famOf(op.productId) !== family) return;
        if (!latest || v.date > latest.date ||
            (v.date === latest.date && timeKey > latest.timeKey) ||
            (v.date === latest.date && timeKey === latest.timeKey && (vi > latest.vi || (vi === latest.vi && oi > latest.oi)))) {
          latest = { date: v.date, timeKey: timeKey, vi: vi, oi: oi, reaction: op.reaction, reason: op.rejectionReason };
        }
      });
    });
    if (!latest || latest.reaction !== 'rejected') return null;
    return ({
      still_stock: 'موجودی نزد مشتری', no_need: 'فعلاً نیاز ندارد', not_wanted: 'محصول را نمی‌خواهد',
      competitor: 'از رقیب خریداری شده', price: 'اعتراض قیمت', quality: 'اعتراض کیفیت',
      unavailable: 'عدم دسترسی به محصول', other: 'دلیل ثبت‌شده در ویزیت'
    })[latest.reason] || null;
  }

  function _pendingFollowUp(cid, signal, ctx) {
    if (typeof getPendingWatchFollowUps !== 'function') return null;
    try {
      var rows = getPendingWatchFollowUps(cid) || [];
      var famOf = typeof makeFamilyResolver === 'function'
        ? makeFamilyResolver(ctx)
        : function (pid) {
          if (typeof resolveFamilyId === 'function') {
            try { return resolveFamilyId(pid, ctx); } catch (e) { /* fail closed */ }
          }
          return pid;
        };
      var signalFamily = signal && signal.productId != null && signal.productId !== '' && signal.productId !== 'multi'
        ? (signal.familyId != null && signal.familyId !== '' ? signal.familyId : famOf(signal.productId))
        : null;
      return rows.find(function (r) {
        if (!r) return false;
        if (signalFamily == null) return r.productId == null || r.productId === '' || r.productId === 'multi';
        if (r.productId == null || r.productId === '' || r.productId === 'multi') return false;
        if (r.productId === signal.productId) return true;
        var pendingFamily = famOf(r.productId);
        return pendingFamily != null && pendingFamily !== '' && pendingFamily === signalFamily;
      }) || null;
    } catch (e) { return null; }
  }

  function _watchReasonContext(cid, signal, ctx) {
    if (typeof getActiveWatchOccurrences !== 'function') return null;
    try {
      var rows = getActiveWatchOccurrences(cid) || [];
      var famOf = typeof makeFamilyResolver === 'function'
        ? makeFamilyResolver(ctx)
        : function (pid) {
          if (typeof resolveFamilyId === 'function') {
            try { return resolveFamilyId(pid); } catch (e) { /* fail closed */ }
          }
          return pid;
        };
      var signalFamily = signal && signal.productId != null && signal.productId !== '' && signal.productId !== 'multi'
        ? (signal.familyId != null && signal.familyId !== '' ? signal.familyId : famOf(signal.productId))
        : null;
      var newest = null;
      rows.forEach(function (r) {
        if (!r || r.status !== 'active' || !r.reason || !r.reason.code) return;
        if (signalFamily == null) {
          if (r.productId != null && r.productId !== '' && r.productId !== 'multi') return;
        } else {
          if (r.productId == null || r.productId === '' || r.productId === 'multi') return;
          if (r.productId !== signal.productId && famOf(r.productId) !== signalFamily) return;
        }
      // lastEvaluatedAt tracks Watch refresh; reason.recordedAt tracks the
      // seller's actual reason entry and is authoritative when a reason exists.
      var timestamp = (r.reason && r.reason.recordedAt) || r.lastEvaluatedAt || r.firstDetectedAt;
        if (typeof timestamp !== 'string' || isNaN(Date.parse(timestamp))) return;
        if (!newest || Date.parse(timestamp) > newest.time) newest = { row: r, time: Date.parse(timestamp) };
      });
      if (!newest) return null;
      var row = newest.row;
      return ({
        competitor: 'خرید از رقیب', competitor_bought: 'خرید از رقیب', price: 'اعتراض قیمت',
        price_issue: 'اعتراض قیمت', quality: 'اعتراض کیفیت', no_need: 'فعلاً نیاز ندارد',
        still_stock: 'موجودی نزد مشتری', not_wanted: 'محصول را نمی‌خواهد', follow_up_later: 'پیگیری ثبت‌شده'
      })[row.reason.code] || null;
    } catch (e) { return null; }
  }

  function _isGenericRepeatedAction(cid, signal, ctx) {
    if (!signal || ['PURCHASE_DECLINE_SEVERE', 'KEY_PRODUCT_LOST', 'SKU_DELAY', 'SKU_QUANTITY_DROP', 'SKU_FREQUENCY_DROP', 'LINE_DROP', 'COMBINED_SKU_DETERIORATION', 'MULTI_SKU_DECLINE'].indexOf(signal.category) >= 0) return false;
    if (typeof customerBehavior !== 'function') return false;
    try {
      var b = customerBehavior(cid, ctx);
      return !!(b && b.lastNextAction === 'مراجعه مجدد' &&
        ['LONG_NO_VISIT', 'VISIT_OVERDUE', 'VISIT_CONVERSION_LOW', 'PURCHASE_DECLINE_MILD', 'BASKET_SHRINK'].indexOf(signal.category) >= 0);
    } catch (e) { return false; }
  }

  function calculateCustomerAction(cid, precomputedPriority, opts, skipMemo) {
    opts = opts || {};
    var ctx = opts.ctx || null;
    if (ctx && typeof ctx.memo === 'function' && !skipMemo) {
      return ctx.memo('customerActions', cid, function () {
        return calculateCustomerAction(cid, precomputedPriority, opts, true);
      });
    }
    const priority = precomputedPriority || (
      (typeof calculateCustomerPriority === 'function')
        ? calculateCustomerPriority(cid, opts)
        : { customerId: cid, priorityScore: 0, riskLevel: 'low', signals: [] }
    );

    const actionCandidates = _applyCurrentContextFilter(cid, priority.signals, ctx);
    // Filter before choosing: removing a stale winner must not hide a valid
    // next candidate.
    const eligibleCandidates = actionCandidates.filter(function (candidate) {
      if (!candidate || !ACTION_RULES[candidate.category]) return false;
      if (candidate.status === 'pending' || candidate.seasonallySuppressed === true) return false;
      if (_isGenericRepeatedAction(cid, candidate, ctx)) return false;
      return true;
    });
    // Select in priority order, but validate every candidate independently.
    // A candidate rejected by current context/eligibility must not block the
    // first later candidate that has sufficient evidence and is due now.
    let winner = null;
    let remainingCandidates = eligibleCandidates.slice();
    while (remainingCandidates.length) {
      const candidate = _pickActionSignal(remainingCandidates);
      if (!candidate) break;
      if (_isActionEligible(candidate, cid, ctx)) {
        winner = candidate;
        break;
      }
      remainingCandidates = remainingCandidates.filter(function (item) { return item !== candidate; });
    }

    if (!winner) {
      return Object.assign({
        customerId: cid,
        primarySignal: null,
        priorityScore: priority.priorityScore || 0,
        riskLevel: priority.riskLevel || 'low',
      }, NO_ACTION_RESULT_BASE);
    }

    const rule = ACTION_RULES[winner.category];
    var actionText = rule.action;
    var productNames = _productNamesForSignal(winner);
    // SKU signals: include product name in action message when available.
    if (productNames.length && (
      winner.category === 'SKU_DELAY' ||
      winner.category === 'SKU_QUANTITY_DROP' ||
      winner.category === 'SKU_FREQUENCY_DROP' ||
      winner.category === 'LINE_DROP' ||
      winner.category === 'COMBINED_SKU_DETERIORATION' ||
      winner.category === 'MULTI_SKU_DECLINE' ||
      winner.category === 'KEY_PRODUCT_LOST'
    )) {
      actionText = rule.action + ' («' + productNames.join('»، «') + '»)';
    }

    // P-07: append real operational contexts only (short, non-duplicative).
    var contexts = [];
    var sc = stockContext(winner.productId, winner);
    var vc = visitContext(cid, ctx);
    var fc = feedbackContext(winner) || _watchReasonContext(cid, winner, ctx) || _latestVisitFeedback(cid, winner, ctx);
    var pending = _pendingFollowUp(cid, winner, ctx);
    // Financial and critical follow-ups keep their original operational action.
    // A previously recorded follow-up is context, not a replacement for an
    // overdue cheque or overdue payment action.
    var protectedFromPendingOverride = [
      'CHECK_BOUNCED',
      'PAYMENT_OVERDUE'
    ].indexOf(winner.category) !== -1;
    var pendingOverride = pending && pending.generatedReason && !protectedFromPendingOverride;
    var actionType = pendingOverride ? 'follow_up' : rule.actionType;
    if (pendingOverride) actionText = 'پیگیری مورد ثبت‌شده برای این مشتری';
    if (sc) contexts.push(sc);
    if (vc) contexts.push(vc);
    if (fc) contexts.push(fc);
    if (pendingOverride) contexts.push('پیگیری ثبت‌شده: ' + pending.generatedReason);
    // Avoid repeating the same phrase already present in actionText
    for (var ci = 0; ci < contexts.length; ci++) {
      if (actionText.indexOf(contexts[ci]) === -1) {
        actionText = actionText + ' — ' + contexts[ci];
      }
    }

    // P-08: attach customer story if available (type/urgency unchanged)
    var story = null;
    if (priority.customerStory && priority.customerStory.summary) {
      story = priority.customerStory;
    } else if (typeof buildCustomerStory === 'function') {
      try {
        story = buildCustomerStory(cid, ctx);
      } catch (eSt) {
        story = null;
      }
    }

    return {
      customerId: cid,
      action: actionText,
      actionType: actionType,
      urgency: rule.urgency,
      reason: [winner.reason, fc, pendingOverride ? 'پیگیری ثبت‌شده: ' + pending.generatedReason : null].filter(Boolean).join(' — '),
      primarySignal: winner,
      priorityScore: priority.priorityScore,
      riskLevel: priority.riskLevel,
      customerStory: story
    };
  }

  const URGENCY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
  const URGENCY_SCORE = { critical: 40, high: 30, medium: 20, low: 10 };
  const PROSPECT_IMPACT = { 'A+': 30, 'A': 20, 'B': 10, 'C': 0, 'D': 0 };

  function calculateAllCustomerActions(ctx, skipMemo) {
    if (ctx && typeof ctx.memo === 'function' && !skipMemo) {
      return ctx.memo('allCustomerActions', 'all', function () {
        return calculateAllCustomerActions(ctx, true);
      });
    }
    if (typeof data === 'undefined' || !Array.isArray(data.customers)) return [];
    const economicRankMap = (typeof _buildEconomicRankMap === 'function') ? _buildEconomicRankMap(ctx) : null;
    const customers = data.customers.filter(function (c) { return c && c.active !== false; });
    const results = customers.map(function (c) {
      return calculateCustomerAction(c.id, null, { economicRankMap: economicRankMap, ctx: ctx });
    });
    results.sort(function (a, b) {
      const ua = URGENCY_RANK[a.urgency] || 0;
      const ub = URGENCY_RANK[b.urgency] || 0;
      if (ub !== ua) return ub - ua;
      return (b.priorityScore || 0) - (a.priorityScore || 0);
    });
    return results;
  }

  function _customerImpactMap(ctx, skipMemo) {
    if (ctx && typeof ctx.memo === 'function' && !skipMemo) {
      return ctx.memo('customerImpactMap', 'all', function () {
        return _customerImpactMap(ctx, true);
      });
    }
    const map = Object.create(null);
    if (typeof data === 'undefined' || !Array.isArray(data.customers)) return map;
    if (typeof customerTotals !== 'function') {
      data.customers.forEach(function (c) {
        if (c && c.id) map[c.id] = 15;
      });
      return map;
    }
    const rows = [];
    data.customers.forEach(function (c) {
      if (!c || c.active === false) return;
      let invTotal = null;
      try {
        const t = customerTotals(c.id, ctx);
        if (t && typeof t.invTotal === 'number' && isFinite(t.invTotal)) invTotal = t.invTotal;
      } catch (e) {}
      rows.push({ id: c.id, invTotal: invTotal });
    });
    const ranked = rows.filter(function (r) { return r.invTotal != null; })
      .sort(function (a, b) { return (b.invTotal || 0) - (a.invTotal || 0); });
    const n = ranked.length;
    ranked.forEach(function (r, i) {
      if (n === 0) { map[r.id] = 15; return; }
      const pct = (i + 1) / n;
      if (pct <= 0.2) map[r.id] = 30;
      else if (pct <= 0.8) map[r.id] = 20;
      else map[r.id] = 10;
    });
    rows.forEach(function (r) {
      if (map[r.id] == null) map[r.id] = 15;
    });
    return map;
  }

  function _customerTiming(cid, ctx) {
    const overdue = (typeof visitOverdueDays === 'function') ? visitOverdueDays(cid, ctx) : 0;
    if (overdue > 14) return 30;
    if (overdue > 7) return 25;
    return 10;
  }

  function _customerWhyNow(cid, ctx) {
    const overdue = (typeof visitOverdueDays === 'function') ? visitOverdueDays(cid, ctx) : 0;
    if (overdue > 0) return 'ویزیت ' + Math.round(overdue) + ' روز عقب‌افتاده';
    if (typeof customerBehavior === 'function') {
      try {
        const b = customerBehavior(cid, ctx);
        if (b && b.lastVisit && b.lastVisit.date && typeof daysAgo === 'function') {
          const d = daysAgo(b.lastVisit.date);
          if (d != null && isFinite(d) && d !== Infinity) {
            return d === 0 ? 'ویزیت امروز' : (Math.round(d) + ' روز از آخرین ویزیت');
          }
        }
      } catch (e) {}
    }
    return 'نیاز به پیگیری';
  }

  function _prospectTiming(days) {
    if (days == null || !isFinite(days)) return 10;
    if (days > 14) return 25;
    return 10;
  }

  function _buildProspectActions() {
    const out = [];
    if (typeof prospectState === 'undefined' || !Array.isArray(prospectState.shops)) return out;

    prospectState.shops.forEach(function (shop) {
      if (!shop || shop.status === 'converted') return;
      if (shop.status && shop.status !== 'active') return;

      const rank = shop.latestRank || 'D';
      const days = (typeof daysSinceLastEvaluation === 'function')
        ? daysSinceLastEvaluation(shop.id)
        : null;

      if (days != null && days <= 3) return;

      if (rank === 'C' || rank === 'D') {
        if (days == null || days <= 30) return;
      }

      const impact = PROSPECT_IMPACT[rank] != null ? PROSPECT_IMPACT[rank] : 0;
      const urgency = 'medium';
      const urgencyPts = URGENCY_SCORE[urgency] || 20;
      const timingPts = _prospectTiming(days);
      const unifiedScore = urgencyPts + impact + timingPts;
      const daysLabel = (days != null && isFinite(days)) ? Math.round(days) : '—';

      out.push({
        type: 'prospect',
        prospectId: shop.id,
        customerId: null,
        name: shop.name || '—',
        action: 'ارزیابی مجدد مغازه',
        actionType: 'prospect_followup',
        urgency: urgency,
        reason: 'رتبه ' + rank + (shop.latestScore != null ? (' — امتیاز ' + shop.latestScore) : ''),
        whyNow: daysLabel + ' روز از ارزیابی گذشته',
        priorityScore: impact,
        unifiedScore: unifiedScore,
        primarySignal: null,
        riskLevel: 'low',
      });
    });
    return out;
  }

  function calculateAllActions(ctx, skipMemo) {
    if (ctx && typeof ctx.memo === 'function' && !skipMemo) {
      return ctx.memo('allActions', 'all', function () {
        return calculateAllActions(ctx, true);
      });
    }
    const impactMap = _customerImpactMap(ctx);
    const economicRankMap = (typeof _buildEconomicRankMap === 'function') ? _buildEconomicRankMap(ctx) : null;
    const actions = [];

    if (typeof data !== 'undefined' && Array.isArray(data.customers)) {
      data.customers.forEach(function (c) {
        if (!c || c.active === false) return;
        const base = calculateCustomerAction(c.id, null, { economicRankMap: economicRankMap, ctx: ctx });
        if (!base || base.actionType === 'no_action') return;

        const urgencyPts = URGENCY_SCORE[base.urgency] || 10;
        const impactPts = impactMap[c.id] != null ? impactMap[c.id] : 15;
        const timingPts = _customerTiming(c.id, ctx);
        const unifiedScore = urgencyPts + impactPts + timingPts;
        const whyNow = _customerWhyNow(c.id, ctx);

        actions.push({
          type: 'customer',
          customerId: c.id,
          prospectId: null,
          name: c.name || '—',
          action: base.action,
          actionType: base.actionType,
          urgency: base.urgency,
          reason: base.reason,
          whyNow: whyNow,
          priorityScore: base.priorityScore || 0,
          unifiedScore: unifiedScore,
          primarySignal: base.primarySignal || null,
          riskLevel: base.riskLevel || 'low',
        });
      });
    }

    const prospectActions = _buildProspectActions();
    for (let i = 0; i < prospectActions.length; i++) actions.push(prospectActions[i]);

    actions.sort(function (a, b) {
      if (b.unifiedScore !== a.unifiedScore) return b.unifiedScore - a.unifiedScore;
      if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
      return String(a.name || '').localeCompare(String(b.name || ''), 'fa');
    });

    return actions;
  }

  global.calculateCustomerAction = calculateCustomerAction;
  global.calculateAllCustomerActions = calculateAllCustomerActions;
  global.calculateAllActions = calculateAllActions;

})(typeof window !== 'undefined' ? window : this);
