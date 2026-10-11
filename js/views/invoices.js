/* js/views/invoices.js — SPA Invoices view.
   Presentation redesign only. Financial calculations and invoice actions remain
   delegated to the existing helpers and invoice detail/new-invoice flows.
*/
'use strict';

(function (global) {
  let invQuery = '';
  let invFilter = 'all'; // all | paid | debt
  let invSort = 'newest'; // newest | oldest | amountDesc | amountAsc

  let searchHandler = null;
  let chipHandlers = [];
  let sortHandler = null;
  let fabHandler = null;
  let newActionHandler = null;

  function faCount(n) {
    return Number(n || 0).toLocaleString('fa-IR');
  }

  function navigateToCustomer(cid) {
    AppRouter.navigate('/customer', { id: cid });
  }

  function invoicePaidAmount(inv) {
    return typeof invoiceEffectivePaid === 'function' ? invoiceEffectivePaid(inv) : invoiceOnRecordPaid(inv);
  }
  function invoiceRemain(inv) {
    return typeof invoiceEffectiveRemain === 'function' ? invoiceEffectiveRemain(inv) : Math.max(0, (inv.total || 0) - invoicePaidAmount(inv));
  }
  function invoicePayStatus(inv) {
    const paid = invoicePaidAmount(inv);
    const total = inv.total || 0;
    if (total <= 0) return { key: 'paid', label: '—', cls: '' };
    if (paid <= 0) return { key: 'debt', label: 'پرداخت‌نشده', cls: 'accent-rust' };
    if (paid + 0.5 >= total) return { key: 'paid', label: 'تسویه‌شده', cls: 'accent-olive' };
    return { key: 'debt', label: 'پرداخت جزئی', cls: 'accent-amber' };
  }

  function invoiceSummaryHtml(allRows) {
    const total = allRows.reduce((sum, inv) => sum + (inv.total || 0), 0);
    const paid = allRows.reduce((sum, inv) => sum + invoicePaidAmount(inv), 0);
    const remain = allRows.reduce((sum, inv) => sum + invoiceRemain(inv), 0);
    const settled = allRows.filter(inv => invoicePayStatus(inv).key === 'paid').length;
    return `
      <section class="invoice-overview" aria-label="خلاصه فاکتورها">
        <div class="invoice-overview-head">
          <div>
            <span class="invoice-overview-kicker">نمای کلی</span>
            <strong>وضعیت فاکتورها</strong>
          </div>
          <span class="invoice-overview-count">${faCount(allRows.length)} فاکتور</span>
        </div>
        <div class="invoice-overview-grid">
          <div class="invoice-overview-stat is-primary"><span>جمع فاکتورها</span><strong>${toman(total)} <small>ت</small></strong></div>
          <div class="invoice-overview-stat"><span>مانده دریافت</span><strong class="is-debt">${toman(remain)} <small>ت</small></strong></div>
          <div class="invoice-overview-stat"><span>پرداخت‌شده</span><strong>${faCount(settled)} <small>مورد</small></strong></div>
        </div>
        <div class="invoice-overview-foot"><span>دریافت‌شده تا امروز</span><strong>${toman(paid)} تومان</strong></div>
      </section>`;
  }

  function invoiceDateGroup(inv) {
    return inv && inv.date ? faDate(inv.date) : 'بدون تاریخ';
  }

  function invoiceRowHtml(item) {
    const { inv, st, paid, remain, custName } = item;
    const statusClass = st.key === 'paid' ? 'is-paid' : 'is-debt';
    const paymentDetail = remain > 0.5
      ? `<span class="invoice-row-balance is-debt">مانده ${toman(remain)} ت</span>`
      : `<span class="invoice-row-balance is-paid">تسویه‌شده</span>`;
    const paidDetail = paid > 0 && remain > 0.5
      ? `<span class="invoice-row-paid">${toman(paid)} ت دریافت‌شده</span>`
      : '';
    return `
      <a class="invoice-card" href="#/invoice?id=${encodeURIComponent(inv.id)}" aria-label="فاکتور ${esc(String(inv.number || ''))} برای ${esc(custName)}">
        <span class="invoice-card-main">
          <span class="invoice-card-title"><strong>#${esc(String(inv.number || ''))}</strong><span class="invoice-card-dot">·</span><span>${esc(custName)}</span></span>
          <span class="invoice-card-meta"><span>${faDate(inv.date)}</span><span class="invoice-status ${statusClass}">${st.label}</span></span>
          ${paidDetail ? `<span class="invoice-card-paid">${paidDetail}</span>` : ''}
        </span>
        <span class="invoice-card-financial">
          <span class="invoice-card-total-label">جمع فاکتور</span>
          <strong>${toman(inv.total)} <small>ت</small></strong>
          ${paymentDetail}
        </span>
        <span class="invoice-card-chevron" aria-hidden="true">‹</span>
      </a>`;
  }

  function renderInvoiceListOnly() {
    const listEl = document.getElementById('invoice-list');
    if (!listEl) return;

    let rows = (data.invoices || []).slice();
    const q = (invQuery || '').trim().toLowerCase();
    if (q) {
      rows = rows.filter(inv => {
        const cust = data.customers.find(c => c.id === inv.customerId);
        const name = (cust && cust.name) || '';
        return String(inv.number || '').toLowerCase().includes(q) || name.toLowerCase().includes(q);
      });
    }

    rows = rows.map(inv => {
      const st = invoicePayStatus(inv);
      const paid = invoicePaidAmount(inv);
      const remain = invoiceRemain(inv);
      const cust = data.customers.find(c => c.id === inv.customerId);
      return { inv, st, paid, remain, custName: cust ? cust.name : '—' };
    });

    if (invFilter === 'paid') rows = rows.filter(x => x.st.key === 'paid');
    else if (invFilter === 'debt') rows = rows.filter(x => x.st.key === 'debt');

    if (invSort === 'oldest') rows.sort((a, b) => (a.inv.date || '').localeCompare(b.inv.date || '') || String(a.inv.number).localeCompare(String(b.inv.number)));
    else if (invSort === 'amountDesc') rows.sort((a, b) => (b.inv.total || 0) - (a.inv.total || 0));
    else if (invSort === 'amountAsc') rows.sort((a, b) => (a.inv.total || 0) - (b.inv.total || 0));
    else rows.sort((a, b) => (b.inv.date || '').localeCompare(a.inv.date || '') || String(b.inv.number).localeCompare(String(a.inv.number)));

    const countEl = document.getElementById('invoice-count');
    if (countEl) countEl.textContent = rows.length ? `${faCount(rows.length)} نتیجه` : '';

    if (!rows.length) {
      listEl.innerHTML = `<div class="invoice-empty"><span class="invoice-empty-icon">⌁</span><strong>${(data.invoices || []).length ? 'فاکتوری با این مشخصات پیدا نشد' : 'هنوز فاکتوری ثبت نشده'}</strong><span>${(data.invoices || []).length ? 'جست‌وجو یا فیلتر را تغییر دهید.' : 'از دکمه «فاکتور جدید» شروع کنید.'}</span></div>`;
      return;
    }

    let lastGroup = null;
    listEl.innerHTML = rows.map(item => {
      const group = invoiceDateGroup(item.inv);
      const head = group !== lastGroup ? `<div class="invoice-group-label">${esc(group)}</div>` : '';
      lastGroup = group;
      return head + invoiceRowHtml(item);
    }).join('');
  }

  function openNewInvoicePicker() {
    if (!data.customers.length) {
      openSheet(`<h3>مشتری ندارید</h3><div class="empty">اول از بخش مشتریان، یک مشتری ثبت کنید.</div><div class="btn-row"><a class="btn secondary" href="#/customers">رفتن به مشتریان</a></div>`);
      return;
    }
    const opts = data.customers.filter(c => c.active !== false).slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fa'))
      .map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    openSheet(`<h3>فاکتور جدید</h3><div class="field"><label for="inv-pick-customer">مشتری</label><select id="inv-pick-customer">${opts}</select></div><div class="btn-row"><button class="btn" id="inv-pick-go">ادامه</button></div>`);
    document.getElementById('inv-pick-go').onclick = () => {
      const cid = document.getElementById('inv-pick-customer').value;
      closeModal();
      if (typeof openAddInvoice === 'function') openAddInvoice(cid);
    };
  }

  function drawInvoicesPage(root) {
    root.innerHTML = `
      <div class="invoice-workspace">
        <div class="invoice-page-head">
          <div><span class="invoice-page-kicker">عملیات فروش</span><h2>فاکتورها</h2><p>مرور سریع فروش، دریافت و مانده مشتریان</p></div>
          <button type="button" class="invoice-new-action" id="invoice-new-action"><span aria-hidden="true">＋</span> فاکتور جدید</button>
        </div>
        <div id="invoice-overview-wrap"></div>
        <section class="invoice-tools" aria-label="جست‌وجو و فیلتر فاکتورها">
          <div class="invoice-search-wrap"><span class="invoice-search-icon" aria-hidden="true"></span><label class="sr-only" for="invoice-search">جستجوی فاکتور</label><input id="invoice-search" placeholder="جستجوی شماره یا نام مشتری" value="${esc(invQuery)}" autocomplete="off"></div>
          <div class="invoice-filter-row" id="invoice-chips">
            <span class="invoice-filter-label">نمایش</span>
            <div class="invoice-filter-seg">
              ${['all', 'paid', 'debt'].map(id => `<button type="button" class="chip ${invFilter === id ? 'active' : ''}" data-if="${id}">${id === 'all' ? 'همه' : id === 'paid' ? 'تسویه‌شده' : 'بدهکار'}</button>`).join('')}
            </div>
          </div>
          <div class="invoice-sort-row"><span id="invoice-count" class="invoice-result-count" aria-live="polite"></span><label for="invoice-sort">مرتب‌سازی</label><select id="invoice-sort"><option value="newest" ${invSort === 'newest' ? 'selected' : ''}>جدیدترین</option><option value="oldest" ${invSort === 'oldest' ? 'selected' : ''}>قدیمی‌ترین</option><option value="amountDesc" ${invSort === 'amountDesc' ? 'selected' : ''}>بیشترین مبلغ</option><option value="amountAsc" ${invSort === 'amountAsc' ? 'selected' : ''}>کمترین مبلغ</option></select></div>
        </section>
        <div id="invoice-list" class="invoice-list"></div>
      </div>`;

    const newAction = document.getElementById('invoice-new-action');
    newActionHandler = () => openNewInvoicePicker();
    if (newAction) newAction.addEventListener('click', newActionHandler);

    const searchEl = document.getElementById('invoice-search');
    searchHandler = e => { invQuery = e.target.value; renderInvoiceListOnly(); };
    searchEl.addEventListener('input', searchHandler);

    chipHandlers = [];
    document.querySelectorAll('#invoice-chips [data-if]').forEach(btn => {
      const fn = () => {
        invFilter = btn.getAttribute('data-if');
        document.querySelectorAll('#invoice-chips [data-if]').forEach(b => b.classList.toggle('active', b.getAttribute('data-if') === invFilter));
        renderInvoiceListOnly();
      };
      btn.addEventListener('click', fn);
      chipHandlers.push({ el: btn, fn });
    });

    const sortEl = document.getElementById('invoice-sort');
    sortHandler = e => { invSort = e.target.value; renderInvoiceListOnly(); };
    sortEl.addEventListener('change', sortHandler);

    const fab = document.getElementById('fab');
    if (fab) { fab.style.display = 'none'; fabHandler = null; }
    const nav = document.getElementById('nav');
    if (nav) nav.style.display = '';

    const overview = document.getElementById('invoice-overview-wrap');
    if (overview) overview.innerHTML = invoiceSummaryHtml(data.invoices || []);
    renderInvoiceListOnly();
  }

  function mount(root) {
    let refreshToken = null;
    if (!root) return function () {};
    invQuery = '';
    invFilter = 'all';
    invSort = 'newest';
    drawInvoicesPage(root);
    refreshToken = ViewHost.setRefresh(() => {
      const overview = document.getElementById('invoice-overview-wrap');
      if (overview) overview.innerHTML = invoiceSummaryHtml(data.invoices || []);
      renderInvoiceListOnly();
    });

    return function unmount() {
      ViewHost.clearRefresh(refreshToken);
      refreshToken = null;
      const search = document.getElementById('invoice-search');
      if (search && searchHandler) search.removeEventListener('input', searchHandler);
      if (newActionHandler) {
        const button = document.getElementById('invoice-new-action');
        if (button) button.removeEventListener('click', newActionHandler);
      }
      chipHandlers.forEach(h => { try { h.el.removeEventListener('click', h.fn); } catch (e) {} });
      const sort = document.getElementById('invoice-sort');
      if (sort && sortHandler) sort.removeEventListener('change', sortHandler);
      searchHandler = null; newActionHandler = null; chipHandlers = []; sortHandler = null;
      const fab = document.getElementById('fab');
      if (fab) { fab.style.display = 'none'; fab.onclick = null; }
      root.innerHTML = '';
    };
  }

  global.InvoicesView = { mount, unmount: function () {} };
})(typeof window !== 'undefined' ? window : this);
