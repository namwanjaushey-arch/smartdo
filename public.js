// public.js - pages anyone can open without an account: landing + directory, a Dobi's page, and the customer tracking page.
import { getSession, rpcPublic, photoUrl, uploadAnon } from './api.js'
import { route, ACT, ON, timers, toast, formData, formErr, busy, rerender } from './core.js'
import { esc, enc, fmt, badge, label, LOGO, WORDMARK, SERVICES, AREAS, PROGRESS, intlPhone, STATUS, CAT, newId, compressImage, backBtn } from './util.js'

const shell = (inner) => `<div class="app"><header>${LOGO(36)} ${WORDMARK}<span class="push">${getSession() ? '<a class="s" href="/app" data-link>Open dashboard</a>' : '<a class="s" href="/auth" data-link>Shop sign-in</a>'}</span></header>${inner}<p class="muted center mt">Powered by Smart Dobi · <a href="/support" data-link>Support</a> · <a href="/support?kind=partner" data-link>Partner with us</a></p></div>`

// ================= Landing + directory =================
let q = '', area = '', svc = [], pickup = false, dirTimer = null
route('/', () => shell(`<div class="pubhero"><h1>Find your Dobi.<br>Never lose a garment again.</h1>
  <p>Connect with your favourite laundry on Smart Dobi. Every item photographed. Every step tracked.</p>
  <input data-on="dir.q" data-ev="input" placeholder="🔎 Search a Dobi by name, area or service…" value="${esc(q)}" aria-label="Search"><div id="dir-filters"></div></div>
  <div id="dir-res"></div>
  <h2 class="center mt">One app for the whole cleaning trade</h2>
  <p class="center">Smart Dobi helps cleaning businesses record every item, keep customers informed and run the shop from one place. Customers can find a Dobi, send their package and follow every garment.</p>
  <div class="chips center"><span class="chip">Laundries &amp; dobis</span><span class="chip">Dry cleaners</span><span class="chip">Carpet &amp; upholstery cleaning</span><span class="chip">Hotel &amp; guesthouse linen</span><span class="chip">School &amp; work uniforms</span><span class="chip">Clinics &amp; labs</span></div>
  <h2 class="mt">For shop owners</h2>
  <div class="feats">${[['📸', 'Every item recorded', 'Photo, colour and notes for each garment, so there are no disputes at pickup.'], ['🧾', 'Receipts &amp; invoices', 'Print or save a receipt for every payment, with balances worked out for you.'], ['📊', 'Reports &amp; expenses', 'Sales, money collected, expenses and an estimated result for any period.'], ['👥', 'Staff &amp; shops', 'Several shops, workers named on every action, and a full audit trail.'], ['📴', 'Works offline', 'Record money with no internet. It syncs when you are back online.'], ['📦', 'Stock management', 'Track detergents and supplies. <span class="badge am">Coming soon</span>']].map(([i, t, d]) => `<div class="card feat"><span class="ic">${i}</span><div><b>${t}</b><span class="muted">${d}</span></div></div>`).join('')}</div>
  <h2 class="mt">For your customers</h2>
  <div class="feats">${[['🧺', 'Request a pickup', 'Find your Dobi, record your items with a photo each and submit. The shop is notified and picks them up. No account needed.'], ['🧾', 'Invoice your way', 'Get your invoice by WhatsApp, email or SMS once the shop has priced your items.'], ['🔗', 'Track every garment', "A private link shows each item's photo and status."]].map(([i, t, d]) => `<div class="card feat"><span class="ic">${i}</span><div><b>${t}</b><span class="muted">${d}</span></div></div>`).join('')}</div>
  <h2 class="center mt">So easy, so smooth</h2>
  ${[['1', 'Find your Dobi', 'Search by name, area or service and open their page.'], ['2', 'Add your items and tap Pick up', 'A photo of each item helps. Choose how you want your invoice.'], ['3', 'The shop reviews, prices and invoices', 'You get your invoice and a private link to follow every garment.']].map(([n, t, d]) => `<div class="card row"><div class="ph num">${n}</div><div class="g1"><b>${t}</b><div class="muted">${d}</div></div></div>`).join('')}
  <div class="card center tint"><b>Run a laundry?</b><p class="muted">Put your Dobi on Smart Dobi, record every garment and manage your shop from one place.</p><a class="p" href="/auth" data-link>${getSession() ? 'Open my dashboard' : 'Create your shop account'}</a></div>`), { kind: 'public', after: () => { drawFilters(); drawResults() } })
ON['dir.q'] = (el) => { q = el.value; clearTimeout(dirTimer); dirTimer = setTimeout(drawResults, 300) }
ON['dir.area'] = (el) => { area = el.value; drawResults() }
ACT['dir.pickup'] = () => { pickup = !pickup; drawFilters(); drawResults() }
ACT['dir.svc'] = (el) => { const v = el.dataset.v, i = svc.indexOf(v); if (i < 0) svc.push(v); else svc.splice(i, 1); drawFilters(); drawResults() }
function drawFilters() {
  const el = document.getElementById('dir-filters')
  if (!el) return
  el.innerHTML = `<div class="two mt"><select data-on="dir.area" aria-label="Area"><option value="">Any area</option>${AREAS.map((a) => `<option ${a === area ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select>
    <span class="chip ${pickup ? 'on' : ''}" data-act="dir.pickup">🚚 Pickup &amp; delivery</span></div>
    <div class="chips">${SERVICES.map((s) => `<span class="chip ${svc.includes(s) ? 'on' : ''}" data-act="dir.svc" data-v="${esc(s)}">${esc(s)}</span>`).join('')}</div>`
}
async function drawResults() {
  const el = document.getElementById('dir-res')
  if (!el) return
  if (!(q.trim() || area || svc.length || pickup)) { el.innerHTML = '<p class="muted center mt">Start typing or pick a filter to find a Dobi near you.</p>'; return }
  el.innerHTML = '<p class="muted center mt">Searching…</p>'
  try {
    const rows = await rpcPublic('search_dobis', { p_q: q.trim(), p_area: area, p_services: svc, p_pickup: pickup })
    if (!document.getElementById('dir-res')) return
    el.innerHTML = rows && rows.length ? rows.map((l) => `<a href="/dobi/${esc(l.branch_id)}" data-link class="card link row mt"><div class="ph letter">${esc((l.shop_name || '?')[0])}</div>
      <div class="g1"><b>${esc(l.shop_name)}</b><div class="muted">📍 ${esc(l.area || 'Area not set')}${l.pickup_delivery ? ' · 🚚 Pickup &amp; delivery' : ''}</div><div class="muted">${esc((l.services || []).slice(0, 3).join(' · '))}</div></div>›</a>`).join('')
      : '<div class="card muted mt">No Dobi matches yet. Try fewer filters.</div>'
  } catch (e) { el.innerHTML = `<div class="note mt">${e.offline ? 'You are offline. Search needs internet.' : 'Could not search: ' + esc(e.message)}</div>` }
}

// ================= A Dobi's page (pickup request) =================
const pkFresh = () => ({ name: '', email: '', whatsapp: '', sms: '', how: 'I will drop it off', note: '', items: [], q: '', cat: 'All', cur: null })
let pk = pkFresh(), reqType = 'pickup', sent = ''
route('/dobi/:id', async ({ id }) => {
  const rows = await rpcPublic('get_dobi', { p_branch: id })
  const l = rows && rows[0]
  if (!l) return shell(`${backBtn('/')}<div class="card mt"><h2>Dobi not found</h2><p class="muted">This shop is not listed or is not taking requests right now.</p></div>`)
  const n = intlPhone(l.phone)
  return shell(`${backBtn('/')}
  <div class="card mt"><div class="row"><div class="ph letter">${esc((l.shop_name || '?')[0])}</div><div class="g1"><h2>${esc(l.shop_name)}</h2><div class="muted">📍 ${esc(l.area || '')}${l.address ? ' · ' + esc(l.address) : ''}</div></div></div>
    ${l.about ? `<p>${esc(l.about)}</p>` : ''}<div class="chips">${(l.services || []).map((s) => `<span class="chip on">${esc(s)}</span>`).join('')}${l.pickup_delivery ? '<span class="chip on">🚚 Pickup &amp; delivery</span>' : ''}</div>
    ${l.hours ? `<p class="muted">🕒 ${esc(l.hours)}</p>` : ''}</div>
  <div class="card"><b>Get in touch</b><div class="two mt">${n ? `<a class="s" href="https://wa.me/${esc(n)}" target="_blank" rel="noopener">💬 WhatsApp</a><a class="s" href="tel:+${esc(n)}">📞 Call</a>` : ''}${l.email ? `<a class="s" href="mailto:${esc(l.email)}">✉️ Email</a>` : ''}</div>${n || l.email ? '' : '<p class="muted">This shop has not added contacts yet. Use the form below.</p>'}</div>
  <div id="dobi-form"></div>`)
}, { kind: 'public', after: () => { sent = ''; pk = pkFresh(); reqType = 'pickup'; drawForm() } })
const setHtml = (id, html) => { const e = document.getElementById(id); if (e) e.innerHTML = html }
function drawForm() {
  const el = document.getElementById('dobi-form')
  if (!el) return
  const id = location.pathname.split('/').pop()
  const tabs = `<div class="chips"><span class="chip ${reqType === 'pickup' ? 'on' : ''}" data-act="dobi.tab" data-v="pickup">🧺 Request a pickup</span><span class="chip ${reqType === 'cb' ? 'on' : ''}" data-act="dobi.tab" data-v="cb">📞 Ask to be called</span></div>`
  if (sent) { el.innerHTML = `<div class="card">${tabs}<div class="ok mt">${esc(sent)}</div></div>`; return }
  if (reqType === 'cb') {
    el.innerHTML = `<div class="card">${tabs}<form data-act="dobi.send" data-id="${esc(id)}"><label>Your name</label><input name="name" required minlength="2" maxlength="80"><label>Phone</label><input name="phone" inputmode="tel" required maxlength="20">
      <label>Best time to call</label><input name="note" maxlength="200" placeholder="e.g. after 5pm"><div class="note formerr" hidden></div><button class="p mt">Request a call-back</button></form></div>`
    return
  }
  el.innerHTML = `<div class="card">${tabs}
    <p class="muted mt"><b>How it works:</b> add your items (a photo of each helps), choose how you want your invoice, then tap <b>Pick up my items</b>. The shop reviews your items, adds prices and sends you an invoice. No account needed.</p>
    <input data-on="pk.q" data-ev="input" placeholder="Search an item: shirt, duvet, carpet…" value="${esc(pk.q)}" aria-label="Search items">
    <div class="chips" id="pk-cats"></div><div class="chips" id="pk-pick"></div><div id="pk-cur"></div>
    <h2 class="mt" id="pk-count"></h2><div id="pk-items"></div>
    <b>Where should we send your invoice? (at least one)</b>
    <label>Your name</label><input data-on="pk.f" data-ev="input" data-k="name" value="${esc(pk.name)}" maxlength="80">
    <label>Email</label><input data-on="pk.f" data-ev="input" data-k="email" type="email" value="${esc(pk.email)}" maxlength="80">
    <div class="two"><div><label>WhatsApp number</label><input data-on="pk.f" data-ev="input" data-k="whatsapp" inputmode="tel" value="${esc(pk.whatsapp)}" maxlength="20"></div>
    <div><label>SMS number</label><input data-on="pk.f" data-ev="input" data-k="sms" inputmode="tel" value="${esc(pk.sms)}" maxlength="20"></div></div>
    <label>How will your items reach the shop?</label><select data-on="pk.f" data-k="how">${['I will drop it off', 'Please collect from me'].map((o) => `<option ${pk.how === o ? 'selected' : ''}>${o}</option>`).join('')}</select>
    <label>Address or notes (optional)</label><textarea data-on="pk.f" data-ev="input" data-k="note" rows="2" maxlength="500">${esc(pk.note)}</textarea>
    <div class="note formerr" hidden></div><button class="p mt" data-act="pk.send">🧺 Pick up my items</button></div>`
  drawPkCats(); drawPkPick(); drawPkCur(); drawPkItems()
}
ACT['dobi.tab'] = (el) => { reqType = el.dataset.v; drawForm() }
ON['pk.f'] = (el) => { pk[el.dataset.k] = el.value }
ON['pk.q'] = (el) => { pk.q = el.value; drawPkPick() }
ON['pk.cur'] = (el) => { const c = pk.cur; if (c) c[el.dataset.k] = el.dataset.k === 'qty' ? Math.max(1, Math.min(99, Math.floor(Number(el.value) || 1))) : el.value }
ON['pk.photo'] = (el) => {
  const f = el.files && el.files[0]
  if (!f || !pk.cur) return
  if (!f.type.startsWith('image/')) return toast('Please choose a photo.', true)
  if (f.size > 15 * 1024 * 1024) return toast('That photo is too large (maximum 15 MB).', true)
  if (pk.cur.preview) URL.revokeObjectURL(pk.cur.preview)
  pk.cur.file = f; pk.cur.preview = URL.createObjectURL(f); drawPkCur()
}
ACT['pk.cat'] = (el) => { pk.cat = el.dataset.v; drawPkCats(); drawPkPick() }
ACT['pk.type'] = (el) => { pk.cur = { type: el.dataset.v, qty: 1, color: '', desc: '', file: null, preview: '' }; drawPkCur() }
ACT['pk.add'] = () => {
  if (!pk.cur) return
  pk.items.push({ ...pk.cur }); pk.cur = null; pk.q = ''
  const q = document.querySelector('[data-on="pk.q"]'); if (q) q.value = ''
  drawPkPick(); drawPkCur(); drawPkItems()
}
ACT['pk.remove'] = (el) => { pk.items.splice(Number(el.dataset.i), 1); drawPkItems() }
function drawPkCats() { setHtml('pk-cats', ['All', ...Object.keys(CAT)].map((c) => `<span class="chip ${pk.cat === c ? 'on' : ''}" data-act="pk.cat" data-v="${esc(c)}">${esc(c)}</span>`).join('')) }
function drawPkPick() {
  const t = pk.q.trim(), lt = t.toLowerCase()
  const all = Object.entries(CAT).filter(([c]) => pk.cat === 'All' || c === pk.cat).flatMap(([, a]) => a)
  const list = (lt ? all.filter((x) => x.toLowerCase().includes(lt)) : all).slice(0, lt ? 30 : 18)
  setHtml('pk-pick', list.map((x) => `<span class="chip" data-act="pk.type" data-v="${esc(x)}">${esc(x)}</span>`).join('') +
    (t && !list.some((x) => x.toLowerCase() === lt) ? `<span class="chip on" data-act="pk.type" data-v="${esc(t)}">+ Use “${esc(t)}”</span>` : ''))
}
function drawPkCur() {
  const c = pk.cur
  setHtml('pk-cur', !c ? '' : `<div class="draft"><b>${esc(c.type)}</b>
    <div class="two"><div><label>Quantity</label><input type="number" min="1" max="99" data-on="pk.cur" data-ev="input" data-k="qty" value="${c.qty}"></div>
    <div><label>Colour</label><input data-on="pk.cur" data-ev="input" data-k="color" value="${esc(c.color)}" maxlength="60"></div></div>
    <label>Anything we should know? (stains, tears…)</label><textarea rows="2" data-on="pk.cur" data-ev="input" data-k="desc" maxlength="300">${esc(c.desc)}</textarea>
    <label>Photo of this item (camera or upload)</label><input type="file" accept="image/*" capture="environment" data-on="pk.photo">
    ${c.preview ? `<img class="ph big" src="${esc(c.preview)}" alt="">` : ''}<div class="mt"><button class="g" data-act="pk.add">Add this item</button></div></div>`)
}
function drawPkItems() {
  setHtml('pk-count', `Your items (${pk.items.length})`)
  setHtml('pk-items', pk.items.length ? pk.items.map((g, i) => `<div class="it row">${g.preview ? `<img class="ph" src="${esc(g.preview)}" alt="">` : '<div class="ph">👕</div>'}
    <div class="g1"><b>${g.qty} × ${esc(g.type)}</b><div class="muted">${esc([g.color, g.desc].filter(Boolean).join(' · '))}</div></div><button class="s" data-act="pk.remove" data-i="${i}">✕</button></div>`).join('') : '<p class="muted">No items added yet.</p>')
}
ACT['pk.send'] = async (btn) => {
  formErr('')
  const hasContact = pk.email.trim().includes('@') || pk.whatsapp.replace(/\D/g, '').length >= 9 || pk.sms.replace(/\D/g, '').length >= 9
  if (!pk.items.length) return formErr('Add at least one item.')
  if (pk.name.trim().length < 2) return formErr('Enter your name.')
  if (!hasContact) return formErr('Enter an email, a WhatsApp number or an SMS number so the shop can send your invoice.')
  btn.disabled = true; btn.textContent = 'Sending…'
  const branch = location.pathname.split('/').pop(), rid = newId()
  try {
    const items = []
    for (let i = 0; i < pk.items.length; i++) {
      const it = pk.items[i]; let photo = null
      if (it.file) { btn.textContent = `Uploading photo ${i + 1} of ${pk.items.length}…`; photo = `pickup/${branch}/${rid}/${i}.jpg`; await uploadAnon(photo, await compressImage(it.file)) }
      items.push({ type: it.type, qty: it.qty, color: it.color, description: it.desc, photo_path: photo })
    }
    await rpcPublic('submit_pickup', { p_request: rid, p_branch: branch, p_name: pk.name.trim(), p_email: pk.email.trim(), p_whatsapp: pk.whatsapp.trim(), p_sms: pk.sms.trim(), p_how: pk.how, p_note: pk.note.trim(), p_items: items })
    sent = '✅ Sent! The shop has been notified. They will review your items, add prices and send your invoice by the contact you gave.'; drawForm()
  } catch (e) { btn.disabled = false; btn.textContent = '🧺 Pick up my items'; formErr(e.offline ? 'You are offline. Connect and try again.' : e.message) }
}
ACT['dobi.send'] = async (form) => {
  const f = formData(form)
  if (f.phone.replace(/\D/g, '').length < 9) return formErr('Enter a valid phone number.', form)
  formErr('', form); busy(form, true, 'Sending…')
  try {
    await rpcPublic('submit_request', { p_branch: location.pathname.split('/').pop(), p_kind: 'cb', p_name: f.name.trim(), p_phone: f.phone.trim(), p_note: (f.note || '').trim(), p_how: '' })
    sent = '✅ Sent! The shop has been notified and will call you back.'; drawForm()
  } catch (e) { busy(form, false); formErr(e.offline ? 'You are offline. Connect and try again.' : e.message, form) }
}

// ================= Support / Partner with us (anyone, no account) =================
route('/support', (_p, q) => {
  const partner = q.get('kind') === 'partner'
  return shell(`${backBtn('/')}<div class="card mt"><h2>${partner ? 'Partner with us' : 'Contact Smart Dobi'}</h2>
    <p class="muted">${partner ? 'Tell us about your business and how you would like to work with Smart Dobi.' : 'Having a problem or a question? Send us a message and we will reply.'}</p>
    <div id="sup-box"><form data-act="support.send"><label>I want to</label><select name="kind"><option value="support" ${partner ? '' : 'selected'}>Get support</option><option value="partner" ${partner ? 'selected' : ''}>Partner with Smart Dobi</option></select>
      <label>Your name</label><input name="name" maxlength="80"><label>Email</label><input name="email" type="email" maxlength="120">
      <label>Phone / WhatsApp</label><input name="phone" inputmode="tel" maxlength="20"><label>Message</label><textarea name="message" rows="5" required minlength="5" maxlength="2000"></textarea>
      <input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
      <div class="note formerr" hidden></div><button class="p mt">Send message</button></form></div></div>`)
}, { kind: 'public' })
ACT['support.send'] = async (form) => {
  const f = formData(form)
  const done = () => { const b = document.getElementById('sup-box'); if (b) b.innerHTML = '<div class="ok">✅ Thank you! Your message has reached the Smart Dobi team. We will reply by the email or phone you gave.</div>' }
  if (f.website) return done() // a robot filled the hidden field: pretend it worked
  formErr('', form); busy(form, true, 'Sending…')
  try { await rpcPublic('submit_support', { p_kind: f.kind, p_name: f.name || '', p_email: f.email || '', p_phone: f.phone || '', p_message: f.message }); done() } catch (e) { busy(form, false); formErr(e.offline ? 'You are offline. Connect and try again.' : e.message, form) }
}

// ================= Customer tracking page =================
let trackToken = ''
const trackHtml = (t) => {
  const total = t.garments.length, ready = t.garments.filter((g) => g.status === 'ready').length, back = t.garments.filter((g) => g.status === 'returned').length, done = ready + back
  return `<div class="muted">${esc(t.business)} · Order ${esc(t.order_no)}</div><h2>Hello ${esc(t.customer)} 👋</h2>
  <div class="muted">Received ${fmt(t.received_at)} · Updated ${fmt(t.updated_at)}</div>
  <div class="hero"><div class="bigno">${done} / ${total}</div><div>${back === total && total > 0 ? 'All collected. Thank you!' : `${ready} ready for pickup · ${total - done} in progress · ${back} collected`}</div>
    <div class="bar"><i data-w="${total ? Math.round((done / total) * 100) : 0}"></i></div></div>
  ${t.garments.map((g) => {
    const pct = g.status === 'returned' ? 100 : Math.max(0, Math.round((PROGRESS.indexOf(g.status) / (PROGRESS.length - 1)) * 100))
    return `<div class="card tight">${g.photo ? `<img class="gimg" src="${esc(photoUrl(g.photo))}" alt="${esc(g.type)}">` : '<div class="nop">👕 No photo</div>'}
      <div class="row"><b class="g1">${g.qty} × ${esc(g.type)}</b>${badge(g.status)}</div><div class="muted">${esc([g.color, g.description].filter(Boolean).join(' · '))}</div><div class="bar"><i data-w="${pct}"></i></div></div>`
  }).join('')}
  <p class="muted center">Please check the list and contact us if anything is incorrect.<br>${esc([t.business, t.phone, t.email].filter(Boolean).join(' · '))}<br>Powered by Smart Dobi</p>`
}
const fillBars = () => document.querySelectorAll('#track-root .bar i[data-w]').forEach((i) => { i.style.width = i.dataset.w + '%' })
async function loadTrack() {
  const t = await rpcPublic('track_order', { p_token: trackToken })
  return t ? trackHtml(t) : '<div class="card"><h2>Link unavailable</h2><p class="muted">This tracking link has expired or is not valid. Please contact your laundry.</p></div>'
}
route('/track/:token', async ({ token }) => {
  trackToken = token
  let html
  try { html = await loadTrack() } catch (e) { html = `<div class="card"><h2>Cannot load</h2><p class="muted">${e.offline ? 'No internet connection.' : 'Please try again.'}</p></div>` }
  return `<div class="track" id="track-root">${html}</div>`
}, { kind: 'public', after: () => {
  fillBars()
  timers.push(setInterval(async () => {
    try { const html = await loadTrack(); const r = document.getElementById('track-root'); if (r) { r.innerHTML = html; fillBars() } } catch { /* keep the last view */ }
  }, 30000))
} })
