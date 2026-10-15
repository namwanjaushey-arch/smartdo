// admin.js - the platform console for Smart Dobi staff (super admin and support). Same login as everyone else.
import { rpc, select, signedUrl } from './api.js'
import { S, route, ACT, ON, rerender, toast, formData, formErr, busy } from './core.js'
import { esc, fmt, fmtDay, U, priceLabel, hoursText } from './util.js'

export const ADMIN_NAV = [['/admin', 'Overview'], ['/admin/subscriptions', 'Subscriptions'], ['/admin/payments', 'Payments'], ['/admin/messages', 'Messages'], ['/admin/activity', 'Activity'], ['/admin/plans', 'Plans'], ['/admin/features', 'Features'], ['/admin/team', 'Team'], ['/admin/audit', 'Audit']]
const isSuper = () => !!S.acct && S.acct.platform_role === 'super_admin'
const readOnly = () => (isSuper() ? '' : '<div class="note">You have view-only access. Only a super admin can make changes.</div>')

// ---- overview ----
route('/admin', async () => {
  const s = await rpc('admin_stats')
  const tiles = [['Businesses', s.businesses], ['Active', s.active], ['Restricted (plan expired)', s.restricted], ['Suspended', s.suspended], ['New this week', s.new_7d], ['Shops (branches)', s.branches], ['Orders in total', s.orders], ['Orders this week', s.orders_7d], ['Payments to review', s.pending_payments], ['New messages', s.new_messages]]
  return `<h2>Platform overview</h2><p class="muted">Totals only. Customer details and garment photos are not shown here.</p>
  <div class="grid">${tiles.map(([l, n]) => `<div class="stat"><b>${Number(n) || 0}</b><span>${l}</span></div>`).join('')}</div>
  <div class="card mt"><b>Businesses by plan</b>${Object.entries(s.by_plan || {}).map(([k, n]) => `<div class="row it"><span class="g1">${esc(k)}</span><b>${Number(n)}</b></div>`).join('') || '<p class="muted">No businesses yet.</p>'}</div>`
}, { kind: 'admin' })

// ---- subscriptions: every shop, its plan, status and expiry ----
const stTone = (st) => (st === 'active' ? 'gr' : st === 'restricted' ? 'am' : 'rd')
route('/admin/subscriptions', async () => {
  const [rows, plans] = await Promise.all([rpc('admin_list_subscriptions'), select('plans', 'select=id,name,price_ugx&order=sort.asc')])
  return `<h2>Subscriptions (${rows.length})</h2>${readOnly()}${rows.length ? rows.map((b) => `<div class="card"><div class="row"><b class="g1">${esc(b.name)}</b><span class="badge ${stTone(b.status)}">${esc(b.status)}</span></div>
    <div class="muted">${esc(b.owner_email || 'no owner email')} · joined ${fmt(b.created_at)}</div>
    <div class="row mt"><span class="g1"><b>${esc(b.plan_name)}</b> · ${esc(priceLabel({ price_ugx: b.price_ugx }))}</span>${Number(b.price_ugx) === 0 ? '<span class="tag">FREE</span>' : ''}</div>
    <div class="muted">${b.plan_expires_at ? 'Paid until ' + esc(fmtDay(String(b.plan_expires_at).slice(0, 10))) : 'No expiry'}${b.last_payment ? ' · last payment ' + esc(b.last_payment.status) : ''}</div>
    ${b.status !== 'active' ? `<div class="note">${b.status === 'restricted' ? 'Restricted: this shop sees "your plan has expired, upgrade to continue".' : 'Suspended'}${b.reason ? ' · ' + esc(b.reason) : ''}</div>` : ''}
    ${isSuper() ? `<label>Plan</label><select data-on="adm.plan" data-b="${esc(b.id)}">${plans.map((p) => `<option value="${esc(p.id)}" ${p.id === b.plan_id ? 'selected' : ''}>${esc(p.name)}${Number(p.price_ugx) === 0 ? ' (free)' : ''}</option>`).join('')}</select>
      ${b.status === 'active' ? `<form class="mt" data-act="adm.restrict" data-b="${esc(b.id)}"><input name="reason" maxlength="300" placeholder="Reason (optional), e.g. Free plan expired"><button class="s block">Switch off plan (restrict this shop)</button></form>
        <form class="mt" data-act="adm.suspend" data-b="${esc(b.id)}"><input name="reason" required minlength="3" maxlength="300" placeholder="Reason for suspending"><button class="s block">Suspend this shop</button></form>`
        : `<button class="g block" data-act="adm.reactivate" data-b="${esc(b.id)}">Reactivate this shop</button>`}` : ''}</div>`).join('') : '<div class="card muted">No businesses yet.</div>'}`
}, { kind: 'admin' })
ON['adm.plan'] = async (el) => {
  if (!confirm('Change this business to the selected plan?')) return rerender()
  await rpc('admin_set_plan', { p_business: el.dataset.b, p_plan: el.value }); toast('Plan changed.'); rerender()
}
ACT['adm.restrict'] = async (form) => {
  if (!confirm('Switch off this shop\'s plan? Its staff will see "plan expired, upgrade to continue" until they pay or you reactivate it.')) return
  busy(form, true); try { await rpc('admin_set_status', { p_business: form.dataset.b, p_status: 'restricted', p_reason: formData(form).reason || '' }); toast('Shop restricted.'); rerender() } catch (e) { busy(form, false); toast(e.message, true) }
}
ACT['adm.suspend'] = async (form) => {
  if (!confirm('Suspend this business? Its staff will be locked out until you reactivate it.')) return
  busy(form, true); try { await rpc('admin_set_status', { p_business: form.dataset.b, p_status: 'suspended', p_reason: formData(form).reason }); toast('Business suspended.'); rerender() } catch (e) { busy(form, false); toast(e.message, true) }
}
ACT['adm.reactivate'] = async (el) => { await rpc('admin_set_status', { p_business: el.dataset.b, p_status: 'active', p_reason: '' }); toast('Shop reactivated.'); rerender() }

// ---- upgrade payments: review proof, approve or reject; edit the MTN / Airtel details shops see ----
route('/admin/payments', async () => {
  const [pending, all, methods] = await Promise.all([rpc('admin_list_payments', { p_status: 'pending' }), rpc('admin_list_payments', { p_status: 'all' }), rpc('admin_get_payment_methods')])
  const done = all.filter((p) => p.status !== 'pending').slice(0, 20)
  const mform = (m) => `<form class="card" data-act="adm.methodSave"><b>${esc(m.label || 'New payment method')}</b>
    <label>Method id ${m.id ? '(cannot change)' : '(lowercase, e.g. bank)'}</label><input name="id" required pattern="[a-z0-9_]{2,20}" maxlength="20" value="${esc(m.id || '')}" ${m.id ? 'readonly' : ''}>
    <label>Name shown to shops</label><input name="label" required maxlength="60" value="${esc(m.label || '')}">
    <label>Merchant code / number</label><input name="code" maxlength="40" value="${esc(m.code || '')}"><label>Account name</label><input name="account_name" maxlength="80" value="${esc(m.account_name || '')}">
    <div class="two"><div><label>Sort order</label><input name="sort" type="number" value="${Number(m.sort) || 0}"></div><label class="check"><input type="checkbox" name="active" ${m.active === false ? '' : 'checked'}> Show to shops</label></div>
    <div class="note formerr" hidden></div>${isSuper() ? '<button class="s block">Save</button>' : ''}</form>`
  return `<h2>Payments to review (${pending.length})</h2>${readOnly()}
  ${pending.length ? pending.map((p) => `<div class="card"><div class="row"><b class="g1">${esc(p.business)}</b><b>${U(p.amount_ugx)}</b></div>
    <div class="muted">${esc(p.owner_email || '')} · plan <b>${esc(p.plan_name)}</b> · ${esc(p.method)} · from ${esc(p.paying_number)} · Txn <b>${esc(p.txn_id)}</b> · ${fmt(p.created_at)}</div>
    <div id="pf-${esc(p.id)}"><button class="s mt" data-act="adm.proof" data-id="${esc(p.id)}" data-path="${esc(p.proof_path || '')}">View proof</button></div>
    ${isSuper() ? `<button class="g block" data-act="adm.approve" data-id="${esc(p.id)}">Approve and change plan</button>
      <form class="mt" data-act="adm.reject" data-id="${esc(p.id)}"><input name="reason" required minlength="3" maxlength="300" placeholder="Reason for rejecting (the shop will see this)"><button class="s block">Reject</button></form>` : ''}</div>`).join('') : '<div class="card muted">Nothing waiting for review.</div>'}
  ${done.length ? `<h2>Recently reviewed</h2><div class="card">${done.map((p) => `<div class="it"><b>${esc(p.business)}</b> · ${esc(p.plan_name)} · ${U(p.amount_ugx)} · <span class="badge ${p.status === 'approved' ? 'gr' : 'rd'}">${esc(p.status)}</span><div class="muted">${fmt(p.reviewed_at)}${p.reject_reason ? ' · ' + esc(p.reject_reason) : ''}</div></div>`).join('')}</div>` : ''}
  <h2>Payment details shops see</h2><p class="muted">These are the codes and names shown to a shop when it chooses a plan.</p>${methods.map(mform).join('')}${isSuper() ? mform({}) : ''}`
}, { kind: 'admin' })
ACT['adm.proof'] = async (el) => {
  if (!el.dataset.path) return toast('No proof was uploaded.', true)
  const url = await signedUrl('payment-proofs', el.dataset.path)
  const box = document.getElementById('pf-' + el.dataset.id)
  if (box) box.innerHTML = `<a href="${esc(url)}" target="_blank" rel="noopener"><img class="proofimg" src="${esc(url)}" alt="Payment proof"></a>`
}
ACT['adm.approve'] = async (el) => {
  if (!confirm('Approve this payment? The shop\'s plan changes and its access is restored at once.')) return
  await rpc('admin_review_payment', { p_id: el.dataset.id, p_approve: true, p_reason: '' }); toast('Approved. The shop has access.'); rerender()
}
ACT['adm.reject'] = async (form) => {
  busy(form, true); try { await rpc('admin_review_payment', { p_id: form.dataset.id, p_approve: false, p_reason: formData(form).reason }); toast('Rejected.'); rerender() } catch (e) { busy(form, false); toast(e.message, true) }
}
ACT['adm.methodSave'] = async (form) => {
  const fd = new FormData(form); formErr('', form); busy(form, true)
  try { await rpc('admin_save_payment_method', { p_id: String(fd.get('id') || '').trim(), p_label: String(fd.get('label') || '').trim(), p_code: String(fd.get('code') || ''), p_account_name: String(fd.get('account_name') || ''), p_active: fd.get('active') === 'on', p_sort: Number(fd.get('sort')) || 0 }); toast('Saved.'); rerender() } catch (e) { busy(form, false); formErr(e.message, form) }
}

// ---- messages from the Support and "Partner with us" forms ----
let msgF = 'new'
route('/admin/messages', async () => {
  const rows = await rpc('admin_list_messages', { p_status: msgF })
  const chips = [['new', 'New'], ['resolved', 'Resolved'], ['all', 'All']].map(([k, l]) => `<span class="chip ${msgF === k ? 'on' : ''}" data-act="adm.msgf" data-v="${k}">${l}</span>`).join('')
  return `<h2>Messages</h2><div class="chips">${chips}</div>${rows.length ? rows.map((m) => {
    const ph = String(m.phone || '').replace(/\D/g, '')
    return `<div class="card mt"><div class="row"><b class="g1">${m.kind === 'partner' ? '🤝 Partner' : '💬 Support'} · ${esc(m.name || 'No name')}</b><span class="badge ${m.status === 'new' ? 'am' : 'gr'}">${esc(m.status)}</span></div>
      <div class="muted">${fmt(m.created_at)}${m.business ? ' · shop: ' + esc(m.business) : ''}</div><p>${esc(m.message)}</p>
      <div class="two">${m.email ? `<a class="s" href="mailto:${esc(m.email)}">✉️ ${esc(m.email)}</a>` : ''}${ph ? `<a class="s" href="https://wa.me/${esc(ph)}" target="_blank" rel="noopener">💬 ${esc(m.phone)}</a>` : ''}</div>
      <button class="s block" data-act="adm.resolve" data-id="${esc(m.id)}" data-r="${m.status === 'new' ? '1' : '0'}">${m.status === 'new' ? 'Mark resolved' : 'Reopen'}</button></div>` }).join('') : '<div class="card muted mt">No messages here.</div>'}`
}, { kind: 'admin' })
ACT['adm.msgf'] = (el) => { msgF = el.dataset.v; rerender() }
ACT['adm.resolve'] = async (el) => { await rpc('admin_resolve_message', { p_id: el.dataset.id, p_resolved: el.dataset.r === '1' }); rerender() }

// ---- activity: which shops and people are active, and which are not ----
let actDays = 30
route('/admin/activity', async () => {
  const a = await rpc('admin_activity', { p_days: actDays })
  const now = Date.now(), ago = (t) => (t ? Math.floor((now - new Date(t).getTime()) / 864e5) : null)
  const label = (d) => (d === null ? ['Never active', 'rd'] : d <= 7 ? ['Active', 'gr'] : d <= 30 ? ['Quiet', 'am'] : ['Inactive', 'rd'])
  const shops = a.by_business || [], max = Math.max(1, ...(a.daily || []).map((d) => Number(d.events)))
  const totalEvents = shops.reduce((s, b) => s + Number(b.events), 0)
  return `<h2>Activity</h2><p class="muted">Counts of actions recorded in each shop's audit trail. No customer details are shown.</p>
  <select data-on="adm.days">${[7, 30, 90].map((d) => `<option value="${d}" ${actDays === d ? 'selected' : ''}>Last ${d} days</option>`).join('')}</select>
  <div class="grid mt"><div class="stat"><b>${totalEvents}</b><span>Actions recorded</span></div><div class="stat"><b>${shops.filter((b) => Number(b.events) > 0).length}</b><span>Shops with activity</span></div><div class="stat"><b>${shops.filter((b) => Number(b.events) === 0).length}</b><span>Shops with none</span></div></div>
  <h2 class="mt">By shop</h2>${shops.length ? shops.map((b) => { const d = ago(b.last_event), [t, tone] = label(d)
    return `<div class="card"><div class="row"><b class="g1">${esc(b.name)}</b><span class="badge ${tone}">${t}</span></div>
      <div class="muted">${esc(b.plan_id)} · ${esc(b.status)} · ${Number(b.events)} actions · ${Number(b.orders)} orders · ${d === null ? 'no activity yet' : d === 0 ? 'last active today' : 'last active ' + d + ' day(s) ago'}</div>
      <div class="muted">People: ${esc((b.people || []).join(', ') || '—')}</div></div>` }).join('') : '<div class="card muted">No shops yet.</div>'}
  <h2 class="mt">Per day</h2><div class="card">${(a.daily || []).length ? a.daily.map((d) => `<div class="dayrow"><span>${esc(fmtDay(String(d.day)))}</span><div class="bar"><i data-w="${Math.round((Number(d.events) / max) * 100)}"></i></div><b>${Number(d.events)}</b></div>`).join('') : '<p class="muted">No activity in this period.</p>'}</div>
  <h2 class="mt">What people do most</h2><div class="card">${(a.top_actions || []).map((t) => `<div class="row it"><span class="g1">${esc(String(t.action).replace(/_/g, ' '))}</span><b>${Number(t.n)}</b></div>`).join('') || '<p class="muted">Nothing yet.</p>'}</div>`
}, { kind: 'admin', after: () => document.querySelectorAll('.dayrow .bar i[data-w]').forEach((i) => { i.style.width = i.dataset.w + '%' }) })
ON['adm.days'] = (el) => { actDays = Number(el.value); rerender() }

// ---- plans (prices, limits and which features each plan includes) ----
let featKeys = []
const planForm = (p, feats) => {
  const ent = p.entitlements || {}
  return `<form class="card" data-act="adm.planSave" data-id="${esc(p.id || '')}"><div class="row"><b class="g1">${esc(p.id ? p.name : 'New plan')}</b>${p.id && Number(p.price_ugx) === 0 ? '<span class="tag">FREE</span>' : ''}${p.id ? `<span class="muted">id: ${esc(p.id)}</span>` : ''}</div>
    ${p.id ? '' : '<label>Plan id (lowercase, no spaces)</label><input name="id" required pattern="[a-z0-9_-]{2,30}" maxlength="30" placeholder="e.g. starter_plus">'}
    <label>Name</label><input name="name" required maxlength="60" value="${esc(p.name || '')}">
    <div class="two"><div><label>Price (UGX / month)</label><input name="price_ugx" type="number" min="0" required value="${Number(p.price_ugx) || 0}"></div><div><label>Sort order</label><input name="sort" type="number" value="${Number(p.sort) || 0}"></div></div>
    <div class="two"><div><label>Max shops</label><input name="max_branches" type="number" min="1" required value="${Number(p.max_branches) || 1}"></div><div><label>Workers per shop</label><input name="max_workers_per_branch" type="number" min="1" required value="${Number(p.max_workers_per_branch) || 3}"></div></div>
    <label>Delete order photos this many hours after an order is closed (e.g. 24 = one day, 168 = a week)</label><input name="retention_hours" type="number" min="1" required value="${Number(p.retention_hours) || 48}">
    <label>Features in this plan</label><div class="chips">${feats.map((f) => `<label class="chip"><input type="checkbox" name="feat" value="${esc(f.key)}" ${ent[f.key] ? 'checked' : ''}> ${esc(f.name)}</label>`).join('')}</div>
    <label class="check"><input type="checkbox" name="active" ${p.active === false ? '' : 'checked'}> Available to new customers</label>
    <div class="note formerr" hidden></div>${isSuper() ? `<button class="p mt">${p.id ? 'Save plan' : 'Create plan'}</button>` : ''}</form>`
}
route('/admin/plans', async () => {
  const [plans, feats] = await Promise.all([select('plans', 'select=*&order=sort.asc'), select('features', 'select=*&order=sort.asc')])
  featKeys = feats.map((f) => f.key)
  const def = await rpc('admin_default_plan')
  return `<h2>Plans</h2><p class="muted">Changes apply to every business on that plan straight away. Shop and worker limits and the photo-clearing days are enforced by the database. A plan with price 0 is shown as FREE.</p>${readOnly()}
  <div class="card"><b>Default plan for new accounts</b><p class="muted">Every new shop starts on this plan.</p><select data-on="adm.defplan" ${isSuper() ? '' : 'disabled'}>${plans.filter((p) => p.active !== false).map((p) => `<option value="${esc(p.id)}" ${p.id === def ? 'selected' : ''}>${esc(p.name)}${Number(p.price_ugx) === 0 ? ' (free)' : ''}</option>`).join('')}</select></div>
  ${plans.map((p) => planForm(p, feats)).join('')}${isSuper() ? planForm({}, feats) : ''}`
}, { kind: 'admin' })
ON['adm.defplan'] = async (el) => {
  if (!confirm('Make this the default plan for every new account?')) return rerender()
  await rpc('admin_set_default_plan', { p_plan: el.value }); toast('Default plan updated.'); rerender()
}
ACT['adm.planSave'] = async (form) => {
  const fd = new FormData(form), id = form.dataset.id || String(fd.get('id') || '').trim(), on = fd.getAll('feat')
  const num = (k) => Number(fd.get(k))
  formErr('', form); busy(form, true, 'Saving…')
  try {
    await rpc('admin_save_plan', { p: { id, name: String(fd.get('name') || '').trim(), price_ugx: num('price_ugx'), max_branches: num('max_branches'), max_workers_per_branch: num('max_workers_per_branch'), retention_hours: num('retention_hours'), sort: num('sort') || 0, active: fd.get('active') === 'on', entitlements: Object.fromEntries(featKeys.map((k) => [k, on.includes(k)])) } })
    toast('Plan saved.'); rerender()
  } catch (e) { busy(form, false); formErr(e.message, form) }
}

// ---- features catalogue ----
route('/admin/features', async () => {
  const feats = await select('features', 'select=*&order=sort.asc')
  const f = (x) => `<form class="card" data-act="adm.featSave"><b>${esc(x.name || 'New feature')}</b>
    <label>Key ${x.key ? '(cannot change)' : '(lowercase, e.g. loyalty_points)'}</label><input name="key" required pattern="[a-z0-9_]{2,30}" maxlength="30" value="${esc(x.key || '')}" ${x.key ? 'readonly' : ''}>
    <label>Name</label><input name="name" required maxlength="60" value="${esc(x.name || '')}"><label>What it does</label><input name="description" maxlength="300" value="${esc(x.description || '')}">
    <label>Sort order</label><input name="sort" type="number" value="${Number(x.sort) || 0}"><div class="note formerr" hidden></div>${isSuper() ? '<button class="s block">Save feature</button>' : ''}</form>`
  return `<h2>Features</h2><p class="muted">A feature is something a plan can include. After adding one, switch it on for plans on the Plans page. Features marked "planned" are not built into the app yet.</p>${readOnly()}${feats.map(f).join('')}${isSuper() ? f({}) : ''}`
}, { kind: 'admin' })
ACT['adm.featSave'] = async (form) => {
  const f = formData(form); formErr('', form); busy(form, true)
  try { await rpc('admin_save_feature', { p_key: f.key.trim(), p_name: f.name.trim(), p_description: f.description || '', p_sort: Number(f.sort) || 0 }); toast('Feature saved.'); rerender() } catch (e) { busy(form, false); formErr(e.message, form) }
}

// ---- platform team ----
route('/admin/team', async () => {
  const rows = await rpc('admin_list_team')
  return `<h2>Platform team</h2><p class="muted">Super admins can change everything. Support staff can only view. The person must already have an account.</p>
  <div class="card">${rows.map((m) => `<div class="row it"><span class="g1"><b>${esc(m.email)}</b><div class="muted">${esc(m.role)} · since ${fmt(m.created_at)}</div></span>
    <button class="s" data-act="adm.teamRemove" data-u="${esc(m.user_id)}" data-e="${esc(m.email)}">Remove</button></div>`).join('')}</div>
  <form class="card" data-act="adm.teamAdd"><b>Add or change a team member</b><label>Their account email</label><input name="email" type="email" required maxlength="120">
    <label>Role</label><select name="role"><option value="support">Support (view only)</option><option value="super_admin">Super admin</option></select>
    <div class="note formerr" hidden></div><button class="p mt">Save</button></form>`
}, { kind: 'admin' })
ACT['adm.teamAdd'] = async (form) => {
  const f = formData(form); formErr('', form); busy(form, true)
  try { await rpc('admin_add_team', { p_email: f.email.trim(), p_role: f.role }); toast('Team updated.'); rerender() } catch (e) { busy(form, false); formErr(e.message, form) }
}
ACT['adm.teamRemove'] = async (el) => {
  if (!confirm(`Remove ${el.dataset.e} from the platform team?`)) return
  await rpc('admin_remove_team', { p_user: el.dataset.u }); toast('Removed.'); rerender()
}

// ---- platform audit ----
route('/admin/audit', async () => {
  const rows = await rpc('admin_audit')
  return `<h2>Platform audit</h2><div class="card">${rows.length ? rows.map((e) => `<div class="it"><b>${esc(e.actor_email || 'System')}</b> · ${esc(e.action.replace(/_/g, ' '))}<div class="muted">${fmt(e.at)} ${esc(e.detail && Object.keys(e.detail).length ? JSON.stringify(e.detail).slice(0, 160) : '')}</div></div>`).join('') : '<p class="muted">Nothing recorded yet.</p>'}</div>`
}, { kind: 'admin' })

// ---- suspended business notice ----
route('/suspended', () => `<div class="app"><div class="card narrow center"><h2>Account suspended</h2><p class="muted">${esc((S.acct && S.acct.business && S.acct.business.suspended_reason) || 'This business has been suspended.')}</p><p class="muted">Please <a href="/support" data-link>contact Smart Dobi support</a>.</p><button class="s block" data-act="auth.logout">Sign out</button></div></div>`, { kind: 'bare' })
