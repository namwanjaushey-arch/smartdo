// shop.js - the shop floor: overview, receive clothes, orders, pickup, requests, staff, audit, public profile.
import { rpc, select, insert, update, uploadPhoto, photoUrl, removePhotos } from './api.js'
import { S, route, ACT, ON, go, rerender, loadBiz, toast, formData, formErr, busy, branchName, hasFeature } from './core.js'
import { esc, enc, one, fmt, badge, label, STATUS, PICK, CAT, SERVICES, AREAS, PIN_RE, intlPhone, randomToken, compressImage, U, backBtn } from './util.js'
import { isOnline } from './store.js'

const openUrl = (u) => { if (u.startsWith('http')) window.open(u, '_blank', 'noopener'); else window.location.href = u }
const logEvent = (action, detail) => rpc('log_event', { p_business: S.biz.id, p_branch: S.branchId, p_who: S.who || '', p_action: action, p_detail: detail || {} }).catch(() => undefined)
const thumb = (path) => (path ? `<img class="ph" src="${esc(photoUrl(path))}" alt="">` : '<div class="ph">👕</div>')
let flash = null

// ================= Overview =================
route('/app', async () => {
  const rows = await select('orders', `select=id,created_at,garments(status)&branch_id=eq.${enc(S.branchId)}`)
  if (!rows.length) return `<div class="card"><h2>Welcome</h2><p class="muted">No orders yet. Nothing here is sample data.</p><a class="p" href="/app/receive" data-link>Receive Clothes</a></div>`
  const g = rows.flatMap((o) => o.garments)
  const today = rows.filter((o) => new Date(o.created_at).toDateString() === new Date().toDateString()).length
  const tiles = [['Orders today', today], ['Garments in shop', g.filter((x) => !['returned', 'cancelled'].includes(x.status)).length],
    ['Being processed', g.filter((x) => !['ready', 'returned', 'cancelled'].includes(x.status)).length], ['Ready for pickup', g.filter((x) => x.status === 'ready').length]]
  return `<div class="grid">${tiles.map(([l, n]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join('')}</div>`
})

// ================= Receive Clothes =================
const fresh = () => ({ name: '', phone: '', email: '', items: [], q: '', cat: 'All', cur: null, reqId: null, reqNote: '' })
let draft = fresh()
const pickList = () => {
  const t = draft.q.trim().toLowerCase()
  const all = Object.entries(CAT).filter(([c]) => draft.cat === 'All' || c === draft.cat).flatMap(([, a]) => a)
  return (t ? all.filter((x) => x.toLowerCase().includes(t)) : all).slice(0, t ? 30 : 18)
}
route('/app/receive', () => `
  ${isOnline() ? '' : '<div class="note">You are offline. Receiving clothes needs internet (order numbers, photos and tracking links come from the server). Money entries still work offline.</div>'}
  ${draft.reqId ? `<div class="note">📦 From customer request: ${esc(draft.reqNote || 'call-back')} <button class="s" data-act="recv.dropreq">✕</button></div>` : ''}
  <div class="card"><h2>Receive Clothes</h2>
    <div class="two"><div><label>Customer name</label><input data-on="recv.field" data-ev="input" data-k="name" value="${esc(draft.name)}" maxlength="80"></div>
    <div><label>Phone</label><input data-on="recv.field" data-ev="input" data-k="phone" inputmode="tel" value="${esc(draft.phone)}" placeholder="07XX XXX XXX" maxlength="20"></div></div>
    <label>Email (optional)</label><input data-on="recv.field" data-ev="input" data-k="email" type="email" value="${esc(draft.email)}" maxlength="80"></div>
  <div class="card"><h2>Add garment</h2>
    <input data-on="recv.q" data-ev="input" placeholder="Search garment type…" value="${esc(draft.q)}">
    <div class="chips" id="recv-cats"></div><div class="chips" id="recv-pick"></div><div id="recv-cur"></div></div>
  <div class="card"><h2 id="recv-count"></h2><div id="recv-items"></div></div>
  <div class="note formerr" hidden></div>
  <button class="p" id="recv-save" data-act="recv.save">Save order</button>`, { after: receiveAfter })
ON['recv.field'] = (el) => { draft[el.dataset.k] = el.value }
ON['recv.q'] = (el) => { draft.q = el.value; drawPick() }
ON['recv.cur'] = (el) => { const c = draft.cur; if (c) c[el.dataset.k] = el.dataset.k === 'qty' ? Math.max(1, Math.floor(Number(el.value) || 1)) : el.value }
ON['recv.photo'] = (el) => {
  const f = el.files && el.files[0]
  if (!f || !draft.cur) return
  if (!f.type.startsWith('image/')) return toast('Please choose a photo.', true)
  if (f.size > 15 * 1024 * 1024) return toast('That photo is too large (maximum 15 MB).', true)
  if (draft.cur.preview) URL.revokeObjectURL(draft.cur.preview)
  draft.cur.file = f; draft.cur.preview = URL.createObjectURL(f); drawCur()
}
ACT['recv.cat'] = (el) => { draft.cat = el.dataset.v; drawCats(); drawPick() }
ACT['recv.type'] = (el) => { draft.cur = { type: el.dataset.v, qty: 1, color: '', desc: '', file: null, preview: '' }; drawCur() }
ACT['recv.add'] = () => {
  if (!draft.cur) return
  draft.items.push({ ...draft.cur }); draft.cur = null; draft.q = ''
  const q = document.querySelector('[data-on="recv.q"]'); if (q) q.value = ''
  drawPick(); drawCur(); drawItems()
}
ACT['recv.copy'] = (el) => { const i = Number(el.dataset.i); draft.items.splice(i + 1, 0, { ...draft.items[i] }); drawItems() }
ACT['recv.remove'] = (el) => { draft.items.splice(Number(el.dataset.i), 1); drawItems() }
ACT['recv.dropreq'] = () => { draft.reqId = null; draft.reqNote = ''; rerender() }
const setHtml = (id, html) => { const e = document.getElementById(id); if (e) e.innerHTML = html }
function drawCats() { setHtml('recv-cats', ['All', ...Object.keys(CAT)].map((c) => `<span class="chip ${draft.cat === c ? 'on' : ''}" data-act="recv.cat" data-v="${esc(c)}">${esc(c)}</span>`).join('')) }
function drawPick() {
  const list = pickList(), t = draft.q.trim()
  setHtml('recv-pick', list.map((x) => `<span class="chip" data-act="recv.type" data-v="${esc(x)}">${esc(x)}</span>`).join('') +
    (t && !list.some((x) => x.toLowerCase() === t.toLowerCase()) ? `<span class="chip on" data-act="recv.type" data-v="${esc(t)}">+ Use “${esc(t)}”</span>` : ''))
}
function drawCur() {
  const c = draft.cur
  setHtml('recv-cur', !c ? '' : `<div class="draft"><b>${esc(c.type)}</b>
    <div class="two"><div><label>Quantity</label><input type="number" min="1" data-on="recv.cur" data-ev="input" data-k="qty" value="${c.qty}"></div>
    <div><label>Colour</label><input data-on="recv.cur" data-ev="input" data-k="color" value="${esc(c.color)}" maxlength="60"></div></div>
    <label>Distinctive description / damage</label><textarea rows="2" data-on="recv.cur" data-ev="input" data-k="desc" maxlength="300" placeholder="e.g. small tear near left pocket">${esc(c.desc)}</textarea>
    <label>Photo (camera or upload)</label><input type="file" accept="image/*" capture="environment" data-on="recv.photo">
    ${c.preview ? `<img class="ph big" src="${esc(c.preview)}" alt="">` : ''}
    <div class="mt"><button class="g" data-act="recv.add">Add item</button></div></div>`)
}
function drawItems() {
  setHtml('recv-count', `Items (${draft.items.length})`)
  setHtml('recv-items', draft.items.length ? draft.items.map((g, i) => `<div class="it row">${g.preview ? `<img class="ph" src="${esc(g.preview)}" alt="">` : '<div class="ph">👕</div>'}
    <div class="g1"><b>${g.qty} × ${esc(g.type)}</b><div class="muted">${esc([g.color, g.desc].filter(Boolean).join(' · '))}</div></div>
    <button class="s" data-act="recv.copy" data-i="${i}">Copy</button><button class="s" data-act="recv.remove" data-i="${i}">✕</button></div>`).join('') : '<p class="muted">No garments added yet.</p>')
}
ACT['recv.save'] = async (btn) => {
  formErr('')
  if (draft.name.trim().length < 2) return formErr('Enter the customer name.')
  if (!draft.items.length) return formErr('Add at least one garment.')
  if (!isOnline()) return formErr('You are offline. Connect to the internet to save an order.')
  btn.disabled = true; btn.textContent = 'Saving order…'
  let res
  try {
    res = await rpc('create_order', { p_branch: S.branchId, p_name: draft.name, p_phone: draft.phone, p_email: draft.email, p_who: S.who || '', p_token: randomToken(),
      p_garments: draft.items.map((i) => ({ type: i.type, qty: i.qty, color: i.color, description: i.desc })) })
  } catch (e) { btn.disabled = false; btn.textContent = 'Save order'; return formErr(e.message) }
  let failed = 0
  for (let i = 0; i < draft.items.length; i++) {
    const it = draft.items[i]
    if (!it.file) continue
    btn.textContent = `Uploading photo ${i + 1} of ${draft.items.length}…`
    try {
      const path = `${S.biz.id}/${res.order_id}/${res.garment_ids[i]}.jpg`
      await uploadPhoto(path, await compressImage(it.file))
      await update('garments', `id=eq.${enc(res.garment_ids[i])}`, { photo_path: path })
    } catch { failed++ }
  }
  if (draft.reqId) await update('requests', `id=eq.${enc(draft.reqId)}`, { status: 'converted', order_id: res.order_id }).catch(() => undefined)
  draft = fresh(); flash = { failed }
  go(`/app/orders/${res.order_id}`)
}
// runs after the Receive page is placed on screen
function receiveAfter() { drawCats(); drawPick(); drawCur(); drawItems() }

// ================= Orders list =================
let ordRows = [], ordF = 'all', ordQ = ''
const FILTERS = [['all', 'All'], ['new', 'New'], ['prog', 'In progress'], ['ready', 'Ready for collection'], ['rework', 'Pending'], ['pickup', 'Pickup orders'], ['closed', 'Closed']]
const live = (r) => r.garments.filter((g) => g.status !== 'cancelled')
const overdue = (r) => !r.closed_at && Date.now() - new Date(r.created_at).getTime() > 48 * 36e5 && live(r).some((g) => !['ready', 'returned'].includes(g.status))
route('/app/orders', async () => {
  ordRows = await select('orders', `select=id,order_no,created_at,closed_at,source,customers(name,phone),garments(id,status,qty)&branch_id=eq.${enc(S.branchId)}&order=created_at.desc&limit=200`)
  return `<input data-on="ord.q" data-ev="input" placeholder="Search order number, name or phone…" value="${esc(ordQ)}">
    <div class="chips" id="ord-chips"></div><div id="ord-list"></div>`
}, { after: () => { drawOrderChips(); drawOrders() } })
ON['ord.q'] = (el) => { ordQ = el.value; drawOrders() }
ACT['ord.filter'] = (el) => { ordF = el.dataset.v; drawOrderChips(); drawOrders() }
function drawOrderChips() { setHtml('ord-chips', FILTERS.map(([k, l]) => `<span class="chip ${ordF === k ? 'on' : ''}" data-act="ord.filter" data-v="${k}">${l}</span>`).join('')) }
function drawOrders() {
  const t = ordQ.trim().toLowerCase()
  const shown = ordRows.filter((r) => {
    const a = live(r), c = one(r.customers) || {}
    if (t && !`${r.order_no} ${c.name || ''} ${c.phone || ''}`.toLowerCase().includes(t)) return false
    if (ordF === 'new') return !r.closed_at && a.every((g) => g.status === 'received')
    if (ordF === 'prog') return !r.closed_at && a.some((g) => !['ready', 'returned'].includes(g.status))
    if (ordF === 'ready') return !r.closed_at && a.some((g) => g.status === 'ready')
    if (ordF === 'rework') return !r.closed_at && a.some((g) => g.status === 'rework')
    if (ordF === 'pickup') return r.source === 'pickup'
    if (ordF === 'closed') return !!r.closed_at
    return true
  })
  setHtml('ord-list', !shown.length ? `<div class="card muted">${ordRows.length ? 'No orders match this filter.' : 'No orders yet. Tap Receive to add the first one.'}</div>` : shown.map((r) => {
    const a = live(r), c = one(r.customers) || {}, ready = a.filter((g) => g.status === 'ready').length, back = a.filter((g) => g.status === 'returned').length
    return `<a href="/app/orders/${esc(r.id)}" data-link class="card link"><div class="row"><b class="g1">${esc(r.order_no)} · ${esc(c.name || 'Customer')}</b>${r.source === 'pickup' ? '<span class="badge pu">🧺 Pickup order</span>' : ''}${r.closed_at ? '<span class="badge pu">Closed</span>' : ''}${overdue(r) ? '<span class="badge rd">Overdue</span>' : ''}</div>
      <div class="muted">${fmt(r.created_at)}</div><div class="mt">${back ? `${back} of ${a.length} returned` : `${ready} of ${a.length} garments ready for collection`}</div></a>`
  }).join(''))
}

// ================= One order: details, status, and hand-over to the customer =================
let curOrder = null, clearing = null
const SEL = 'id,order_no,created_at,closed_at,cleared_reason,source,tracking_token,customers(name,phone,email),garments(id,type,qty,color,description,status,photo_path,rework_reason)'
const trackLink = (t) => `${location.origin}/track/${t}`
route('/app/orders/:id', async ({ id }) => {
  const rows = await select('orders', `select=${SEL}&id=eq.${enc(id)}&limit=1`)
  const o = rows[0]
  if (!o) return `${backBtn('/app/orders')}<div class="card mt"><p>Order not found.</p></div>`
  curOrder = o
  o.garments.sort((a, b) => a.id.localeCompare(b.id))
  const c = one(o.customers) || {}, alive = o.garments.filter((g) => g.status !== 'cancelled')
  const ready = alive.filter((g) => g.status === 'ready'), rw = alive.filter((g) => g.status === 'rework')
  const banner = flash ? `<div class="ok">✅ Order ${esc(o.order_no)} saved.${flash.failed ? ` ${flash.failed} photo(s) could not upload.` : ''} Now send the customer their tracking link below.</div>` : ''
  flash = null
  const opts = (sel) => PICK.map((k) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(label(k))}</option>`).join('')
  const handover = o.closed_at || !(ready.length || rw.length) ? '' : `<div class="card"><b>Hand-over to the customer</b>
    <p class="muted">Tick what the customer accepted. Unticked items stay on this order, and the customer link stays active until everything is collected or the owner clears the order.</p>
    ${ready.map((g) => `<label class="it row pick"><input type="checkbox" data-on="pick.tick" data-g="${esc(g.id)}">${thumb(g.photo_path)}<span class="g1">${g.qty} × ${esc(g.type)}<br><span class="muted">${esc(g.color)}</span></span></label>`).join('')}
    ${rw.map((g) => `<div class="it row"><div class="ph">🔁</div><span class="g1">${g.qty} × ${esc(g.type)}<br><span class="muted">Needs rework — ${esc(g.rework_reason)}</span></span></div>`).join('')}
    ${ready.length ? `<input data-why class="mt" placeholder="Reason if not accepted (e.g. stain still there)" maxlength="200">
      <div class="two mt"><button class="g" data-act="pick.accept">✔ Accepted</button><button class="s" data-act="pick.reject">✖ Not accepted</button></div>
      <button class="s block" data-act="pick.all">Accept all ready</button>` : ''}
    <button class="s block" data-act="pick.clearopen">Owner: record &amp; clear order</button>
    ${clearing === o.id ? `<form class="draft" data-act="pick.clear"><p class="muted">Closes the order and records what was left. The customer link expires 24 hours later.</p>
      <input name="pin" type="password" inputmode="numeric" maxlength="5" required placeholder="Admin PIN" autocomplete="off"><textarea name="reason" class="mt" rows="2" required maxlength="300" placeholder="Reason / what was left"></textarea>
      <div class="note formerr" hidden></div><div class="two mt"><button type="button" class="s" data-act="pick.clearcancel">Cancel</button><button class="p">Clear order</button></div></form>` : ''}</div>`
  return `${backBtn('/app/orders')}${banner}
  <div class="card mt"><div class="row"><h2 class="g1">${esc(o.order_no)} · ${esc(c.name)}</h2>${o.source === 'pickup' ? '<span class="badge pu">🧺 Pickup order</span>' : ''}</div>
    <div class="muted">${fmt(o.created_at)} · ${esc(c.phone)}${c.email ? ' · ' + esc(c.email) : ''}</div>
    <a class="s block" href="/app/invoice/${esc(o.id)}" data-link>🧾 View / share invoice</a>
    ${o.closed_at ? `<p class="muted">Closed ${fmt(o.closed_at)}${o.cleared_reason ? ' by owner: ' + esc(o.cleared_reason) : ''}. The customer link expires 24 hours after closing.</p>` : ''}
    ${alive.map((g) => `<div class="it row">${thumb(g.photo_path)}<div class="g1"><b>${g.qty} × ${esc(g.type)}</b><div class="muted">${esc([g.color, g.description].filter(Boolean).join(' · '))}</div>${badge(g.status)}${g.rework_reason ? `<div class="muted">Reason: ${esc(g.rework_reason)}</div>` : ''}</div>
      ${g.status === 'returned' ? '' : `<select class="small" data-on="ord.status" data-g="${esc(g.id)}">${PICK.includes(g.status) ? '' : `<option value="" selected>${esc(label(g.status))}</option>`}${opts(g.status)}</select>`}</div>`).join('')}
    ${o.closed_at ? '' : `<label>Update all garments to</label><select data-on="ord.all"><option value="">Choose status…</option>${opts('')}</select>`}</div>
  ${handover}
  <div class="card"><b>Customer tracking link</b>
    ${o.tracking_token ? `<div class="muted wrap">${esc(trackLink(o.tracking_token))}</div>
      <div class="two mt"><button class="s" data-act="ord.share" data-ch="wa">💬 WhatsApp</button><button class="s" data-act="ord.share" data-ch="wab">💼 WhatsApp Business</button>
      <button class="s" data-act="ord.share" data-ch="email">✉️ Email</button><button class="s" data-act="ord.share" data-ch="sms">📱 SMS ${hasFeature('sms') ? '' : '🔒'}</button>
      <button class="s" data-act="ord.share" data-ch="copy">Copy message</button><a class="s" href="${esc(trackLink(o.tracking_token))}" target="_blank" rel="noopener">Preview page</a></div>
      <p class="muted">These open the app on your own phone. Smart Dobi cannot confirm delivery.</p>` : '<p class="muted">This order has no tracking link.</p>'}</div>`
})
async function setStatus(gid, status) { await rpc('set_garment_status', { p_garment: gid, p_status: status, p_who: S.who || '', p_reason: null }) }
ON['ord.status'] = async (el) => {
  if (!el.value) return
  el.disabled = true
  try { await setStatus(el.dataset.g, el.value) } catch (e) { toast(e.message, true) }
  rerender()
}
ON['ord.all'] = async (el) => {
  if (!el.value || !curOrder) return
  el.disabled = true
  try { for (const g of curOrder.garments) if (!['returned', 'cancelled'].includes(g.status) && g.status !== el.value) await setStatus(g.id, el.value) } catch (e) { toast(e.message, true) }
  rerender()
}
// share a message through the owner's own phone apps (nothing is sent by Smart Dobi itself)
function shareVia(ch, text, num, email, logName, logDetail) {
  const ua = navigator.userAgent, t = encodeURIComponent(text)
  const need = (v, msg) => { if (!v) { toast(msg, true); return false } return true }
  if (ch === 'copy') { navigator.clipboard && navigator.clipboard.writeText(text); return toast('Message copied.') }
  if (ch === 'wa' || ch === 'wab') {
    if (!need(num, 'No WhatsApp or phone number saved for this customer.')) return
    const biz = ch === 'wab'
    if (/Android/.test(ua)) openUrl(`intent://send?phone=${num}&text=${t}#Intent;scheme=whatsapp;package=${biz ? 'com.whatsapp.w4b' : 'com.whatsapp'};end`)
    else if (/iPhone|iPad/.test(ua)) openUrl(`${biz ? 'whatsapp-business' : 'whatsapp'}://send?phone=${num}&text=${t}`)
    else openUrl(`https://wa.me/${num}?text=${t}`)
  } else if (ch === 'email') {
    if (!need(email, 'No email saved for this customer.')) return
    openUrl(`mailto:${email}?subject=${encodeURIComponent(logDetail.subject)}&body=${t}`)
  } else if (ch === 'sms') {
    if (!hasFeature('sms')) return toast('SMS sending is not included in your plan.', true)
    if (!need(num, 'No SMS or phone number saved for this customer.')) return
    openUrl(`sms:+${num}${/iPhone|iPad/.test(ua) ? '&' : '?'}body=${t}`)
  }
  logEvent(logName, { order_no: logDetail.order_no, channel: ch })
}
ACT['ord.share'] = (el) => {
  const o = curOrder, c = one(o.customers) || {}, b = S.biz
  const contacts = [b.phone, b.email].filter(Boolean).join(' · ')
  const text = `Hello ${String(c.name || '').split(' ')[0]}, thank you for choosing ${b.name}. We recorded your garments on ${fmt(o.created_at)}. View and track them securely: ${trackLink(o.tracking_token)} . Please check the list and contact us if anything is incorrect.\n${b.name}${contacts ? ' · ' + contacts : ''}\nPowered by Smart Dobi`
  shareVia(el.dataset.ch, text, intlPhone(c.phone), c.email, 'notify_opened', { order_no: o.order_no, subject: `Your laundry order ${o.order_no} · ${b.name}` })
}

// ----- hand-over (accept / not accepted / owner clear) -----
const tickedIn = (el) => [...el.closest('.card').querySelectorAll('[data-on="pick.tick"]')].filter((c) => c.checked).map((c) => c.dataset.g)
async function changeMany(ids, status, reason) {
  for (const gid of ids) await rpc('set_garment_status', { p_garment: gid, p_status: status, p_who: S.who || '', p_reason: reason })
  rerender()
}
ACT['pick.accept'] = async (el) => {
  const ids = tickedIn(el)
  if (!ids.length) return toast('Tick the items the customer accepted.', true)
  if (!confirm(`Hand back ${ids.length} garment(s) to the customer?`)) return
  await changeMany(ids, 'returned', null)
}
ACT['pick.all'] = async () => {
  const ids = curOrder.garments.filter((g) => g.status === 'ready').map((g) => g.id)
  if (!ids.length) return toast('Nothing is ready.', true)
  if (!confirm(`Hand back all ${ids.length} ready garment(s)?`)) return
  await changeMany(ids, 'returned', null)
}
ACT['pick.reject'] = async (el) => {
  const card = el.closest('.card'), ids = tickedIn(el), why = (card.querySelector('[data-why]').value || '').trim()
  if (!ids.length) return toast('Tick the items the customer did not accept.', true)
  if (!why) return toast('Enter a reason.', true)
  await changeMany(ids, 'rework', why)
}
ACT['pick.clearopen'] = () => { clearing = curOrder.id; rerender() }
ACT['pick.clearcancel'] = () => { clearing = null; rerender() }
ACT['pick.clear'] = async (form) => {
  const f = formData(form); formErr('', form); busy(form, true, 'Checking…')
  try {
    const ok = await rpc('clear_order', { p_order: curOrder.id, p_pin: f.pin, p_reason: f.reason, p_who: S.who || '' })
    if (ok !== true) { busy(form, false); return formErr('Wrong admin PIN.', form) }
    clearing = null; toast('Order cleared.'); rerender()
  } catch (e) { busy(form, false); formErr(e.message, form) }
}

// ================= Requests: customer pickup orders and call-backs =================
const contactLine = (r) => [r.contact_whatsapp && '💬 ' + r.contact_whatsapp, r.contact_sms && '📱 ' + r.contact_sms, r.contact_email && '✉️ ' + r.contact_email].filter(Boolean).join(' · ')
route('/app/notifications', async () => {
  const rows = await select('requests', `select=*&branch_id=eq.${enc(S.branchId)}&order=created_at.desc&limit=100`)
  const pickups = rows.filter((r) => r.kind === 'pickup'), others = rows.filter((r) => r.kind !== 'pickup')
  const tone = (st) => (st === 'new' ? 'am' : st === 'converted' ? 'gr' : st === 'declined' ? 'rd' : 'pu')
  const pcard = (r) => {
    const items = r.items || [], open = ['new', 'contacted'].includes(r.status)
    return `<div class="card"><div class="row"><b class="g1">🧺 Pickup order · ${esc(r.name)}</b><span class="badge ${tone(r.status)}">${r.status === 'converted' ? 'Invoiced' : esc(r.status)}</span></div>
      <div class="muted">${fmt(r.created_at)} · ${esc(r.how || '')}</div><div class="muted">${esc(contactLine(r))}</div>
      <div class="chips">${items.slice(0, 6).map((i) => `<span class="chip">${Number(i.qty)} × ${esc(i.type)}</span>`).join('')}${items.length > 6 ? `<span class="chip">+${items.length - 6} more</span>` : ''}</div>
      ${open ? `<div class="row mt">${items.filter((i) => i.photo_path).slice(0, 4).map((i) => `<img class="ph" src="${esc(photoUrl(i.photo_path))}" alt="">`).join('')}</div>` : ''}
      ${r.note ? `<p class="muted">${esc(r.note)}</p>` : ''}${r.decline_reason ? `<div class="note">Declined: ${esc(r.decline_reason)}</div>` : ''}
      ${open ? `<a class="p mt" href="/app/pickups/${esc(r.id)}" data-link>Review &amp; price</a>` : ''}${r.status === 'converted' && r.order_id ? `<a class="s block" href="/app/orders/${esc(r.order_id)}" data-link>Open order</a>` : ''}</div>`
  }
  const ocard = (r) => { const n = intlPhone(r.phone)
    return `<div class="card"><div class="row"><b class="g1">${r.kind === 'pkg' ? '📦 Package' : '📞 Call-back'} · ${esc(r.name)}</b><span class="badge ${tone(r.status)}">${esc(r.status)}</span></div>
      <div class="muted">${fmt(r.created_at)} · ${esc(r.phone)}</div>${r.note ? `<p>${esc(r.note)}</p>` : ''}${r.how ? `<div class="muted">${esc(r.how)}</div>` : ''}
      <div class="two mt"><a class="s" href="tel:+${esc(n)}">📞 Call</a><a class="s" href="https://wa.me/${esc(n)}" target="_blank" rel="noopener">💬 WhatsApp</a></div>
      ${r.status === 'new' ? `<button class="s block" data-act="req.mark" data-id="${esc(r.id)}">Mark contacted</button>` : ''}</div>` }
  return `<h2>Requests</h2><p class="muted">Pickup orders from customers who found your Dobi in the directory. Review the items, add prices, then send the invoice.</p>
    ${pickups.length ? pickups.map(pcard).join('') : '<div class="card muted">No pickup orders yet. Customers find your Dobi in the public directory, add their items and send a pickup request. It appears here.</div>'}
    ${others.length ? '<h2>Call-backs</h2>' + others.map(ocard).join('') : ''}`
})
ACT['req.mark'] = async (el) => { await update('requests', `id=eq.${enc(el.dataset.id)}`, { status: 'contacted' }); rerender() }

// ----- review a pickup order: confirm each item, set prices, process the invoice -----
let rv = null
route('/app/pickups/:id', async ({ id }) => {
  const r = (await select('requests', `select=*&id=eq.${enc(id)}&limit=1`))[0]
  if (!r || r.kind !== 'pickup') return `${backBtn('/app/notifications')}<div class="card mt"><p>Pickup order not found.</p></div>`
  if (!['new', 'contacted'].includes(r.status)) return `${backBtn('/app/notifications')}<div class="card mt"><p>This request was already ${esc(r.status)}.</p>${r.order_id ? `<a class="s" href="/app/orders/${esc(r.order_id)}" data-link>Open order</a>` : ''}</div>`
  rv = { id: r.id, items: (r.items || []).map((i) => ({ type: i.type, qty: Number(i.qty) || 1, color: i.color || '', description: i.description || '', photo_path: i.photo_path || null, price: '' })) }
  return `${backBtn('/app/notifications')}<h2 class="mt">Review pickup order</h2>
  <div class="card"><b>${esc(r.name)}</b><div class="muted">${esc(contactLine(r))}</div><div class="muted">${esc(r.how || '')}</div>${r.note ? `<p>${esc(r.note)}</p>` : ''}
    <p class="muted">Check each item against what the customer described. Fix anything that is wrong, add a price for each item, then process the invoice.</p></div>
  <div id="rv-items"></div>
  <div class="card"><b>Add an item the customer forgot</b><div class="two mt"><input id="rv-new" placeholder="Type, e.g. Towel" maxlength="80"><button class="g" data-act="rv.add">Add item</button></div></div>
  <div class="card"><b id="rv-total"></b><div class="note formerr" hidden></div><button class="p mt" data-act="rv.process">Process invoice</button>
    <input id="rv-reason" class="mt" placeholder="Reason, only if you decline this request" maxlength="300"><button class="s block" data-act="rv.decline">Decline request</button></div>`
}, { after: () => drawReview() })
function drawReview() {
  setHtml('rv-items', rv.items.map((g, i) => `<div class="card"><div class="row">${thumb(g.photo_path)}<b class="g1">Item ${i + 1}</b><button class="s" data-act="rv.remove" data-i="${i}">✕</button></div>
    <div class="two"><div><label>Type</label><input data-on="rv.f" data-ev="input" data-i="${i}" data-k="type" value="${esc(g.type)}" maxlength="80"></div><div><label>Quantity</label><input type="number" min="1" max="99" data-on="rv.f" data-ev="input" data-i="${i}" data-k="qty" value="${g.qty}"></div></div>
    <div class="two"><div><label>Colour</label><input data-on="rv.f" data-ev="input" data-i="${i}" data-k="color" value="${esc(g.color)}" maxlength="60"></div><div><label>Price each (UGX)</label><input type="number" min="0" inputmode="numeric" data-on="rv.f" data-ev="input" data-i="${i}" data-k="price" value="${esc(g.price)}"></div></div>
    <label>Condition / notes</label><input data-on="rv.f" data-ev="input" data-i="${i}" data-k="description" value="${esc(g.description)}" maxlength="300"></div>`).join(''))
  drawRvTotal()
}
const rvTotal = () => rv.items.reduce((a, g) => a + (Number(g.price) || 0) * g.qty, 0)
function drawRvTotal() { const e = document.getElementById('rv-total'); if (e) e.textContent = `Total ${U(rvTotal())} for ${rv.items.reduce((a, g) => a + g.qty, 0)} item(s)` }
ON['rv.f'] = (el) => {
  const g = rv.items[Number(el.dataset.i)]; if (!g) return
  g[el.dataset.k] = el.dataset.k === 'qty' ? Math.max(1, Math.min(99, Math.floor(Number(el.value) || 1))) : el.value
  drawRvTotal()
}
ACT['rv.remove'] = (el) => { rv.items.splice(Number(el.dataset.i), 1); drawReview() }
ACT['rv.add'] = () => {
  const t = (document.getElementById('rv-new').value || '').trim()
  if (!t) return toast('Type the item name first.', true)
  rv.items.push({ type: t, qty: 1, color: '', description: '', photo_path: null, price: '' }); document.getElementById('rv-new').value = ''; drawReview()
}
ACT['rv.process'] = async (btn) => {
  formErr('')
  if (!rv.items.length) return formErr('Add at least one item.')
  if (rv.items.some((i) => !String(i.type).trim())) return formErr('Every item needs a type.')
  if (rv.items.some((i) => i.price !== '' && (!Number.isFinite(Number(i.price)) || Number(i.price) < 0))) return formErr('Prices must be numbers of 0 or more.')
  if (rv.items.some((i) => i.price === '') && !confirm('Some items have no price yet. Process the invoice anyway?')) return
  btn.disabled = true; btn.textContent = 'Processing…'
  try {
    const res = await rpc('process_pickup', { p_request: rv.id, p_who: S.who || '', p_token: randomToken(),
      p_items: rv.items.map((i) => ({ type: i.type.trim(), qty: i.qty, color: i.color, description: i.description, photo_path: i.photo_path, price: i.price === '' ? null : Number(i.price) })) })
    go('/app/invoice/' + res.order_id)
  } catch (e) { btn.disabled = false; btn.textContent = 'Process invoice'; formErr(e.message) }
}
ACT['rv.decline'] = async () => {
  const why = (document.getElementById('rv-reason').value || '').trim()
  if (why.length < 3) return formErr('Enter a reason to decline.')
  if (!confirm('Decline this pickup request?')) return
  await rpc('decline_pickup', { p_request: rv.id, p_reason: why, p_who: S.who || '' }); toast('Request declined.'); go('/app/notifications')
}

// ----- invoice for an order, with share buttons -----
let curInv = null
route('/app/invoice/:id', async ({ id }) => {
  const o = (await select('orders', `select=id,order_no,created_at,source,request_id,tracking_token,customers(name,phone,email),garments(id,type,qty,color,description,unit_price_ugx)&id=eq.${enc(id)}&limit=1`))[0]
  if (!o) return `${backBtn('/app/orders')}<div class="card mt"><p>Order not found.</p></div>`
  const rq = o.request_id ? (await select('requests', `select=contact_email,contact_whatsapp,contact_sms&id=eq.${enc(o.request_id)}&limit=1`))[0] || null : null
  o.garments.sort((a, b) => a.id.localeCompare(b.id))
  curInv = { o, rq }
  const c = one(o.customers) || {}, total = o.garments.reduce((a, g) => a + (Number(g.unit_price_ugx) || 0) * g.qty, 0)
  const contacts = [S.biz.phone, S.biz.email].filter(Boolean).join(' · ')
  return `<div class="noprint">${backBtn('/app/orders/' + o.id)}</div>
  <div class="card doc mt"><div class="row"><div class="g1"><b class="big">${esc(S.biz.name)}</b><div class="muted">${esc(branchName(S.branchId))}</div></div><b>INVOICE</b></div>
    ${o.source === 'pickup' ? '<div class="mt"><span class="badge pu">🧺 Pickup order</span></div>' : ''}
    <div class="muted mt">INV-${esc(o.order_no.replace(/\D/g, ''))} · ${fmt(new Date())}<br>Customer: ${esc(c.name)}<br>Order ${esc(o.order_no)}</div>
    <div class="mt">${o.garments.map((g) => `<div class="row it"><span class="g1">${g.qty} × ${esc(g.type)}${g.unit_price_ugx == null ? ' <span class="muted">(no price yet)</span>' : ' @ ' + U(g.unit_price_ugx)}</span>${U((Number(g.unit_price_ugx) || 0) * g.qty)}</div>`).join('')}</div>
    <div class="row it"><b class="g1">Total</b><b>${U(total)}</b></div>
    <p class="muted center">${esc(contacts ? S.biz.name + ' · ' + contacts : S.biz.name)}<br>Powered by Smart Dobi</p></div>
  <div class="card noprint"><b>Send the invoice</b>
    <p class="muted">${esc(rq ? contactLine(rq) : [c.phone, c.email].filter(Boolean).join(' · '))}</p>
    <div class="two"><button class="s" data-act="inv.share" data-ch="wa">💬 WhatsApp</button><button class="s" data-act="inv.share" data-ch="wab">💼 WhatsApp Business</button>
    <button class="s" data-act="inv.share" data-ch="email">✉️ Email</button><button class="s" data-act="inv.share" data-ch="sms">📱 SMS ${hasFeature('sms') ? '' : '🔒'}</button>
    <button class="s" data-act="inv.share" data-ch="copy">Copy message</button><button class="s" data-act="print">🖨️ Print</button></div>
    <p class="muted">These open the app on your own phone. Smart Dobi cannot confirm delivery.</p></div>`
})
ACT.print = () => window.print()
ACT['inv.share'] = (el) => {
  const { o, rq } = curInv, c = one(o.customers) || {}, b = S.biz
  const total = o.garments.reduce((a, g) => a + (Number(g.unit_price_ugx) || 0) * g.qty, 0)
  const lines = o.garments.map((g) => `${g.qty} x ${g.type}${g.unit_price_ugx == null ? '' : ' @ ' + U(g.unit_price_ugx)}`).join('\n')
  const contacts = [b.phone, b.email].filter(Boolean).join(' · ')
  const text = `Hello ${String(c.name || '').split(' ')[0]}, here is your invoice from ${b.name} for order ${o.order_no}:\n${lines}\nTotal: ${U(total)}\nTrack your items: ${trackLink(o.tracking_token)}\n${b.name}${contacts ? ' · ' + contacts : ''}\nPowered by Smart Dobi`
  const ch = el.dataset.ch, wa = intlPhone((rq && rq.contact_whatsapp) || c.phone), sms = intlPhone((rq && rq.contact_sms) || c.phone)
  shareVia(ch, text, ch === 'sms' ? sms : wa, (rq && rq.contact_email) || c.email, 'invoice_shared', { order_no: o.order_no, subject: `Your invoice ${o.order_no} · ${b.name}` })
}

// ================= Photo clearing (the days are set per plan by the platform) =================
// Runs when someone from the shop uses the app online (at most once an hour).
export async function runCleanup() {
  if (!S.biz || !isOnline()) return
  const k = 'sd_cleanup_' + S.biz.id
  try { if (Date.now() - Number(localStorage.getItem(k) || 0) < 3600000) return } catch { /* ignore */ }
  try {
    const due = await rpc('due_photo_deletions', { p_business: S.biz.id })
    const gs = (due && due.garments) || [], rs = (due && due.requests) || []
    const paths = [...gs.map((g) => g.path), ...rs.flatMap((r) => r.paths || [])].filter(Boolean)
    if (paths.length) {
      for (let i = 0; i < paths.length; i += 50) await removePhotos(paths.slice(i, i + 50))
      await rpc('mark_photos_deleted', { p_business: S.biz.id, p_garments: gs.map((g) => g.id), p_requests: rs.map((r) => r.id) })
    }
    try { localStorage.setItem(k, String(Date.now())) } catch { /* ignore */ }
  } catch { /* it will try again next time */ }
}

// ================= Staff & shops (admin) =================
route('/app/staff', async () => {
  const plan = (await select('plans', `select=name,max_branches,max_workers_per_branch&id=eq.${enc(S.biz.plan_id)}`))[0] || {}
  const b = S.biz
  return `${backBtn('/app')}<h2 class="mt">Staff &amp; shops</h2>
  <div class="card"><b>${esc(plan.name || b.plan_id)} plan</b><p class="muted">${b.branches.length} of ${plan.max_branches ?? '…'} shops · up to ${plan.max_workers_per_branch ?? '…'} workers per shop. Limits are enforced by the database.</p></div>
  ${b.branches.map((br) => {
    const ws = b.workers.filter((w) => w.branch_id === br.id)
    return `<div class="card"><b>🏬 ${esc(br.name)}</b> <span class="muted">${ws.length} of ${plan.max_workers_per_branch ?? '…'} workers</span>
      ${ws.map((w) => `<div class="row it"><span class="g1">👤 ${esc(w.name)}</span><button class="s" data-act="staff.remove" data-id="${esc(w.id)}" data-name="${esc(w.name)}">Remove</button></div>`).join('')}
      <form class="two mt" data-act="staff.add" data-b="${esc(br.id)}"><input name="name" placeholder="Worker name" required minlength="2" maxlength="80"><button class="g">Add worker</button></form></div>`
  }).join('')}
  <form class="card" data-act="staff.shop"><b>Add a shop</b><input name="name" class="mt" placeholder="Shop name" required minlength="2" maxlength="80">
    <input name="pin" class="mt" type="password" inputmode="numeric" maxlength="5" required placeholder="Branch PIN (4–5 digits)" autocomplete="off"><button class="g mt">Add shop</button></form>
  <form class="card" data-act="staff.pin"><b>Change a PIN</b><select name="shop" class="mt"><option value="">Choose a shop…</option>${b.branches.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select>
    <input name="pin" class="mt" type="password" inputmode="numeric" maxlength="5" placeholder="New branch PIN" autocomplete="off"><button class="s mt">Save branch PIN</button></form>
  <form class="card" data-act="staff.apin"><b>Change admin PIN</b><input name="pin" class="mt" type="password" inputmode="numeric" maxlength="5" required placeholder="New admin PIN" autocomplete="off"><button class="s mt">Save admin PIN</button></form>`
}, { admin: true })
const refresh = async (msg) => { await loadBiz(); rerender(); toast(msg) }
ACT['staff.add'] = async (form) => {
  const name = formData(form).name.trim()
  if (name.length < 2) return toast('Enter the worker name.', true)
  await insert('workers', { business_id: S.biz.id, branch_id: form.dataset.b, name }); await refresh(`${name} added.`)
}
ACT['staff.remove'] = async (el) => {
  if (!confirm(`Remove ${el.dataset.name}?`)) return
  await update('workers', `id=eq.${enc(el.dataset.id)}`, { active: false }); await refresh('Worker removed.')
}
ACT['staff.shop'] = async (form) => {
  const f = formData(form)
  if (!PIN_RE.test(f.pin)) return toast('PIN must be 4 or 5 digits.', true)
  await rpc('create_branch', { p_business: S.biz.id, p_name: f.name, p_pin: f.pin }); await refresh('Shop added.')
}
ACT['staff.pin'] = async (form) => {
  const f = formData(form)
  if (!f.shop || !PIN_RE.test(f.pin)) return toast('Choose a shop and a 4–5 digit PIN.', true)
  await rpc('set_branch_pin', { p_branch: f.shop, p_pin: f.pin }); await refresh('Branch PIN updated.')
}
ACT['staff.apin'] = async (form) => {
  const f = formData(form)
  if (!PIN_RE.test(f.pin)) return toast('PIN must be 4 or 5 digits.', true)
  await rpc('set_admin_pin', { p_business: S.biz.id, p_pin: f.pin }); await refresh('Admin PIN updated.')
}

// ================= Audit trail (admin) =================
route('/app/audit', async () => {
  const rows = await select('audit_events', `select=id,branch_id,who,action,detail,at&business_id=eq.${enc(S.biz.id)}&order=at.desc&limit=200`)
  const say = (e) => {
    const d = e.detail || {}
    switch (e.action) {
      case 'order_received': return `Received ${d.order_no} (${d.items} items)`
      case 'garment_status': return `${d.order_no}: ${d.type} ${label(d.from)} → ${label(d.to)}${d.reason ? ' — ' + d.reason : ''}`
      case 'garment_returned': return `${d.order_no}: handed back ${d.type}`
      case 'order_cleared': return `${d.order_no}: owner cleared order — ${d.reason}`
      case 'notify_opened': return `${d.order_no}: opened ${d.channel} message`
      case 'entered_branch': return d.offline ? 'Entered the shop (offline)' : 'Entered the shop'
      case 'branch_created': return `Added shop ${d.name}`
      case 'price_set': return `${d.order_no}: price for ${d.type} set to ${d.price}`
      case 'payment_received': return `${d.order_no}: received ${d.amount} (${d.method}), receipt ${d.receipt}`
      case 'payment_reversed': return `Reversed payment ${d.receipt}`
      case 'expense_added': return `Expense ${d.amount} · ${d.category}`
      case 'expense_voided': return 'Voided an expense'
      case 'wrong_branch_pin': return 'Wrong branch PIN attempt'
      case 'wrong_admin_pin': return 'Wrong admin PIN attempt'
      default: return e.action
    }
  }
  return `${backBtn('/app')}<h2 class="mt">Audit trail</h2><div class="card">${rows.length ? rows.map((e) => `<div class="it"><b>${esc(e.who || 'System')}</b> · ${esc(say(e))}<div class="muted">${fmt(e.at)} · ${esc(branchName(e.branch_id) || '—')}${e.detail && e.detail.device_time ? ' · device time ' + fmt(e.detail.device_time) : ''}</div></div>`).join('') : '<p class="muted">Nothing recorded yet.</p>'}</div>`
}, { admin: true })

// ================= Public Dobi profile (admin) =================
route('/app/profile', async () => {
  if (!hasFeature('directory')) return '<div class="card"><h2>Public Dobi profile</h2><p class="muted">The public directory is not included in your plan.</p></div>'
  const b = (await select('branches', `select=id,name,area,address,hours,about,services,pickup_delivery,listed&id=eq.${enc(S.branchId)}`))[0]
  if (!b) return '<div class="card">Shop not found.</div>'
  return `${backBtn('/app')}<h2 class="mt">Public Dobi profile</h2><p class="muted">${esc(b.name)}</p>
  <form class="card" data-act="profile.save">
    <label class="check"><input type="checkbox" name="listed" ${b.listed ? 'checked' : ''}> Show this shop in the Smart Dobi directory</label>
    <p class="muted">Customers see your name, location, services and contacts. Never prices. Contacts come from your business phone and email set during setup.</p>
    <label>Area</label><select name="area"><option value="">Choose area</option>${AREAS.map((a) => `<option ${b.area === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select>
    <label>Address / landmark</label><input name="address" value="${esc(b.address || '')}" maxlength="120">
    <label>Services</label><div class="chips">${SERVICES.map((s) => `<label class="chip"><input type="checkbox" name="svc" value="${esc(s)}" ${(b.services || []).includes(s) ? 'checked' : ''}> ${esc(s)}</label>`).join('')}</div>
    <label class="check"><input type="checkbox" name="pd" ${b.pickup_delivery ? 'checked' : ''}> Pickup &amp; delivery available</label>
    <label>Opening hours</label><input name="hours" value="${esc(b.hours || '')}" placeholder="Mon–Sat 7am–8pm" maxlength="80">
    <label>About your Dobi</label><textarea name="about" rows="3" maxlength="400">${esc(b.about || '')}</textarea>
    <div class="note formerr" hidden></div><button class="p mt">Save profile</button>
    <a class="s block" href="/dobi/${esc(b.id)}" data-link>Preview public page</a></form>`
}, { admin: true })
ACT['profile.save'] = async (form) => {
  const fd = new FormData(form)
  busy(form, true, 'Saving…')
  try {
    await update('branches', `id=eq.${enc(S.branchId)}`, {
      listed: fd.get('listed') === 'on', area: fd.get('area') || null, address: String(fd.get('address') || '').trim() || null,
      services: fd.getAll('svc'), pickup_delivery: fd.get('pd') === 'on', hours: String(fd.get('hours') || '').trim() || null, about: String(fd.get('about') || '').trim() || null,
    })
    toast('Profile saved.')
  } catch (e) { formErr(e.message, form) }
  busy(form, false)
}
