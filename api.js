// api.js - talks to Supabase using plain fetch. No third-party code.
import { SUPABASE_URL, SUPABASE_KEY } from './config.js'

const SKEY = 'sd_session'
let session = null
try { session = JSON.parse(localStorage.getItem(SKEY) || 'null') } catch { session = null }
const listeners = new Set()
export const onAuth = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
function save(s) {
  session = s
  try { if (s) localStorage.setItem(SKEY, JSON.stringify(s)); else localStorage.removeItem(SKEY) } catch { /* storage blocked */ }
  listeners.forEach((l) => l(session))
}
export const getSession = () => session
export const isOfflineError = (e) => !!(e && e.offline)

const toSession = (j) => ({
  access_token: j.access_token, refresh_token: j.refresh_token,
  expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600),
  user: { id: j.user && j.user.id, email: j.user && j.user.email },
})

async function raw(path, o = {}) {
  const isBlob = typeof Blob !== 'undefined' && o.body instanceof Blob
  let res
  try {
    res = await fetch(SUPABASE_URL + path, {
      method: o.method || 'GET',
      headers: {
        apikey: SUPABASE_KEY, ...(o.token ? { Authorization: 'Bearer ' + o.token } : {}),
        ...(o.body !== undefined && !isBlob ? { 'Content-Type': 'application/json' } : {}), ...(o.headers || {}),
      },
      body: o.body === undefined ? undefined : isBlob ? o.body : JSON.stringify(o.body),
    })
  } catch {
    const e = new Error('No internet connection'); e.offline = true; throw e
  }
  const text = await res.text()
  let data = null
  if (text) { try { data = JSON.parse(text) } catch { data = text } }
  if (!res.ok) {
    const msg = data && typeof data === 'object' ? data.message || data.msg || data.error_description || data.error : null
    const e = new Error(msg || `Request failed (${res.status})`); e.status = res.status; e.code = data && data.code
    throw e
  }
  return data
}

let refreshing = null
async function refreshNow() {
  try {
    save(toSession(await raw('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: session.refresh_token } })))
  } catch (e) {
    if (!e.offline && [400, 401, 403].includes(e.status)) save(null) // session truly expired: sign out
  }
}
async function accessToken() {
  if (!session) return null
  if (Date.now() < session.expires_at * 1000 - 60000) return session.access_token
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return session.access_token
  if (!refreshing) refreshing = refreshNow().finally(() => { refreshing = null })
  await refreshing
  return session ? session.access_token : null
}
async function authed(path, o = {}) {
  try {
    return await raw(path, { ...o, token: await accessToken() })
  } catch (e) {
    if (e.status === 401 && session) { await refreshNow(); return raw(path, { ...o, token: session ? session.access_token : null }) }
    throw e
  }
}

export async function signUp(email, password) {
  const j = await raw('/auth/v1/signup', { method: 'POST', body: { email, password } })
  if (!j || !j.access_token) return { needsConfirm: true }
  save(toSession(j)); return { needsConfirm: false }
}
export async function signIn(email, password) {
  save(toSession(await raw('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } })))
}
export async function signOut() {
  try { if (session) await raw('/auth/v1/logout', { method: 'POST', token: session.access_token }) } catch { /* ignore */ }
  save(null)
}

export const rpc = (fn, args) => authed('/rest/v1/rpc/' + fn, { method: 'POST', body: args || {} })
export const rpcPublic = (fn, args) => raw('/rest/v1/rpc/' + fn, { method: 'POST', body: args || {} })
export const select = async (table, query) => (await authed(`/rest/v1/${table}?${query}`)) || []
export const insert = (table, row) => authed('/rest/v1/' + table, { method: 'POST', body: row, headers: { Prefer: 'return=minimal' } })
export const update = (table, filter, patch) => authed(`/rest/v1/${table}?${filter}`, { method: 'PATCH', body: patch, headers: { Prefer: 'return=minimal' } })
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/')
export const uploadPhoto = (path, blob) => authed('/storage/v1/object/garment-photos/' + encPath(path), { method: 'POST', body: blob, headers: { 'x-upsert': 'true' } })
// a customer (no account) uploading a pickup photo: the database only allows the pickup/<shop>/<request>/ folder of a listed shop
export const uploadAnon = (path, blob) => raw('/storage/v1/object/garment-photos/' + encPath(path), { method: 'POST', body: blob })
export const uploadProof = (path, blob) => authed('/storage/v1/object/payment-proofs/' + encPath(path), { method: 'POST', body: blob })
export async function signedUrl(bucket, path) {
  const r = await authed(`/storage/v1/object/sign/${bucket}/${encPath(path)}`, { method: 'POST', body: { expiresIn: 3600 } })
  return SUPABASE_URL + '/storage/v1' + r.signedURL
}
export const removePhotos = (paths) => authed('/storage/v1/object/garment-photos', { method: 'DELETE', body: { prefixes: paths } })
export const photoUrl = (path) => (path ? `${SUPABASE_URL}/storage/v1/object/public/garment-photos/${encPath(path)}` : '')
