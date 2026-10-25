// Street Hustle server · node server.js (Node 18+, no packages).
// Your secrets live in environment variables here, never in the game page.
//   POST /claim           the game asks us to check a purchase and give the gold band skin
//   POST /owned           which skins does this player already own
//   POST /vatar-webhook   Vatar tells us a purchase was paid (signature checked)
//   POST /match/join      get a ticket for a live match      GET /match/stream  live events      POST /match/act  taps and typing
import http from 'node:http'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { verifySession, getPurchase, deliver } from './vatar.js'
import { giveItem, ownedBy, eventSeen, markEventSeen } from './store.js'
import { handleJoin, handleStream, handleAct, handleForfeit } from './match.js'

const PRODUCTS = new Set(['gold_band_skin'])   // the products this server is allowed to give

function corsHeaders(req) {
  const allow = (process.env.ALLOWED_ORIGIN || '*').split(',').map((s) => s.trim()).filter(Boolean)
  const h = { 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600', Vary: 'Origin' }
  const o = req.headers.origin
  if (allow.includes('*')) h['Access-Control-Allow-Origin'] = '*'
  else if (o && allow.includes(o)) h['Access-Control-Allow-Origin'] = o
  return h
}
const send = (res, cors, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify(obj)) }
const read = (req, limit = 16 * 1024) => new Promise((ok, no) => {
  const c = []; let n = 0, big = false
  req.on('data', (x) => {
    n += x.length
    if (n > 1024 * 1024) { req.destroy(); return }   // far too much: drop the connection
    if (n > limit) big = true; else c.push(x)         // too much: keep reading (so we can answer 413) but do not store it
  })
  req.on('end', () => (big ? no(Object.assign(new Error('too_big'), { code: 'too_big' })) : ok(Buffer.concat(c))))
  req.on('error', no)
})
const parse = (raw) => { try { return JSON.parse(raw.toString('utf8')) } catch { return null } }

/** X-Vatar-Signature: "sha256=" + hex HMAC-SHA256 of the raw body, keyed with your webhook signing secret */
export function signed(raw, header) {
  const want = Buffer.from('sha256=' + crypto.createHmac('sha256', process.env.VATAR_WEBHOOK_SECRET || '').update(raw).digest('hex'))
  const got = Buffer.from(String(header ?? ''))
  return want.length === got.length && crypto.timingSafeEqual(want, got)
}

/** Check a purchase with Vatar, give the item once, mark it delivered. wantPlayer: also require it belongs to that player. */
async function fulfil(purchaseId, wantPlayer) {
  const p = await getPurchase(purchaseId)
  if (p.http !== 200) return { code: p.http === 404 ? 404 : 502, error: p.error || 'purchase_failed' }
  if (wantPlayer && p.playerId !== wantPlayer) return { code: 403, error: 'not_your_purchase' }
  if (p.status === 'refunded') return { code: 409, error: 'refunded' }
  if (!PRODUCTS.has(p.productId)) return { code: 422, error: 'unknown_product' }
  giveItem(p.playerId, p.productId, p.id)             // once per purchase id
  const d = await deliver(p.id)                       // mark it delivered (safe to repeat)
  if (d.http !== 200) return { code: 502, error: 'deliver_failed' }
  return { code: 200, productId: p.productId }
}

async function handler(req, res) {
  const cors = corsHeaders(req)
  const url = new URL(req.url, 'http://localhost')
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end() }
  try {
    if (req.method === 'GET' && url.pathname === '/health') return send(res, cors, 200, { ok: true })
    if (req.method === 'GET' && url.pathname === '/match/stream') return handleStream(req, res, url, cors)
    if (req.method !== 'POST') return send(res, cors, 404, { error: 'not_found' })

    const raw = await read(req)

    if (url.pathname === '/vatar-webhook') {
      if (!signed(raw, req.headers['x-vatar-signature'])) return send(res, cors, 401, { error: 'bad_signature' })
      const evt = parse(raw)
      if (!evt || typeof evt.id !== 'string') return send(res, cors, 400, { error: 'bad_request' })
      if (eventSeen(evt.id)) return send(res, cors, 200, { ok: true, duplicate: true })
      if (evt.type === 'purchase.paid' && evt.data && typeof evt.data.purchaseId === 'string') {
        const r = await fulfil(evt.data.purchaseId)        // a nudge, not proof: we check the purchase ourselves
        if (r.code === 502) return send(res, cors, 500, { error: r.error })   // let Vatar try again later
      }
      markEventSeen(evt.id)
      return send(res, cors, 200, { ok: true })
    }

    const body = parse(raw)
    if (!body) return send(res, cors, 400, { error: 'bad_request' })

    if (url.pathname === '/claim') {
      if (typeof body.session !== 'string' || typeof body.purchaseId !== 'string') return send(res, cors, 400, { error: 'bad_request' })
      const me = await verifySession(body.session)
      if (me.http !== 200) return send(res, cors, 403, { error: me.error || 'bad_session' })
      const r = await fulfil(body.purchaseId, me.playerId)
      return send(res, cors, r.code, r.code === 200 ? { ok: true, productId: r.productId } : { error: r.error })
    }
    if (url.pathname === '/owned') {
      if (typeof body.session !== 'string') return send(res, cors, 400, { error: 'bad_request' })
      const me = await verifySession(body.session)
      if (me.http !== 200) return send(res, cors, 403, { error: me.error || 'bad_session' })
      return send(res, cors, 200, { skins: ownedBy(me.playerId) })
    }
    if (url.pathname === '/match/join') { const r = await handleJoin(body); return send(res, cors, r.code, r.body) }
    if (url.pathname === '/match/act') { const r = handleAct(body); return send(res, cors, r.code, r.body) }
    if (url.pathname === '/match/forfeit') { const r = handleForfeit(body); return send(res, cors, r.code, r.body) }
    return send(res, cors, 404, { error: 'not_found' })
  } catch (e) {
    if (e && e.code === 'too_big') return send(res, cors, 413, { error: 'too_big' })
    console.error('request failed', req.method, url.pathname, e && e.message)
    if (!res.headersSent) send(res, cors, 500, { error: 'error' })
  }
}

export function start(port = Number(process.env.PORT) || 8080) {
  const s = http.createServer(handler)
  return new Promise((ok) => s.listen(port, () => ok(s)))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const k of ['VATAR_SECRET', 'VATAR_WEBHOOK_SECRET', 'VATAR_RESULTS_SECRET']) if (!process.env[k]) console.warn(`Warning: ${k} is not set`)
  start().then((s) => console.log('Street Hustle server listening on', s.address().port))
}
