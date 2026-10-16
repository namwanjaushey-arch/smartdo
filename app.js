// app.js - starts the app, handles sign-in, setup, the shop PIN screen, the menu and navigation.
import { getSession, onAuth, signIn, signUp, signOut, rpc, select, isOfflineError, checkConnection } from './api.js'
import { S, loadBiz, loadAcct, forgetAcct, forgetBiz, enterBranch, leaveBranch, isAdmin, unlockAdmin, lockAdmin, route, match, ACT, ON, go, rerender, clearTimers, toast, formData, formErr, busy } from './core.js'
import { esc, LOGO, WORDMARK, PIN_RE } from './util.js'
import { loadStore, onStore, getMoney, syncNow, startAutoSync, rememberPin, checkLocalPin, queueOp, isOnline } from './store.js'
import { runCleanup } from './shop.js'
import './money.js'
import './public.js'
import { ADMIN_NAV } from './admin.js'
import './upgrade.js'

// ---------- sign in / sign up ----------
let authMode = 'up'
route('/auth', () => `<div class="app"><div class="card center narrow">
  <div class="logo-big">${LOGO(64)}</div>${WORDMARK}
  <h2>${authMode === 'up' ? 'Create your shop account' : 'Shop sign-in'}</h2>
  <form data-act="auth.submit" class="left">
    <label>Email</label><input name="email" type="email" required autocomplete="email">
    <label>Password (8 or more characters)</label><input name="password" type="password" required minlength="8" autocomplete="${authMode === 'up' ? 'new-password' : 'current-password'}">
    <div class="note formerr" hidden></div>
    <button class="p mt">${authMode === 'up' ? 'Create account' : 'Sign in'}</button>
  </form>
  <p class="muted"><a href="#" data-act="auth.mode">${authMode === 'up' ? 'Already have an account? Sign in' : 'New here? Create an account'}</a></p>
  <p class="muted"><a href="/" data-link>← Back to home</a></p></div></div>`, { kind: 'bare' })
ACT['auth.mode'] = () => { authMode = authMode === 'up' ? 'in' : 'up'; rerender() }
ACT['auth.submit'] = async (form) => {
  const { email, password } = formData(form)
  formErr('', form); busy(form, true)
  try {
    if (authMode === 'up') {
      const r = await signUp(email.trim(), password)
      if (r.needsConfirm) { busy(form, false); authMode = 'in'; rerender(); return toast('Account created. Check your email to confirm it, then sign in.') }
    } else await signIn(email.trim(), password)
    await routeByRole()
  } catch (e) { busy(form, false); formErr(e.message, form) }
}

// The ONE login for everyone: after signing in, the server says who this is and we send them to the right place.
async function routeByRole() {
  const a = await loadAcct()
  if (a && a.platform_role) return go('/admin')
  if (a && a.business) {
    if (a.business.status === 'suspended') return go('/suspended')
    if (a.business.status === 'restricted') return go('/upgrade')
    await loadBiz()
    return go(S.biz ? '/gate' : '/setup')
  }
  if (!a) { await loadBiz(); return go(S.biz ? '/gate' : '/auth') }
  return go('/setup')
}
function adminShell(path) {
  return `<div class="app"><header>${LOGO(36)} ${WORDMARK}<span class="badge pu">Platform · ${esc(S.acct.platform_role)}</span><span class="push"><button class="s" data-act="auth.logout">Sign out</button></span></header>
  <nav class="adm">${ADMIN_NAV.map(([to, t]) => `<a href="${to}" data-link class="${path === to ? 'on' : ''}">${t}</a>`).join('')}${S.acct.business ? '<a href="/gate" data-link>My shop</a>' : ''}</nav>
  <div class="muted who">${esc(S.acct.email || '')}</div><main id="view"><p class="muted">Loading…</p></main></div>`
}

// ---------- first-time setup ----------
route('/setup', () => `<div class="app"><form class="card narrow" data-act="setup.submit">
  <h2>Set up your laundry</h2>
  <label>Laundry name</label><input name="name" required maxlength="80">
  <label>Owner name</label><input name="owner" required maxlength="80">
  <div class="two"><div><label>Owner phone</label><input name="phone" inputmode="tel" maxlength="20"></div><div><label>Owner email</label><input name="email" type="email" maxlength="80"></div></div>
  <label>Admin PIN (4–5 digits). Protects money, staff and the audit trail</label><input name="adminPin" type="password" inputmode="numeric" maxlength="5" required autocomplete="off">
  <label>First shop / branch name</label><input name="branch" required maxlength="80">
  <label>Branch PIN (4–5 digits)</label><input name="branchPin" type="password" inputmode="numeric" maxlength="5" required autocomplete="off">
  <div class="note formerr" hidden></div><button class="p mt">Create business</button>
  <p class="muted"><a href="#" data-act="auth.out">Use a different account</a></p></form></div>`, { kind: 'bare' })
ACT['auth.out'] = async () => { await signOut(); forgetBiz(); forgetAcct(); leaveBranch(); go('/') }
ACT['setup.submit'] = async (form) => {
  const f = formData(form)
  if (!PIN_RE.test(f.adminPin) || !PIN_RE.test(f.branchPin)) return formErr('PINs must be 4 or 5 digits.', form)
  formErr('', form); busy(form, true, 'Creating…')
  try {
    await rpc('create_business', { p_name: f.name.trim(), p_owner: f.owner.trim(), p_branch: f.branch.trim(), p_admin_pin: f.adminPin, p_branch_pin: f.branchPin, p_phone: f.phone.trim(), p_email: f.email.trim() })
    const b = await loadBiz()
    await loadAcct()
    if (!b) throw new Error('Created, but could not load your business. Please sign in again.')
    await rememberPin('admin:' + b.id, f.adminPin); await rememberPin('branch:' + b.branches[0].id, f.branchPin)
    enterBranch(b.branches[0].id, f.owner.trim())
    go('/app')
  } catch (e) { busy(form, false); formErr(e.message, form) }
}

// ---------- choose shop + branch PIN ----------
let gateShop = ''
const whoOptions = (shop) => {
  const names = [S.biz.owner_name || 'Owner', ...S.biz.workers.filter((w) => w.branch_id === shop).map((w) => w.name)]
  return names.map((n) => `<option>${esc(n)}</option>`).join('')
}
route('/gate', (_p, q) => {
  gateShop = q.get('shop') || gateShop || ''
  return `<div class="app"><div class="card center narrow"><div class="logo-big">${LOGO(64)}</div>${WORDMARK}
  <p class="muted">${esc(S.biz.name)}</p>
  <form data-act="gate.submit" class="left">
    <label>Shop</label><select name="shop" required data-on="gate.shop"><option value="" disabled ${gateShop ? '' : 'selected'}>Choose your shop</option>
      ${S.biz.branches.map((b) => `<option value="${esc(b.id)}" ${b.id === gateShop ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>
    <label>Branch PIN</label><input name="pin" type="password" inputmode="numeric" maxlength="5" required autocomplete="off" class="pin">
    <label>Who is working?</label><select name="who" id="who">${gateShop ? whoOptions(gateShop) : ''}</select>
    <div class="note formerr" hidden></div><button class="p mt">Enter</button>
  </form>
  <p class="muted"><a href="#" data-act="auth.out">Sign out of company account</a></p></div></div>`
}, { kind: 'bare', needsBiz: true })
ON['gate.shop'] = (el) => { gateShop = el.value; const w = document.getElementById('who'); if (w) w.innerHTML = whoOptions(gateShop) }
ACT['gate.submit'] = async (form) => {
  const f = formData(form), shop = f.shop, name = f.who || S.biz.owner_name || 'Owner'
  formErr('', form); busy(form, true, 'Checking…')
  let ok = false, offlineEntry = false
  try {
    ok = (await rpc('verify_branch_pin', { p_branch: shop, p_pin: f.pin })) === true
    if (ok) await rememberPin('branch:' + shop, f.pin)
  } catch (e) {
    if (isOfflineError(e)) {
      const r = await checkLocalPin('branch:' + shop, f.pin)
      if (r === null) { busy(form, false); return formErr('You are offline and this device has not opened this shop before. Connect once, then it works offline.', form) }
      ok = r; offlineEntry = true
    } else { busy(form, false); return formErr(e.message, form) }
  }
  busy(form, false)
  if (!ok) return formErr('Wrong PIN.', form)
  enterBranch(shop, name)
  await loadAcct() // picks up any plan or feature changes made by the platform
  loadStore(S.biz.id)
  if (offlineEntry) queueOp({ type: 'audit', branch_id: shop, action: 'entered_branch', who: name, detail: { offline: true } })
  else rpc('log_event', { p_business: S.biz.id, p_branch: shop, p_who: name, p_action: 'entered_branch', p_detail: {} }).catch(() => undefined)
  go('/app')
}

// ---------- admin PIN (money, staff, audit) ----------
const adminCard = () => `<form class="card narrow center" data-act="admin.unlock"><h2>🔒 Admin PIN</h2>
  <p class="muted">Needed for money, reports, staff and the audit trail. Works offline after your first unlock on this device.</p>
  <input name="pin" type="password" inputmode="numeric" maxlength="5" required autocomplete="off" class="pin">
  <div class="note formerr" hidden></div><button class="p mt">Unlock</button></form>`
ACT['admin.unlock'] = async (form) => {
  const pin = formData(form).pin, scope = 'admin:' + S.biz.id
  formErr('', form); busy(form, true, 'Checking…')
  let ok = false
  try {
    ok = (await rpc('verify_admin_pin', { p_business: S.biz.id, p_pin: pin })) === true
    if (ok) await rememberPin(scope, pin)
  } catch (e) {
    if (isOfflineError(e)) {
      const r = await checkLocalPin(scope, pin)
      if (r === null) { busy(form, false); return formErr('You are offline and this device has not unlocked admin before. Connect once and unlock, then it works offline.', form) }
      ok = r
    } else { busy(form, false); return formErr(e.message, form) }
  }
  busy(form, false)
  if (!ok) return formErr('Wrong PIN.', form)
  unlockAdmin(); rerender()
}

// ---------- the signed-in screen frame ----------
const TABS = [['/app', '🏠', 'Overview'], ['/app/receive', '📥', 'Receive'], ['/app/orders', '📋', 'Orders'], ['/app/notifications', '🛎️', 'Requests']]
function appShell(path) {
  const tab = ([to, icon, text]) => `<a href="${to}" data-link class="${(to === '/app' ? path === '/app' : path.startsWith(to) || (to === '/app/notifications' && path.startsWith('/app/pickups'))) ? 'on' : ''}"><span class="ni">${icon}</span>${text}</a>`
  return `<div class="app">
  <header><button class="menu" data-act="menu" aria-label="Open menu">☰</button>${LOGO(36)} ${WORDMARK}
    <select class="hsel" data-on="shop.switch" aria-label="Shop">${S.biz.branches.map((b) => `<option value="${esc(b.id)}" ${b.id === S.branchId ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>
    <button class="bell" data-act="go" data-to="/app/notifications" aria-label="Requests">🔔<span id="bell-n" class="dot" hidden></span></button></header>
  <div class="muted who">👤 ${esc(S.who)} · ${esc(S.biz.name)}</div>
  <div id="syncbar" class="syncbar"></div>
  <main id="view"><p class="muted">Loading…</p></main>
  <nav>${TABS.map(tab).join('')}</nav><div id="drawer"></div></div>`
}
ON['shop.switch'] = (el) => { if (el.value !== S.branchId) go('/gate?shop=' + encodeURIComponent(el.value)) }
ACT.go = (el) => go(el.dataset.to)

function paintSyncbar() {
  const el = document.getElementById('syncbar')
  if (!el) return
  const m = getMoney(), on = isOnline()
  el.innerHTML = `<a href="/app/sync" data-link class="g1">${on ? '🟢 Online' : '🔴 Offline'} · ${m.queue.length ? m.queue.length + ' waiting to sync' : 'all synced'}${m.failed.length ? ' · ' + m.failed.length + ' need attention' : ''}</a>
    <button class="s" data-act="sync.now" ${!on || m.syncing ? 'disabled' : ''}>${m.syncing ? 'Syncing…' : 'Sync now'}</button>`
}
ACT['sync.now'] = async () => {
  toast('Syncing…')
  const msg = await syncNow(S.who || '')
  toast(msg, msg.startsWith('Sync did not'))
  if (['/app/sync', '/app/billing', '/app/reports', '/app/expenses'].some((p) => location.pathname.startsWith(p)) && !(document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName))) rerender()
}
let firstSyncDone = false
async function refreshBell() {
  try {
    const rows = await select('requests', `select=id&branch_id=eq.${encodeURIComponent(S.branchId)}&status=eq.new`)
    const el = document.getElementById('bell-n')
    if (el) { el.textContent = rows.length; el.hidden = rows.length === 0 }
  } catch { /* offline or not allowed: no badge */ }
}

let deferred = null
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e })
ACT.menu = () => {
  const L = (to, text) => `<a class="di" href="${to}" data-link>${text}</a>`
  document.getElementById('drawer').innerHTML = `<div class="ov" data-act="menu.close"></div><aside class="dr">
    <div class="logo-big">${LOGO(48)}</div>${WORDMARK}<div class="muted gap">${esc(S.biz.name)}</div>
    ${L('/app/billing', '🧾 Prices, invoices &amp; receipts 🔒')}${L('/app/expenses', '🧮 Expenses 🔒')}${L('/app/reports', '📊 Reports 🔒')}
    ${L('/upgrade', '⭐ Plan &amp; upgrade')}${L('/support', '💬 Support')}${L('/support?kind=partner', '🤝 Partner with us')}
    ${L('/app/sync', '🔄 Sync &amp; offline')}${L('/app/notifications', '🔔 Customer requests')}${L('/app/profile', '🌐 Public Dobi profile 🔒')}
    ${L('/app/staff', '👥 Staff &amp; shops 🔒')}${L('/app/audit', '🕵️ Audit trail 🔒')}${L('/', '🔎 Public directory')}
    ${S.acct && S.acct.platform_role ? L('/admin', '🛡️ Platform admin') : ''}
    <button class="di" data-act="admin.lock">🔒 Lock admin</button>
    ${deferred ? '<button class="di" data-act="install">📲 Install Smart Dobi</button>' : '<div class="di muted">📲 To install: Android Chrome ⋮ → Install app. iPhone Safari Share → Add to Home Screen.</div>'}
    <button class="s block" data-act="shop.leave">Switch shop / who is working</button>
    <button class="s block" data-act="auth.logout">Sign out of company account</button></aside>`
}
ACT['menu.close'] = () => { document.getElementById('drawer').innerHTML = '' }
ACT['admin.lock'] = () => { lockAdmin(); go('/app') }
ACT.install = async () => { if (deferred) { deferred.prompt(); deferred = null } }
ACT['shop.leave'] = () => { leaveBranch(); go('/gate') }
ACT['auth.logout'] = async () => { await signOut(); forgetBiz(); forgetAcct(); leaveBranch(); go('/') }

// ---------- the page switcher ----------
let token = 0
async function render() {
  const my = ++token
  clearTimers()
  const app = document.getElementById('app')
  const path = location.pathname.replace(/\/+$/, '') || '/'
  const m = match(path)
  if (!m) return go('/', true)
  const r = m.route, q = new URLSearchParams(location.search)
  try {
    if (r.kind === 'public') { app.innerHTML = await r.fn(m.params, q); return after(r, my) }
    if (!getSession()) {
      if (path === '/auth') { app.innerHTML = await r.fn(m.params, q); return after(r, my) }
      return go('/auth', true)
    }
    // a different person is signed in now: forget the previous person's shop and account
    if (S.bizUid && S.bizUid !== getSession().user.id) { forgetBiz(); forgetAcct(); leaveBranch() }
    if (S.acct && S.acct.user_id && S.acct.user_id !== getSession().user.id) { forgetAcct(); leaveBranch() }
    if (!S.acct) await loadAcct()
    if (my !== token) return
    if (path === '/auth') return routeByRole()
    if (r.kind === 'admin') {
      if (!S.acct || !S.acct.platform_role) return go('/', true)
      app.innerHTML = adminShell(path)
      const out = await r.fn(m.params, q)
      if (my !== token) return
      const v = document.getElementById('view'); if (v) v.innerHTML = out
      window.scrollTo(0, 0); return after(r, my)
    }
    if (S.acct && S.acct.business && S.acct.business.status === 'suspended' && path !== '/suspended') return go('/suspended', true)
    if (S.acct && S.acct.business && S.acct.business.status === 'restricted' && path !== '/upgrade') return go('/upgrade', true)
    if (!S.biz) await loadBiz()
    if (my !== token) return
    if (r.kind === 'bare') {
      if (path === '/setup' && S.biz) return go('/gate', true)
      if (r.needsBiz && !S.biz) return go('/setup', true)
      app.innerHTML = await r.fn(m.params, q); return after(r, my)
    }
    if (!S.biz) { app.innerHTML = `<div class="app"><div class="card"><h2>Cannot open yet</h2><p class="muted">${isOnline() ? 'Your business could not be loaded.' : 'You are offline and this device has not opened your business before. Connect once, then it works offline.'}</p><a class="p" href="/" data-link>Home</a></div></div>`; return }
    if (!S.branchId || !S.biz.branches.some((b) => b.id === S.branchId)) { leaveBranch(); return go('/gate', true) }
    loadStore(S.biz.id)
    app.innerHTML = appShell(path); paintSyncbar(); void refreshBell(); void runCleanup()
    if (!firstSyncDone && !getMoney().lastSync && isOnline()) { firstSyncDone = true; void syncNow(S.who || '') }
    const out = r.admin && !isAdmin() ? adminCard() : await r.fn(m.params, q)
    if (my !== token) return
    const v = document.getElementById('view'); if (v) v.innerHTML = out
    window.scrollTo(0, 0)
    after(r, my)
  } catch (e) {
    if (my !== token) return
    const box = document.getElementById('view') || app
    box.innerHTML = `<div class="card"><h2>Something went wrong</h2><p class="muted">${esc(e.message || 'Unknown error')}</p><a class="s" href="/app" data-link>Back to overview</a></div>`
  }
}
function after(r, my) { if (my === token && typeof r.after === 'function') r.after() }

// ---------- one set of listeners for the whole app ----------
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]')
  if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) { e.preventDefault(); go(a.getAttribute('href')); return }
  const el = e.target.closest('[data-act]')
  if (!el || el.tagName === 'FORM') return
  const fn = ACT[el.dataset.act]
  if (!fn) return
  e.preventDefault()
  Promise.resolve(fn(el, e)).catch((err) => toast(err.message || 'Something went wrong', true))
})
document.addEventListener('submit', (e) => {
  const f = e.target.closest('form[data-act]')
  if (!f) return
  e.preventDefault()
  const fn = ACT[f.dataset.act]
  if (fn) Promise.resolve(fn(f, e)).catch((err) => { busy(f, false); toast(err.message || 'Something went wrong', true) })
})
const onInput = (e) => {
  const el = e.target.closest('[data-on]')
  if (!el) return
  const want = el.dataset.ev || 'change'
  if (e.type !== want) return
  const fn = ON[el.dataset.on]
  if (fn) Promise.resolve(fn(el, e)).catch((err) => toast(err.message || 'Something went wrong', true))
}
document.addEventListener('input', onInput)
document.addEventListener('change', onInput)
window.addEventListener('popstate', render)
window.addEventListener('sd-route', render)
window.addEventListener('online', paintSyncbar)
window.addEventListener('offline', paintSyncbar)
onStore(paintSyncbar)
onAuth((s) => { if (!s && (location.pathname.startsWith('/app') || location.pathname.startsWith('/admin'))) { forgetBiz(); forgetAcct(); leaveBranch(); go('/auth', true) } })
startAutoSync(() => S.who || '')
// If the app cannot reach Supabase while the device is online, say so clearly instead of failing silently.
async function connectionBanner() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return
  const c = await checkConnection()
  if (c.reached) return
  const b = document.createElement('div'); b.className = 'connbar'
  b.innerHTML = '⚠️ This app cannot reach its server. <a href="/status" data-link>Run the connection check</a>'
  document.body.appendChild(b)
}
setTimeout(connectionBanner, 800)
if ('serviceWorker' in navigator) window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => undefined) })
render()
