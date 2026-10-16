// core.js - the shared state, the route table and the little helpers every screen uses.
import { getSession, select, rpc } from './api.js'
import { enc, one } from './util.js'

const ss = (k) => { try { return sessionStorage.getItem(k) } catch { return null } }
const BIZ_CACHE = 'sd_biz_cache'
export const S = { biz: null, bizUid: null, acct: null, features: {}, branchId: ss('sd_branch'), who: ss('sd_who') }

// Loads (and saves a copy of) your business, shops and workers so the app can open offline.
export async function loadBiz() {
  const sess = getSession()
  if (!sess) { S.biz = null; return null }
  try {
    const rows = await select('memberships', `select=businesses(id,name,owner_name,plan_id,phone,email,branches(id,name),workers(id,name,branch_id,active))&user_id=eq.${enc(sess.user.id)}&active=eq.true&limit=1`)
    const b = rows[0] ? one(rows[0].businesses) : null
    if (b) {
      b.workers = (b.workers || []).filter((w) => w.active !== false)
      try { localStorage.setItem(BIZ_CACHE, JSON.stringify({ uid: sess.user.id, biz: b })) } catch { /* ignore */ }
    }
    S.biz = b; S.bizUid = sess.user.id
    return b
  } catch {
    try {
      const c = JSON.parse(localStorage.getItem(BIZ_CACHE) || 'null')
      if (c && c.uid === sess.user.id) { S.biz = c.biz; S.bizUid = c.uid; return c.biz }
    } catch { /* ignore */ }
    S.biz = null
    return null
  }
}
export const forgetBiz = () => { S.biz = null; try { localStorage.removeItem(BIZ_CACHE) } catch { /* ignore */ } }
export function enterBranch(id, who) {
  S.branchId = id; S.who = who
  try { sessionStorage.setItem('sd_branch', id); sessionStorage.setItem('sd_who', who) } catch { /* ignore */ }
}
export function leaveBranch() {
  S.branchId = null; S.who = null
  try { sessionStorage.removeItem('sd_branch'); sessionStorage.removeItem('sd_who'); sessionStorage.removeItem('sd_adm') } catch { /* ignore */ }
}
const adminKey = () => (S.biz ? `${S.biz.id}:${S.branchId || ''}` : '')
export const isAdmin = () => ss('sd_adm') === adminKey() && !!S.biz
export const unlockAdmin = () => { try { sessionStorage.setItem('sd_adm', adminKey()) } catch { /* ignore */ } }
export const lockAdmin = () => { try { sessionStorage.removeItem('sd_adm') } catch { /* ignore */ } }
export const branchName = (id) => ((S.biz && S.biz.branches.find((b) => b.id === id)) || {}).name || ''

// ---- routes: route('/app/orders/:id', handler, { kind: 'app' | 'public' | 'bare', admin: true })
export const routes = []
export function route(pattern, fn, opts = {}) {
  const keys = []
  const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)' }) + '/?$')
  routes.push({ re, keys, fn, kind: 'app', ...opts })
}
export function match(path) {
  for (const r of routes) {
    const m = r.re.exec(path)
    if (m) return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) }
  }
  return null
}
export const ACT = {} // click and form handlers (data-act="name")
export const ON = {} // input and change handlers (data-on="name")
export const go = (path, replace = false) => {
  if (replace) history.replaceState({}, '', path); else history.pushState({}, '', path)
  window.dispatchEvent(new Event('sd-route'))
}
export const rerender = () => window.dispatchEvent(new Event('sd-route'))
export const setView = (html) => { const v = document.getElementById('view'); if (v) v.innerHTML = html }
export const timers = []
export const clearTimers = () => { while (timers.length) clearInterval(timers.pop()) }
export function toast(msg, bad = false) {
  let t = document.getElementById('toast')
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t) }
  t.textContent = msg; t.className = bad ? 'bad show' : 'show'
  clearTimeout(toast.h); toast.h = setTimeout(() => { t.className = '' }, 3500)
}
export const formData = (form) => Object.fromEntries(new FormData(form).entries())
export function formErr(msg, root) {
  const el = (root || document).querySelector('.formerr')
  if (el) { el.textContent = msg || ''; el.hidden = !msg } else if (msg) toast(msg, true)
}
export function busy(form, on, text) {
  const b = form && form.querySelector('button.p, button.g')
  if (!b) return
  if (on) { b.dataset.t = b.textContent; b.textContent = text || 'Please wait…'; b.disabled = true } else { b.textContent = b.dataset.t || b.textContent; b.disabled = false }
}

// ---- who is this account? (platform role, business status, plan features). Cached so the app opens offline.
const ACCT_CACHE = 'sd_acct_cache'
export async function loadAcct() {
  const sess = getSession()
  if (!sess) { S.acct = null; S.features = {}; return null }
  try {
    const a = await rpc('my_account')
    S.acct = a; S.features = (a && a.features) || {}
    try { localStorage.setItem(ACCT_CACHE, JSON.stringify({ uid: sess.user.id, acct: a })) } catch { /* ignore */ }
    return a
  } catch {
    try {
      const c = JSON.parse(localStorage.getItem(ACCT_CACHE) || 'null')
      if (c && c.uid === sess.user.id) { S.acct = c.acct; S.features = c.acct.features || {}; return c.acct }
    } catch { /* ignore */ }
    S.acct = null; S.features = {}
    return null
  }
}
export const forgetAcct = () => { S.acct = null; S.features = {}; try { localStorage.removeItem(ACCT_CACHE) } catch { /* ignore */ } }
export const hasFeature = (k) => !!(S.features && S.features[k])

// Goes to the page you came from (or a safe page if there is none).
ACT.back = (el) => { if (history.length > 1) history.back(); else go((el && el.dataset && el.dataset.fb) || '/') }
