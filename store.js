// store.js - money data kept ON THIS DEVICE first, uploaded to the server only when you sync.
import { rpc, select } from './api.js'
import { newId, one } from './util.js'

const DEFAULTS = { mode: 'manual', minutes: 60, time: '18:00' }
let state = {
  biz: null, orders: [], payments: [], expenses: [], queue: [], failed: [],
  settings: { ...DEFAULTS }, lastSync: null, syncing: false,
}
const listeners = new Set()
export const onStore = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
const emit = () => listeners.forEach((l) => l(state))
export const getMoney = () => state
export const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false
const key = (b) => `sd_money_${b}`
function persist() {
  if (!state.biz) return
  try {
    const { orders, payments, expenses, queue, failed, settings, lastSync } = state
    localStorage.setItem(key(state.biz), JSON.stringify({ orders, payments, expenses, queue, failed, settings, lastSync }))
  } catch { /* storage full: data stays in memory for this session */ }
}
export function loadStore(biz) {
  if (state.biz === biz) return
  let saved = null
  try { saved = JSON.parse(localStorage.getItem(key(biz)) || 'null') } catch { saved = null }
  state = {
    ...state, biz, orders: (saved && saved.orders) || [], payments: (saved && saved.payments) || [],
    expenses: (saved && saved.expenses) || [], queue: (saved && saved.queue) || [], failed: (saved && saved.failed) || [],
    settings: { ...DEFAULTS, ...((saved && saved.settings) || {}) }, lastSync: (saved && saved.lastSync) || null,
  }
  emit()
}
export function queueOp(op) {
  const full = { ...op, id: op.id || newId(), at: new Date().toISOString() }
  let queue = state.queue
  if (full.type === 'price') queue = queue.filter((o) => !(o.type === 'price' && o.garment_id === full.garment_id))
  state = { ...state, queue: [...queue, full] }
  persist(); emit()
  return full.id
}
export function discardFailed(id) { state = { ...state, failed: state.failed.filter((f) => f.id !== id) }; persist(); emit() }
export function setSettings(p) { state = { ...state, settings: { ...state.settings, ...p } }; persist(); emit() }

/** Server copy from the last sync, with everything still waiting to sync applied on top. */
export function merged(s) {
  const orders = s.orders.map((o) => ({ ...o, garments: o.garments.map((g) => ({ ...g })) }))
  const payments = s.payments.map((p) => ({ ...p }))
  const expenses = s.expenses.map((e) => ({ ...e }))
  for (const op of s.queue) {
    if (op.type === 'price') {
      for (const o of orders) { const g = o.garments.find((x) => x.id === op.garment_id); if (g) g.price = op.price }
    } else if (op.type === 'payment') {
      if (!payments.some((p) => p.id === op.id)) payments.push({ id: op.id, order_id: op.order_id, amount: op.amount, method: op.method, txn: op.txn || '', comment: op.comment || '', receipt_no: op.receipt_no, reversal_of: null, by: op.by || '', at: op.at, pending: true })
    } else if (op.type === 'reverse') {
      const o = payments.find((p) => p.id === op.payment_id)
      if (o && !payments.some((p) => p.id === op.id)) payments.push({ id: op.id, order_id: o.order_id, amount: -o.amount, method: o.method, txn: '', comment: 'Reversal', receipt_no: null, reversal_of: o.id, by: op.by || '', at: op.at, pending: true })
    } else if (op.type === 'expense') {
      if (!expenses.some((e) => e.id === op.id)) expenses.push({ id: op.id, branch_id: op.branch_id, spent_on: op.spent_on, category: op.category, amount: op.amount, method: op.method || '', description: op.description || '', by: op.by || '', void: false, pending: true })
    } else if (op.type === 'void_expense') {
      const e = expenses.find((x) => x.id === op.expense_id)
      if (e) { e.void = true; e.pending = true }
    }
  }
  return { orders, payments, expenses }
}
export const orderTotal = (o) => o.garments.filter((g) => g.status !== 'cancelled').reduce((s, g) => s + (g.price || 0) * g.qty, 0)
export const orderPaid = (orderId, pays) => pays.filter((p) => p.order_id === orderId).reduce((s, p) => s + p.amount, 0)
export const isReversed = (p, pays) => pays.some((x) => x.reversal_of === p.id)

let busy = false
let lastAttempt = 0
export async function syncNow(who) {
  const biz = state.biz
  if (!biz) return 'Not ready yet.'
  if (!isOnline()) return 'You are offline. Your changes stay safely on this device until you sync.'
  if (busy) return 'A sync is already running.'
  busy = true; lastAttempt = Date.now(); state = { ...state, syncing: true }; emit()
  let sent = 0
  try {
    const q = state.queue.slice(0, 500)
    if (q.length) {
      const res = (await rpc('sync_money', { p_business: biz, p_who: who || '', p_ops: q })) || []
      const bad = new Map(res.filter((r) => !r.ok).map((r) => [r.id, r.error || 'Rejected by the server']))
      const answered = new Set(res.map((r) => r.id))
      const okOps = q.filter((o) => answered.has(o.id) && !bad.has(o.id))
      const folded = merged({ orders: state.orders, payments: state.payments, expenses: state.expenses, queue: okOps })
      sent = okOps.length
      state = {
        ...state, orders: folded.orders, payments: folded.payments.map((p) => ({ ...p, pending: false })),
        expenses: folded.expenses.map((e) => ({ ...e, pending: false })),
        queue: state.queue.filter((o) => !answered.has(o.id)),
        failed: [...state.failed, ...q.filter((o) => bad.has(o.id)).map((o) => ({ ...o, error: bad.get(o.id) }))],
      }
      persist()
    }
    const [o, p, e] = await Promise.all([
      select('orders', 'select=id,order_no,branch_id,created_at,closed_at,customers(name),garments(id,type,qty,status,unit_price_ugx)&order=created_at.desc&limit=1000'),
      select('payments', 'select=id,order_id,amount_ugx,method,txn_id,comment,receipt_no,reversal_of,recorded_by_name,at&order=at.desc&limit=5000'),
      select('expenses', 'select=id,branch_id,spent_on,category,amount_ugx,method,description,recorded_by,void_at&order=spent_on.desc&limit=2000'),
    ])
    state = {
      ...state,
      orders: o.map((r) => ({
        id: r.id, order_no: r.order_no, branch_id: r.branch_id, created_at: r.created_at, closed_at: r.closed_at,
        customer: (one(r.customers) || {}).name || 'Customer',
        garments: (r.garments || []).map((g) => ({ id: g.id, type: g.type, qty: g.qty, status: g.status, price: g.unit_price_ugx == null ? null : Number(g.unit_price_ugx) })),
      })),
      payments: p.map((r) => ({ id: r.id, order_id: r.order_id, amount: Number(r.amount_ugx), method: r.method, txn: r.txn_id || '', comment: r.comment || '', receipt_no: r.receipt_no, reversal_of: r.reversal_of, by: r.recorded_by_name || '', at: r.at })),
      expenses: e.map((r) => ({ id: r.id, branch_id: r.branch_id, spent_on: r.spent_on, category: r.category, amount: Number(r.amount_ugx), method: r.method || '', description: r.description || '', by: r.recorded_by || '', void: !!r.void_at })),
      lastSync: new Date().toISOString(),
    }
    return sent ? `Synced. Sent ${sent} change(s) and downloaded the latest data.` : 'Up to date. Downloaded the latest data.'
  } catch (err) {
    return `Sync did not finish: ${err.message}. Your changes are still saved on this device.`
  } finally {
    busy = false; state = { ...state, syncing: false }; persist(); emit()
  }
}

/** Runs only while the app is open. Follows the schedule chosen on the Sync page. */
export function startAutoSync(getWho) {
  return setInterval(() => {
    const s = state
    if (!s.biz || s.syncing || s.settings.mode === 'manual' || !isOnline()) return
    const now = Date.now(), last = s.lastSync ? new Date(s.lastSync).getTime() : 0
    if (now - lastAttempt < 5 * 60000) return
    if (s.settings.mode === 'interval' && now - last >= s.settings.minutes * 60000) void syncNow(getWho())
    if (s.settings.mode === 'daily') {
      const [h, m] = String(s.settings.time || '18:00').split(':').map(Number)
      const due = new Date(); due.setHours(h || 0, m || 0, 0, 0)
      if (now >= due.getTime() && last < due.getTime()) void syncNow(getWho())
    }
  }, 30000)
}

// ---- Offline PIN: a PIN already accepted online also works offline on this device (convenience lock only)
const hexb = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('')
const digest = async (s) => hexb(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
export async function rememberPin(scope, pin) {
  try {
    const salt = hexb(crypto.getRandomValues(new Uint8Array(16)))
    localStorage.setItem('sd_pin_' + scope, JSON.stringify({ salt, hash: await digest(`${salt}:${pin}`) }))
  } catch { /* ignore */ }
}
/** true = correct, false = wrong or locked, null = this device never saw this PIN online */
export async function checkLocalPin(scope, pin) {
  try {
    const lockKey = 'sd_pinlock_' + scope, failKey = 'sd_pinfail_' + scope
    if (Date.now() < Number(localStorage.getItem(lockKey) || 0)) return false
    const raw = localStorage.getItem('sd_pin_' + scope)
    if (!raw) return null
    const { salt, hash } = JSON.parse(raw)
    if ((await digest(`${salt}:${pin}`)) === hash) { localStorage.removeItem(failKey); return true }
    const n = Number(localStorage.getItem(failKey) || 0) + 1
    localStorage.setItem(failKey, String(n))
    if (n >= 5) { localStorage.setItem(lockKey, String(Date.now() + 10 * 60000)); localStorage.setItem(failKey, '0') }
    return false
  } catch { return false }
}
