// upgrade.js - a shop whose plan has expired (or any shop that wants more) picks a plan, pays by mobile money,
// uploads proof, and waits for the Smart Dobi team to approve. Approval changes the plan and unlocks access automatically.
import { rpc, uploadProof } from './api.js'
import { S, route, ACT, ON, go, rerender, loadAcct, loadBiz, timers, toast, formData, formErr, busy } from './core.js'
import { esc, fmt, fmtDay, U, newId, compressImage, backBtn, priceLabel, hoursText } from './util.js'

let up = { plan: null }, wasRestricted = false
const FEATURE_NAMES = { directory: 'Public directory', sms: 'SMS to customers', reports: 'Printable reports', expenses: 'Expenses', white_label: 'White-label documents' }
const featList = (ent) => Object.entries(ent || {}).filter(([, v]) => v).map(([k]) => FEATURE_NAMES[k] || k)

route('/upgrade', async () => {
  const info = await rpc('payment_info')
  const b = info.business, latest = info.latest, active = b.status === 'active'
  wasRestricted = b.status === 'restricted'
  const pending = latest && latest.status === 'pending'
  const plan = info.plans.find((p) => p.id === up.plan) || null
  const head = b.status === 'restricted'
    ? `<div class="note"><b>Restricted:</b> your plan has expired. Upgrade to continue.</div>`
    : b.status === 'suspended' ? `<div class="note">This business is suspended. Please contact support.</div>` : ''
  const status = pending ? `<div class="note">⏳ Your payment of ${U(latest.amount_ugx)} for the <b>${esc((info.plans.find((p) => p.id === latest.plan_id) || {}).name || latest.plan_id)}</b> plan is waiting for approval. Your account unlocks automatically as soon as it is approved.</div>`
    : latest && latest.status === 'rejected' ? `<div class="note"><b>Payment not approved:</b> ${esc(latest.reject_reason || '')}. You can choose a plan and submit again.</div>`
    : latest && latest.status === 'approved' && active ? '<div class="ok">✅ Your last payment was approved.</div>' : ''
  return `<div class="app">${active ? backBtn('/app') : ''}
  <div class="card narrow-wide mt"><h2>${active ? 'Plan &amp; upgrade' : 'Upgrade to continue'}</h2>${head}${status}
    <p class="muted">Current plan: <b>${esc(b.plan_id)}</b>${b.plan_expires_at ? ` · paid until ${esc(fmtDay(String(b.plan_expires_at).slice(0, 10)))}` : ''}</p>
    ${active ? '<a class="s block" href="/app" data-link>Continue to my shop</a>' : ''}</div>
  ${pending ? '' : `<div class="card narrow-wide"><b>1. Choose a plan</b><div class="mt">${info.plans.map((p) => `<div class="opt ${up.plan === p.id ? 'on' : ''}" data-act="up.plan" data-id="${esc(p.id)}">
      <div class="row"><b class="g1">${esc(p.name)}</b><b>${esc(priceLabel(p))}</b></div>
      <div class="muted">${p.max_branches} shop(s) · ${p.max_workers_per_branch} workers each · order photos kept ${esc(hoursText(p.retention_hours))} after an order closes</div>
      <div class="muted">${esc(featList(p.entitlements).join(' · ') || 'Core features')}</div></div>`).join('') || '<p class="muted">No paid plans are available yet. Please contact support.</p>'}</div></div>
  ${plan ? `<div class="card narrow-wide"><b>2. Pay ${U(plan.price_ugx)}</b><p class="muted">Send exactly ${U(plan.price_ugx)} to one of these:</p>
    ${info.methods.map((m) => `<div class="it"><b>${esc(m.label)}</b><div>${m.code ? 'Code / number: <b>' + esc(m.code) + '</b>' : '<span class="muted">Code not set yet. Please contact support.</span>'}</div><div class="muted">Account name: ${esc(m.account_name || '—')}</div></div>`).join('')}
    <form data-act="up.submit" data-plan="${esc(plan.id)}" class="mt"><b>3. Send your proof</b>
      <label>Which did you use?</label><select name="method">${info.methods.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('')}</select>
      <label>Number you paid from</label><input name="number" inputmode="tel" required maxlength="20" placeholder="07XX XXX XXX">
      <label>Transaction ID (from the payment message)</label><input name="txn" required minlength="4" maxlength="40">
      <label>Screenshot or photo of the receipt</label><input name="proof" type="file" accept="image/*" required>
      <div class="note formerr" hidden></div><button class="p mt">Submit for approval</button></form></div>` : ''}`}
  <div class="card narrow-wide center"><button class="s" data-act="up.refresh">🔄 Check my status</button>
    <p class="muted"><a href="/support" data-link>Contact support</a> · <a href="#" data-act="auth.logout">Sign out</a></p></div></div>`
}, { kind: 'bare', after: () => {
  if (!wasRestricted) return
  // while restricted, keep checking so access returns on its own once the payment is approved
  timers.push(setInterval(async () => {
    try { const i = await rpc('payment_info'); if (i.business.status === 'active') { await loadAcct(); await loadBiz(); if (S.biz) go('/gate') } } catch { /* offline */ }
  }, 20000))
} })
ACT['up.plan'] = (el) => { up.plan = el.dataset.id; rerender() }
ACT['up.refresh'] = async () => {
  const a = await loadAcct()
  if (a && a.business && a.business.status === 'active') { await loadBiz(); toast('Your account is active.'); return go('/gate') }
  toast('Still waiting. We will unlock your account as soon as the payment is approved.'); rerender()
}
ACT['up.submit'] = async (form) => {
  const f = formData(form), file = form.querySelector('input[name="proof"]').files[0]
  if (!file || !file.type.startsWith('image/')) return formErr('Choose a photo or screenshot of your payment receipt.', form)
  if (file.size > 15 * 1024 * 1024) return formErr('That image is too large (maximum 15 MB).', form)
  formErr('', form); busy(form, true, 'Uploading proof…')
  try {
    const pid = newId(), path = `${S.acct.business.id}/${pid}.jpg`
    await uploadProof(path, await compressImage(file, 1400))
    await rpc('submit_payment', { p_id: pid, p_plan: form.dataset.plan, p_method: f.method, p_number: f.number.trim(), p_txn: f.txn.trim(), p_proof: path })
    toast('Submitted. We will review your payment shortly.'); up.plan = null; rerender()
  } catch (e) { busy(form, false); formErr(e.message, form) }
}
