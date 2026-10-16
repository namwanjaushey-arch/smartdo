// util.js - small pure helpers shared by every screen. Nothing here touches the page or the server.

// Every piece of text typed by a person MUST go through esc() before it is placed in HTML.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
export const one = (x) => (Array.isArray(x) ? x[0] ?? null : x ?? null)
export const enc = encodeURIComponent

export const fmt = (t) => {
  const d = new Date(t)
  return isNaN(d.getTime()) ? '' : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}
export const fmtDay = (ymd) => new Date(ymd + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
export const U = (n) => 'UGX ' + Math.round(Number(n) || 0).toLocaleString('en-US')
export const todayLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10)
export const PIN_RE = /^\d{4,5}$/

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
export const newId = () => crypto.randomUUID()
export const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(24)))
export const intlPhone = (p) => {
  const d = String(p ?? '').replace(/\D/g, '')
  return d.startsWith('0') ? '256' + d.slice(1) : d
}
export function newReceiptNo() {
  const d = new Date()
  const r = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => (b % 36).toString(36)).join('').toUpperCase()
  return `RC-${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${r}`
}
export function vref(receiptNo, amount, at) {
  let x = 0
  for (const c of `${receiptNo}|${amount}|${at}`) x = (x * 31 + c.charCodeAt(0)) >>> 0
  return x.toString(36).toUpperCase().padStart(6, '0').slice(-6)
}

export const STATUS = {
  received: ['Received', 'am'], queued: ['Queued for Cleaning', 'am'], washing: ['Washing', 'am'], drying: ['Drying', 'am'],
  ironing: ['Ironing / Finishing', 'am'], qc: ['Quality Check', 'am'], ready: ['Ready for Pickup', 'gr'],
  rework: ['Needs Rework', 'am'], returned: ['Returned to Customer', 'pu'], cancelled: ['Cancelled', 'rd'],
}
export const PICK = ['received', 'queued', 'washing', 'drying', 'ironing', 'qc', 'ready']
export const PROGRESS = PICK
export const label = (s) => (STATUS[s] ? STATUS[s][0] : s)
export const badge = (s) => `<span class="badge ${STATUS[s] ? STATUS[s][1] : 'am'}">${esc(label(s))}</span>`

export const PAY_METHODS = ['Cash', 'MTN MoMo', 'Airtel Money', 'Bank transfer', 'Card', 'Other']
export const EXP_CATS = ['Detergents', 'Fabric softeners', 'Water', 'Electricity', 'Rent', 'Salaries', 'Transport', 'Packaging', 'Equipment maintenance', 'Machine repairs', 'Internet & communications', 'Other operating expenses']
export const SERVICES = ['Wash & fold', 'Dry cleaning', 'Ironing', 'Carpets & rugs', 'Bedding & curtains', 'Uniforms', 'Express']
export const AREAS = ['Kampala Central', 'Kololo', 'Ntinda', 'Bugolobi', 'Nakawa', 'Entebbe', 'Mukono', 'Jinja']
export const CAT = {
  'Everyday clothing': ['T-shirt', 'Polo shirt', 'Formal shirt', 'Blouse', 'Vest', 'Sweater', 'Hoodie', 'Jacket', 'Suit jacket', 'Suit', 'Coat', 'Dress', 'Gown', 'Skirt', 'Shorts', 'Jeans', 'Trousers', 'Leggings', 'Uniform', 'School uniform', 'Sportswear', 'Pajamas', 'Underwear', 'Bra'],
  'Small items': ['Socks', 'Handkerchief', 'Scarf', 'Tie', 'Belt', 'Cap', 'Gloves', 'Shawl', 'Headwrap'],
  'Bedding & household': ['Bedsheet', 'Pillowcase', 'Blanket', 'Duvet', 'Duvet cover', 'Comforter', 'Mattress protector', 'Cushion cover', 'Curtains', 'Tablecloth', 'Towel', 'Bathrobe', 'Bath mat'],
  'Large & specialty': ['Carpet', 'Rug', 'Doormat', 'Sofa cover', 'Sleeping bag', 'Tent fabric'],
  Commercial: ['Hotel linen', 'Restaurant apron', 'Chef uniform', 'Medical uniform', 'Lab coat', 'Workwear', 'Salon towel', 'Gym towel'],
}

export const LOGO = (size = 36) => `<svg width="${size}" height="${size}" viewBox="0 0 512 512" role="img" aria-label="Smart Dobi"><defs><linearGradient id="lg${size}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#b9acff"/><stop offset="1" stop-color="#6a55d8"/></linearGradient></defs><rect width="512" height="512" rx="112" fill="url(#lg${size})"/><g fill="none" stroke="#fff" stroke-width="24" stroke-linecap="round" stroke-linejoin="round"><path d="M256 200L96 330H416Z"/><path d="M256 200V172A28 28 0 1 1 280 130"/></g><path d="M388 98C410 126 424 142 424 166A36 36 0 0 1 352 166C352 142 366 126 388 98Z" fill="#bff0d4"/><ellipse cx="375" cy="160" rx="6" ry="10" fill="#fff"/><circle cx="256" cy="285" r="30" fill="none" stroke="#ebe6ff" stroke-width="6"/><circle cx="256" cy="285" r="18" fill="#fff"/><circle cx="256" cy="285" r="13" fill="#f2705f"/></svg>`
export const WORDMARK = '<span class="wm">smart<i>dobi</i></span>'

// Shrinks a photo in the browser before upload (saves data and storage).
export function compressImage(file, max = 640) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height))
      const c = document.createElement('canvas')
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k)
      const ctx = c.getContext('2d')
      if (!ctx) { URL.revokeObjectURL(url); return reject(new Error('Could not process the photo')) }
      ctx.drawImage(img, 0, 0, c.width, c.height)
      URL.revokeObjectURL(url)
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not compress the photo'))), 'image/jpeg', 0.65)
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read the photo')) }
    img.src = url
  })
}

export const priceLabel = (p) => (Number(p.price_ugx) > 0 ? U(p.price_ugx) + ' / month' : 'Free')
export const hoursText = (h) => (Number(h) < 72 ? `${Number(h)} hours` : `${Math.round(Number(h) / 24)} days`)
export const backBtn = (fallback) => `<button class="s back" data-act="back" data-fb="${esc(fallback)}">← Back</button>`
