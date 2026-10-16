// money.js - prices, payments, receipts, expenses, reports and the sync page.
// Everything here reads and writes the copy kept ON THIS DEVICE (store.js), so it works offline.
import { S, route, ACT, ON, go, rerender, toast, formData, formErr, branchName, hasFeature } from './core.js'
import { esc, fmt, fmtDay, U, label, newId, newReceiptNo, vref, todayLocal, PAY_METHODS, EXP_CATS, backBtn } from './util.js'
import { getMoney, merged, orderTotal, orderPaid, isReversed, queueOp, setSettings, discardFailed, isOnline } from './store.js'

const view = () => merged(getMoney())
const opts = (list, sel) => list.map((x) => `<option ${x === sel ? 'selected' : ''}>${esc(x)}</option>`).join('')
const shopOpts = (sel, withAll) => (withAll ? `<option value="all" ${sel === 'all' ? 'selected' : ''}>All shops</option>` : '') + S.biz.branches.map((b) => `<option value="${esc(b.id)}" ${b.id === sel ? 'selected' : ''}>${esc(b.name)}</option>`).join('')
ACT.print = () => window.print()

// ================= Billing list =================
let billBr = null, billQ = ''
route('/app/billing', () => {
  const m = getMoney()
  if (!m.lastSync && !m.orders.length) {
    return `${backBtn('/app')}<div class="card mt"><h2>Prices, invoices &amp; receipts</h2><p class="muted">Your orders have not been downloaded to this device yet.</p>
      <button class="p" data-act="sync.now" ${isOnline() ? '' : 'disabled'}>${isOnline() ? 'Download my orders' : 'Connect to the internet first'}</button></div>`
  }
  if (!billBr) billBr = S.branchId
  return `${backBtn('/app')}<h2 class="mt">Prices, invoices &amp; receipts</h2>
    <p class="muted">Saved on this device first. New orders appear after the next sync${m.lastSync ? ` (last sync ${esc(fmt(m.lastSync))})` : ''}.</p>
    <div class="two"><input data-on="bill.q" data-ev="input" placeholder="Search order or name…" value="${esc(billQ)}"><select data-on="bill.br">${shopOpts(billBr, true)}</select></div><div id="bill-list"></div>`
}, { admin: true, after: drawBillList })
ON['bill.q'] = (el) => { billQ = el.value; drawBillList() }
ON['bill.br'] = (el) => { billBr = el.value; drawBillList() }
function drawBillList() {
  const el = document.getElementById('bill-list')
  if (!el) return
  const v = view(), t = billQ.trim().toLowerCase()
  const rows = v.orders.filter((o) => (billBr === 'all' || o.branch_id === billBr) && (!t || `${o.order_no} ${o.customer}`.toLowerCase().includes(t)))
  el.innerHTML = !rows.length ? '<div class="card muted mt">No orders found.</div>' : rows.map((o) => {
    const tot = orderTotal(o), bal = tot - orderPaid(o.id, v.payments)
    return `<a href="/app/billing/${esc(o.id)}" data-link class="card link mt"><div class="row"><b class="g1">${esc(o.order_no)} · ${esc(o.customer)}</b>
      <span class="badge ${tot && bal <= 0 ? 'gr' : 'am'}">${!tot ? 'No price yet' : bal <= 0 ? 'Cleared' : 'Owes ' + U(bal)}</span></div><div class="muted">${fmt(o.created_at)}</div></a>`
  }).join('')
}

// ================= One order: prices + money received =================
route('/app/billing/:orderId', ({ orderId }) => {
  const v = view(), o = v.orders.find((x) => x.id === orderId)
  if (!o) return '<div class="card"><p>This order is not on this device yet. Sync to download it.</p><a class="s" href="/app/billing" data-link>← Back</a></div>'
  const total = orderTotal(o), paid = orderPaid(o.id, v.payments), balance = total - paid
  const pays = v.payments.filter((p) => p.order_id === o.id).sort((a, b) => new Date(a.at) - new Date(b.at))
  return `<a href="/app/billing" data-link class="s">← All orders</a><h2 class="mt">${esc(o.order_no)} · ${esc(o.customer)}</h2>
  <div class="card"><b>1. Prices</b>
    ${o.garments.filter((g) => g.status !== 'cancelled').map((g) => `<div class="row it"><span class="g1">${g.qty} × ${esc(g.type)}<div class="muted">${esc(label(g.status))}</div></span>
      <input class="price" type="number" min="0" inputmode="numeric" placeholder="UGX each" value="${g.price ?? ''}" data-on="bill.price" data-g="${esc(g.id)}" data-type="${esc(g.type)}" data-o="${esc(o.id)}" data-cur="${g.price ?? ''}"></div>`).join('')}
    <div class="row mt"><b class="g1">Total ${U(total)}</b><a class="s" href="/app/receipt/${esc(o.id)}" data-link>View invoice</a></div>
    <p class="muted">Prices save on this device as you enter them. They upload at the next sync.</p></div>
  <form class="card" data-act="bill.pay" data-o="${esc(o.id)}"><b>2. Money received</b>
    <div class="two"><input name="amount" type="number" min="1" inputmode="numeric" placeholder="${balance > 0 ? 'Balance ' + balance : 'Amount UGX'}"><select name="method">${opts(PAY_METHODS)}</select></div>
    <input name="txn" class="mt" placeholder="Transaction ID (required except Cash / Other)" maxlength="80"><input name="comment" class="mt" placeholder="Comment (optional)" maxlength="300">
    <div class="note formerr" hidden></div><button class="g mt">Receive &amp; issue receipt</button>
    <p class="muted">Balance ${U(balance)}. This is your own record of money received. It is not verified with any mobile-money or card provider.</p>
    ${pays.map((p) => { const rev = isReversed(p, v.payments); return `<div class="row it"><span class="g1 ${rev ? 'dim' : ''}">${esc(p.receipt_no || 'Reversal')} · ${esc(p.method)} · ${fmt(p.at)}<br><b>${U(p.amount)}</b>${p.txn ? ' · Txn ' + esc(p.txn) : ''}${p.comment ? ' · ' + esc(p.comment) : ''}</span>
      ${p.pending ? '<span class="badge am">⏳</span>' : ''}${p.receipt_no ? `<a class="s" href="/app/receipt/${esc(o.id)}/${esc(p.id)}" data-link>Receipt</a>` : ''}
      ${p.amount > 0 && !rev ? `<button type="button" class="s" data-act="bill.reverse" data-p="${esc(p.id)}">Reverse</button>` : ''}</div>` }).join('')}</form>`
}, { admin: true })
ON['bill.price'] = (el) => {
  const raw = el.value.trim(), n = Math.round(Number(raw)), cur = el.dataset.cur === '' ? null : Number(el.dataset.cur)
  if (raw !== '' && Number.isFinite(n) && n >= 0 && n !== cur) {
    const o = view().orders.find((x) => x.id === el.dataset.o)
    queueOp({ type: 'price', garment_id: el.dataset.g, price: n, order_no: o ? o.order_no : '', gtype: el.dataset.type })
  }
  rerender()
}
ACT['bill.pay'] = (form) => {
  const f = formData(form), v = view(), o = v.orders.find((x) => x.id === form.dataset.o)
  if (!o) return
  const total = orderTotal(o), balance = total - orderPaid(o.id, v.payments)
  const amt = Math.round(Number(f.amount || balance))
  if (!total) return formErr('Enter the prices first.', form)
  if (!Number.isFinite(amt) || amt <= 0) return formErr('Enter a valid amount.', form)
  if (!['Cash', 'Other'].includes(f.method) && !f.txn.trim()) return formErr(`Enter the transaction ID for ${f.method}.`, form)
  if (amt > balance && !confirm(`${U(amt)} is more than the balance of ${U(balance)}. Record it anyway?`)) return
  const id = newId()
  queueOp({ type: 'payment', id, order_id: o.id, amount: amt, method: f.method, txn: f.txn.trim(), comment: f.comment.trim(), receipt_no: newReceiptNo(), by: S.who || '' })
  go(`/app/receipt/${o.id}/${id}`)
}
ACT['bill.reverse'] = (el) => {
  if (!confirm('Reverse this payment? A reversal entry is added; nothing is deleted.')) return
  queueOp({ type: 'reverse', payment_id: el.dataset.p, by: S.who || '' }); rerender()
}

// ================= Receipt / invoice (printable) =================
const receipt = ({ orderId, payId }) => {
  const v = view(), o = v.orders.find((x) => x.id === orderId), p = payId ? v.payments.find((x) => x.id === payId) : null
  if (!o || (payId && !p)) return '<div class="card"><p>Not found on this device. Sync to download it.</p><a class="s" href="/app/billing" data-link>← Back</a></div>'
  const biz = S.biz, total = orderTotal(o), upTo = p ? new Date(p.at).getTime() : Infinity
  const cum = p ? v.payments.filter((x) => x.order_id === o.id && (new Date(x.at).getTime() < upTo || x.id === p.id)).reduce((a, x) => a + x.amount, 0) : orderPaid(o.id, v.payments)
  const bal = total - cum
  const [stamp, tone] = p ? (isReversed(p, v.payments) ? ['REVERSED', 'rd'] : bal <= 0 ? ['PAID IN FULL', 'gr'] : ['PART PAYMENT', 'am']) : (!total ? ['NO PRICES YET', 'am'] : bal <= 0 ? ['PAID', 'gr'] : cum ? ['PARTLY PAID', 'am'] : ['UNPAID', 'am'])
  const contacts = [biz.phone, biz.email].filter(Boolean).join(' · ')
  return `<div class="noprint"><a href="/app/billing/${esc(o.id)}" data-link class="s">← Back</a></div>
  <div class="card doc mt"><div class="row"><div class="g1"><b class="big">${esc(biz.name)}</b><div class="muted">${esc(branchName(o.branch_id))}</div></div><b>${p ? 'RECEIPT' : 'INVOICE'}</b></div>
    <div class="mt"><span class="badge ${tone}">${stamp}</span></div>
    <div class="muted">${p ? esc(p.receipt_no) : 'INV-' + esc(o.order_no.replace(/\D/g, ''))} · ${fmt(p ? p.at : new Date())}<br>Customer: ${esc(o.customer)}<br>Order ${esc(o.order_no)} · received ${fmt(o.created_at)}</div>
    <div class="mt">${o.garments.filter((g) => g.status !== 'cancelled').map((g) => `<div class="row it"><span class="g1">${g.qty} × ${esc(g.type)} @ ${U(g.price || 0)}</span>${U((g.price || 0) * g.qty)}</div>`).join('')}</div>
    <div class="row it"><b class="g1">Total</b><b>${U(total)}</b></div>
    ${p ? `<div class="row"><span class="g1">Received (${esc(p.method)})</span><b>${U(p.amount)}</b></div>${p.txn ? `<div class="muted">Transaction ID: ${esc(p.txn)}</div>` : ''}${p.comment ? `<div class="muted">Note: ${esc(p.comment)}</div>` : ''}` : `<div class="row"><span class="g1">Paid so far</span>${U(cum)}</div>`}
    <div class="row"><b class="g1">Balance ${p ? 'after receipt' : 'due'}</b><b>${U(bal)}</b></div>
    ${p && bal <= 0 && !isReversed(p, v.payments) ? '<p class="muted">Balance cleared against this order.</p>' : ''}
    ${p && p.receipt_no ? `<p class="muted">Received by ${esc(p.by || '—')} · Verification ref <b>${esc(vref(p.receipt_no, p.amount, p.at))}</b>${p.pending ? ' · not yet synced' : ''}</p>` : ''}
    <p class="center"><b>Thank you for choosing ${esc(biz.name)}</b></p>
    <p class="muted center">${esc(contacts ? biz.name + ' · ' + contacts : biz.name)}<br>Powered by Smart Dobi</p></div>
  <div class="noprint mt"><button class="p" data-act="print">🖨️ Print / Save as PDF</button></div>`
}
route('/app/receipt/:orderId', receipt, { admin: true })
route('/app/receipt/:orderId/:payId', receipt, { admin: true })

// ================= Expenses =================
let expView = null
const notIncluded = (t) => `${backBtn('/app')}<div class="card mt"><h2>${t}</h2><p class="muted">This feature is not included in your plan. Ask the Smart Dobi team about upgrading.</p></div>`
route('/app/expenses', () => {
  if (!hasFeature('expenses')) return notIncluded('Expenses')
  if (!expView) expView = S.branchId
  const v = view(), list = v.expenses.filter((e) => expView === 'all' || e.branch_id === expView).sort((a, b) => b.spent_on.localeCompare(a.spent_on))
  const month = todayLocal().slice(0, 7), thisMonth = list.filter((e) => !e.void && e.spent_on.slice(0, 7) === month), by = {}
  thisMonth.forEach((e) => { by[e.category] = (by[e.category] || 0) + e.amount })
  return `${backBtn('/app')}<h2 class="mt">Expenses</h2>
  <form class="card" data-act="exp.save"><b>Record an expense</b>
    <div class="two"><div><label>Date</label><input name="date" type="date" value="${todayLocal()}" required></div><div><label>Amount (UGX)</label><input name="amount" type="number" min="1" inputmode="numeric" required></div></div>
    <div class="two"><div><label>Category</label><select name="category">${opts(EXP_CATS)}</select></div><div><label>Paid by</label><select name="method">${opts(PAY_METHODS)}</select></div></div>
    <label>Shop</label><select name="branch">${shopOpts(S.branchId, false)}</select>
    <label>Description</label><input name="desc" placeholder="e.g. 20 kg detergent" maxlength="300">
    <div class="note formerr" hidden></div><button class="g mt">Save expense</button><p class="muted">Saved on this device first and uploaded at the next sync.</p></form>
  <select data-on="exp.view">${shopOpts(expView, true)}</select>
  <div class="card mt"><b>This month</b>${thisMonth.length ? Object.entries(by).map(([c, a]) => `<div class="row it"><span class="g1">${esc(c)}</span>${U(a)}</div>`).join('') + `<div class="row it"><b class="g1">Total</b><b>${U(thisMonth.reduce((a, e) => a + e.amount, 0))}</b></div>` : '<p class="muted">No expenses recorded this month.</p>'}</div>
  <div class="card"><b>History</b>${list.length ? list.slice(0, 150).map((e) => `<div class="it row ${e.void ? 'dim' : ''}"><span class="g1"><b class="${e.void ? 'strike' : ''}">${U(e.amount)}</b> · ${esc(e.category)}
    <div class="muted">${esc(fmtDay(e.spent_on))} · ${esc(e.method)} · ${esc(branchName(e.branch_id))} · by ${esc(e.by)}${e.description ? ' · ' + esc(e.description) : ''}${e.void ? ' · VOIDED' : ''}</div></span>
    ${e.pending ? '<span class="badge am">⏳</span>' : ''}${e.void ? '' : `<button class="s" data-act="exp.void" data-id="${esc(e.id)}">Void</button>`}</div>`).join('') : '<p class="muted">Nothing recorded yet.</p>'}</div>`
}, { admin: true })
ON['exp.view'] = (el) => { expView = el.value; rerender() }
ACT['exp.save'] = (form) => {
  const f = formData(form), amt = Math.round(Number(f.amount))
  if (!Number.isFinite(amt) || amt <= 0) return formErr('Enter a valid amount.', form)
  if (!f.date) return formErr('Pick a date.', form)
  queueOp({ type: 'expense', id: newId(), branch_id: f.branch, spent_on: f.date, category: f.category, amount: amt, method: f.method, description: f.desc.trim(), by: S.who || '' })
  toast('Expense saved on this device.'); rerender()
}
ACT['exp.void'] = (el) => {
  if (!confirm('Void this expense? It stays in the history but is left out of totals.')) return
  queueOp({ type: 'void_expense', expense_id: el.dataset.id, by: S.who || '' }); rerender()
}

// ================= Reports =================
let repPer = '7', repBr = 'all'
const PERIODS = [['1', 'Last 24 hours'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['all', 'All time']]
route('/app/reports', () => {
  if (!hasFeature('reports')) return notIncluded('Reports')
  const m = getMoney(), v = view(), from = repPer === 'all' ? 0 : Date.now() - Number(repPer) * 864e5
  const inShop = (b) => repBr === 'all' || b === repBr
  const orders = v.orders.filter((o) => inShop(o.branch_id) && new Date(o.created_at).getTime() >= from)
  const shopOf = new Map(v.orders.map((o) => [o.id, o.branch_id]))
  const pays = v.payments.filter((p) => inShop(shopOf.get(p.order_id)) && new Date(p.at).getTime() >= from)
  const exps = v.expenses.filter((e) => !e.void && inShop(e.branch_id) && new Date(e.spent_on + 'T12:00:00').getTime() >= from)
  const sales = orders.reduce((a, o) => a + orderTotal(o), 0), collected = pays.reduce((a, p) => a + p.amount, 0)
  const outstanding = orders.reduce((a, o) => a + Math.max(0, orderTotal(o) - orderPaid(o.id, v.payments)), 0), spent = exps.reduce((a, e) => a + e.amount, 0)
  const tally = (rows, k, val) => { const r = {}; rows.forEach((x) => { r[k(x)] = (r[k(x)] || 0) + val(x) }); return Object.entries(r) }
  const R = (a, b) => `<div class="row it"><span class="g1">${esc(a)}</span><b>${esc(b)}</b></div>`
  const sec = (title, rows) => (rows.length ? `<b class="sec">${title}</b>${rows.map(([k, a]) => R(k, a)).join('')}` : '')
  const byStatus = tally(orders.flatMap((o) => o.garments).filter((g) => g.status !== 'cancelled'), (g) => label(g.status), () => 1)
  const empty = !orders.length && !exps.length
  return `<div class="noprint">${backBtn('/app')}</div><h2 class="mt">Reports</h2><div class="two noprint"><select data-on="rep.per">${PERIODS.map(([k, l]) => `<option value="${k}" ${repPer === k ? 'selected' : ''}>${l}</option>`).join('')}</select><select data-on="rep.br">${shopOpts(repBr, true)}</select></div>
  <div class="card doc mt"><b class="big">${esc(S.biz.name)}</b>
    <div class="muted">Report · ${esc(PERIODS.find(([k]) => k === repPer)[1])} · ${esc(repBr === 'all' ? 'All shops' : branchName(repBr))} · generated ${fmt(new Date())}</div>
    <div class="muted">Based on data on this device${m.lastSync ? ', last synced ' + esc(fmt(m.lastSync)) : ', not synced yet'}${m.queue.length ? ' · ' + m.queue.length + ' change(s) not yet uploaded' : ''}.</div>
    ${empty ? '<p class="muted">No orders or expenses in this period, so there is nothing to report.</p>' : `${R('Orders received', String(orders.length))}${R('Sales recorded (prices entered, not profit)', U(sales))}${R('Money collected in period', U(collected))}${R('Outstanding on these orders', U(outstanding))}${R('Expenses', U(spent))}
      <b class="sec">Estimated operating result</b>${R('Money collected − expenses', U(collected - spent))}${R('Sales recorded − expenses', U(sales - spent))}
      <p class="muted">Estimates only. They leave out unpaid work, stock on hand and any cost not recorded. Sales are not profit.</p>
      ${sec('Collected by method', tally(pays, (p) => p.method, (p) => p.amount).map(([k, a]) => [k, U(a)]))}${sec('Expenses by category', tally(exps, (e) => e.category, (e) => e.amount).map(([k, a]) => [k, U(a)]))}${sec('Garment status', byStatus.map(([k, a]) => [k, String(a)]))}`}
    <p class="muted center">Powered by Smart Dobi</p></div><div class="noprint mt"><button class="p" data-act="print">🖨️ Print / Save as PDF</button></div>`
}, { admin: true })
ON['rep.per'] = (el) => { repPer = el.value; rerender() }
ON['rep.br'] = (el) => { repBr = el.value; rerender() }

// ================= Sync & offline =================
const opText = (o) => {
  switch (o.type) {
    case 'price': return `Price ${U(o.price)} for ${o.gtype || 'item'} (${o.order_no || ''})`
    case 'payment': return `Payment ${U(o.amount)} · ${o.method} · ${o.receipt_no || ''}`
    case 'reverse': return 'Payment reversal'
    case 'expense': return `Expense ${U(o.amount)} · ${o.category}`
    case 'void_expense': return 'Void an expense'
    default: return String(o.action || o.type)
  }
}
route('/app/sync', () => {
  const m = getMoney(), st = m.settings
  return `${backBtn('/app')}<h2 class="mt">Sync &amp; offline</h2>
  <div class="card"><b>${m.online !== false && isOnline() ? '🟢 Online' : '🔴 Offline'}</b>
    <p class="muted">Money entries (prices, payments, receipts, expenses) are saved on this device first and sent to the server only when you sync. You can keep working with no internet and print receipts and reports. Last sync: ${m.lastSync ? esc(fmt(m.lastSync)) : 'never'}.</p>
    <button class="p" data-act="sync.now" ${isOnline() && !m.syncing ? '' : 'disabled'}>${m.syncing ? 'Syncing…' : 'Sync now'}</button></div>
  <div class="card"><b>Automatic sync</b><label>When should this device sync by itself?</label>
    <select data-on="sync.mode"><option value="manual" ${st.mode === 'manual' ? 'selected' : ''}>Only when I tap Sync now</option><option value="interval" ${st.mode === 'interval' ? 'selected' : ''}>Every few minutes or hours</option><option value="daily" ${st.mode === 'daily' ? 'selected' : ''}>Once a day at a set time</option></select>
    ${st.mode === 'interval' ? `<select class="mt" data-on="sync.min">${[[15, 'Every 15 minutes'], [30, 'Every 30 minutes'], [60, 'Every hour'], [120, 'Every 2 hours'], [240, 'Every 4 hours']].map(([n, l]) => `<option value="${n}" ${st.minutes === n ? 'selected' : ''}>${l}</option>`).join('')}</select>` : ''}
    ${st.mode === 'daily' ? `<input class="mt" type="time" value="${esc(st.time)}" data-on="sync.time">` : ''}
    <p class="muted">Automatic sync only runs while Smart Dobi is open on this device and online. If you close the app, tap Sync now next time.</p></div>
  <div class="card"><b>Waiting to upload (${m.queue.length})</b>${m.queue.length ? m.queue.map((o) => `<div class="it">⏳ ${esc(opText(o))}<div class="muted">${fmt(o.at)}</div></div>`).join('') : '<p class="muted">Nothing waiting. Everything is on the server.</p>'}</div>
  ${m.failed.length ? `<div class="card"><b>Needs attention (${m.failed.length})</b><p class="muted">The server refused these. Check the reason, fix it if needed, or discard.</p>${m.failed.map((o) => `<div class="it row"><span class="g1">${esc(opText(o))}<div class="muted bad">${esc(o.error)}</div></span><button class="s" data-act="sync.discard" data-id="${esc(o.id)}">Discard</button></div>`).join('')}</div>` : ''}`
})
ON['sync.mode'] = (el) => { setSettings({ mode: el.value }); rerender() }
ON['sync.min'] = (el) => { setSettings({ minutes: Number(el.value) }); rerender() }
ON['sync.time'] = (el) => { if (/^\d\d:\d\d$/.test(el.value)) setSettings({ time: el.value }) }
ACT['sync.discard'] = (el) => { discardFailed(el.dataset.id); rerender() }
