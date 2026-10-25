// Live 2-player matches for Sharp Eye and Fastest Finger.
// The server runs the clock and decides every round, then posts the signed result to Vatar.
// Phones talk to it with: POST /match/join (get a ticket), GET /match/stream (live events), POST /match/act (taps / typing).
import crypto from 'node:crypto'
import { verifySession, getMatch, postMatchResult } from './vatar.js'

// 20 Lagos sentences (plain ASCII). The game page shows whatever the server sends.
export const SENTENCES = [
  'Lagos traffic taught me patience, but the hustle taught me speed.',
  'A danfo, a bag of groundnut and one loud argument make a perfect Monday.',
  'Sapa may knock on your door, but hustle must answer it first.',
  'The sweetest jollof is the one you cook after you finally close the deal.',
  'Small small chop, small small save, and one day you go buy the whole street.',
  'When NEPA takes the light, a sharp trader finds the candle first.',
  'Balogun market never sleeps, so you better count your change twice.',
  'Eko o ni baje, so wake up early and go catch your own blessing.',
  'The conductor shouted, the okada honked, and Lagos kept moving.',
  'Never price your gold before you check who is buying it.',
  'A fast thumb and a calm mind can beat the longest queue in Ikeja.',
  'She sold fresh pepper at dawn and bought her first shop before the rainy season.',
  'A good name is better than quick money, but quick money with a good name is sweet.',
  'Between the traffic and the sunset, Third Mainland Bridge tells many stories.',
  'Ask the price before you bargain, and bargain before you smile.',
  'The sharpest hustler is never the loudest one in the market.',
  'Suya at midnight tastes better than any promise made in the morning.',
  'Rain fell on Ladipo, but the spare parts business never took a day off.',
  'If you wait for a perfect road, the keke will leave you behind.',
  'Fortune loves the person who shows up early with a plan and a spare pen.',
]
export const CAP = { sharp: 90, finger: 120 }   // seconds per round
const capSec = (game) => Number(process.env.MM_CAP_S) || CAP[game]   // MM_CAP_S is only for tests
const WIN_ROUNDS = 2                              // best of 3
const PENALTY_MS = 2000                           // each mistake adds 2 seconds to your time

const cfg = () => ({
  countdown: Number(process.env.MM_COUNTDOWN_MS) || 3000,
  between: Number(process.env.MM_BETWEEN_MS) || 3500,
  disconnect: Number(process.env.MM_DISCONNECT_MS) || 20000,
  lobby: Number(process.env.MM_LOBBY_MS) || 60000,
  keep: Number(process.env.MM_KEEP_MS) || 10 * 60 * 1000,
  retry: Number(process.env.MM_RETRY_MS) || 1500,
})

const rooms = new Map()    // matchId -> room
const tickets = new Map()  // ticket -> { matchId, playerId, exp }

setInterval(() => { const n = Date.now(); for (const [k, t] of tickets) if (t.exp < n) tickets.delete(k) }, 10 * 60 * 1000).unref()

// ---------- helpers ----------
const later = (room, ms, fn) => { const t = setTimeout(() => { room.timers.delete(t); fn() }, ms); room.timers.add(t); return t }
function clearRoom(room) {
  for (const t of room.timers) clearTimeout(t)
  room.timers.clear()
  if (room.ticker) { clearInterval(room.ticker); room.ticker = null }
  for (const p of room.players.values()) if (p.disc) { clearTimeout(p.disc); p.disc = null }
}
const frac = () => crypto.randomInt(1000) / 1000
function makeLayout() {
  const a = Array.from({ length: 100 }, (_, i) => i + 1)
  for (let i = 99; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]] }
  return a.map((n) => ({ n, dx: (frac() - 0.5) * 0.3, dy: (frac() - 0.5) * 0.3, rot: (frac() - 0.5) * 0.6, sz: 0.32 + frac() * 0.2, hue: crypto.randomInt(4) }))
}

// ---------- rooms ----------
function makeRoom(m, game) {
  const players = new Map(m.players.map((p) => [p.playerId, { id: p.playerId, name: String(p.name || 'Player').slice(0, 30), conns: new Set(), joined: false, disc: null }]))
  const ids = [...players.keys()]
  const room = {
    id: m.id, nonce: m.nonce, stake: m.stake || 0, game, players, ids,
    score: Object.fromEntries(ids.map((k) => [k, 0])), roundNo: 0, round: null,
    phase: 'lobby', last: null, final: null, timers: new Set(), ticker: null,
  }
  later(room, cfg().lobby, () => lobbyTimeout(room))
  return room
}

export async function handleJoin(body) {
  const { session, matchId, game } = body || {}
  if (typeof session !== 'string' || typeof matchId !== 'string' || !['sharp', 'finger'].includes(game)) return { code: 400, body: { error: 'bad_request' } }
  const me = await verifySession(session)
  if (me.http !== 200) return { code: me.http === 401 ? 401 : 502, body: { error: me.error || 'session_failed' } }
  let room = rooms.get(matchId)
  if (!room) {
    const m = await getMatch(matchId)
    if (m.http !== 200) return { code: m.http === 404 ? 404 : 502, body: { error: m.error || 'match_failed' } }
    if (m.status !== 'playing') return { code: 409, body: { error: 'not_playing' } }
    if (!Array.isArray(m.players) || m.players.length !== 2 || typeof m.nonce !== 'string') return { code: 409, body: { error: 'two_players_only' } }
    room = rooms.get(matchId) || makeRoom(m, game)   // the other player may have created it while we waited
    rooms.set(matchId, room)
  }
  if (!room.players.has(me.playerId)) return { code: 403, body: { error: 'not_in_match' } }
  const ticket = crypto.randomBytes(24).toString('hex')
  tickets.set(ticket, { matchId, playerId: me.playerId, exp: Date.now() + 3 * 3600 * 1000 })
  return { code: 200, body: { ticket, game: room.game } }
}

function ticketRoom(ticket) {
  const t = typeof ticket === 'string' ? tickets.get(ticket) : null
  if (!t || t.exp < Date.now()) return null
  const room = rooms.get(t.matchId)
  if (!room) return null
  return { room, pid: t.playerId }
}

export function handleStream(req, res, url, corsHeaders) {
  const found = ticketRoom(url.searchParams.get('ticket'))
  if (!found) { res.writeHead(401, corsHeaders).end(); return }
  const { room, pid } = found
  const p = room.players.get(pid)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...corsHeaders,
  })
  res.write('retry: 2000\n\n')
  const conn = { res }
  p.conns.add(conn); p.joined = true
  if (p.disc) { clearTimeout(p.disc); p.disc = null }
  const ka = setInterval(() => { try { res.write(': ka\n\n') } catch { /* closed */ } }, 15000)
  req.on('close', () => { clearInterval(ka); p.conns.delete(conn); onDisconnect(room, p) })
  broadcast(room)             // everyone (including the new connection) gets the fresh state
  maybeStart(room)
}

function maybeStart(room) {
  if (room.phase !== 'lobby') return
  if ([...room.players.values()].every((p) => p.joined && p.conns.size > 0)) startRound(room)
}

function onDisconnect(room, p) {
  if (room.phase === 'done') return
  broadcast(room)
  if (p.conns.size > 0 || !p.joined) return
  if (p.disc) clearTimeout(p.disc)
  p.disc = setTimeout(() => { p.disc = null; if (p.conns.size === 0) finish(room, room.ids.find((x) => x !== p.id), 'forfeit') }, cfg().disconnect)
}

function lobbyTimeout(room) {
  if (room.phase !== 'lobby') return
  const here = [...room.players.values()].filter((p) => p.joined)
  if (here.length === 1) finish(room, here[0].id, 'opponent_never_joined')
  else finish(room, 'draw', 'nobody_joined')
}

/** Leave right away (the player chose to leave): the other player wins. */
export function handleForfeit(body) {
  const f = ticketRoom(body && body.ticket)
  if (!f) return { code: 401, body: { error: 'bad_ticket' } }
  if (f.room.phase !== 'done') finish(f.room, f.room.ids.find((x) => x !== f.pid), 'forfeit')
  return { code: 200, body: { ok: true } }
}

// ---------- rounds ----------
function startRound(room) {
  const c = cfg()
  const per = {}
  for (const id of room.ids) per[id] = { pen: 0, done: false, failed: false, adj: null, elapsed: null, text: '', prev: 0, taps: new Set(), acts: [] }
  const r = { n: ++room.roundNo, start: Date.now() + c.countdown, per, decided: false, target: null, layout: null, sentence: null }
  if (room.game === 'sharp') { r.layout = makeLayout(); r.target = 1 + crypto.randomInt(100) }
  else r.sentence = SENTENCES[crypto.randomInt(SENTENCES.length)]
  room.round = r
  room.phase = 'countdown'
  broadcast(room)
  later(room, c.countdown, () => {
    if (room.phase !== 'countdown') return
    room.phase = 'playing'
    broadcast(room)
    room.ticker = setInterval(() => evaluate(room), 200)
  })
}

export function handleAct(body) {
  const f = ticketRoom(body && body.ticket)
  if (!f) return { code: 401, body: { error: 'bad_ticket' } }
  const { room, pid } = f
  const ok = { code: 200, body: { ok: true } }
  if (room.phase !== 'playing') return ok
  const r = room.round, me = r.per[pid], now = Date.now()
  if (me.done || me.failed || now < r.start) return ok
  me.acts = me.acts.filter((t) => now - t < 1000); me.acts.push(now)
  if (me.acts.length > 30) return { code: 429, body: { error: 'rate_limited' } }
  if (room.game === 'sharp' && body.type === 'tap') {
    const cell = body.cell
    if (!Number.isInteger(cell) || cell < 0 || cell > 99) return { code: 400, body: { error: 'bad_request' } }
    if (r.layout[cell].n === r.target) finishPlayer(room, pid, now)
    else if (!me.taps.has(cell)) { me.taps.add(cell); me.pen++; broadcast(room) }
  } else if (room.game === 'finger' && body.type === 'type') {
    const text = body.text
    if (typeof text !== 'string' || text.length > r.sentence.length + 40) return { code: 400, body: { error: 'bad_request' } }
    for (let k = me.prev; k < text.length; k++) if (text[k] !== r.sentence[k]) me.pen++   // each wrong key adds 2 seconds
    me.prev = text.length; me.text = text
    if (text === r.sentence) finishPlayer(room, pid, now); else broadcast(room)
  } else return { code: 400, body: { error: 'bad_request' } }
  evaluate(room)
  return ok
}

function finishPlayer(room, pid, now) {
  const r = room.round, p = r.per[pid], cap = capSec(room.game) * 1000
  p.elapsed = now - r.start
  const adj = p.elapsed + PENALTY_MS * p.pen
  if (adj >= cap) { p.failed = true; p.adj = cap } else { p.done = true; p.adj = adj }
  broadcast(room)
}

function evaluate(room) {
  if (room.phase !== 'playing' || room.round.decided) return
  const r = room.round, now = Date.now(), cap = capSec(room.game) * 1000
  const [a, b] = room.ids, pa = r.per[a], pb = r.per[b]
  const live = (p) => (p.done || p.failed ? p.adj : (now - r.start) + PENALTY_MS * p.pen)
  for (const p of [pa, pb]) if (!p.done && !p.failed && live(p) >= cap) { p.failed = true; p.adj = cap }   // out of time
  const resolved = (p) => p.done || p.failed
  if (resolved(pa) && resolved(pb)) {
    if (pa.done && pb.done) return endRound(room, pa.adj < pb.adj ? a : pb.adj < pa.adj ? b : 'tie')
    if (pa.done) return endRound(room, a)
    if (pb.done) return endRound(room, b)
    return endRound(room, 'tie')
  }
  // one player finished: the other can only win by beating that adjusted time
  if (pa.done && live(pb) >= pa.adj) return endRound(room, a)
  if (pb.done && live(pa) >= pb.adj) return endRound(room, b)
}

function endRound(room, winner) {
  const r = room.round
  r.decided = true
  if (room.ticker) { clearInterval(room.ticker); room.ticker = null }
  room.phase = 'roundover'
  if (winner !== 'tie') room.score[winner]++
  room.last = { n: r.n, winner, per: Object.fromEntries(room.ids.map((id) => [id, { adj: r.per[id].adj, elapsed: r.per[id].elapsed, pen: r.per[id].pen, done: r.per[id].done, failed: r.per[id].failed }])) }
  broadcast(room)
  if (winner !== 'tie' && room.score[winner] >= WIN_ROUNDS) finish(room, winner, 'won')
  else later(room, cfg().between, () => startRound(room))
}

async function finish(room, winner, why) {
  if (room.phase === 'done') return
  clearRoom(room)
  room.phase = 'done'
  room.final = { winner, why, settled: false }
  broadcast(room)
  // post the signed result (retry a few times), then keep the room around briefly so phones can read the outcome
  for (let attempt = 0; attempt < 5 && !room.final.settled; attempt++) {
    const r = await postMatchResult({ id: room.id, nonce: room.nonce }, winner)
    if (r.http === 200 || r.error === 'already_settled') room.final.settled = true
    else if (r.http >= 400 && r.http < 500 && r.http !== 429) { room.final.error = r.error || 'rejected'; break }
    else await new Promise((ok) => setTimeout(ok, cfg().retry * (attempt + 1)))
  }
  broadcast(room)
  setTimeout(() => { rooms.delete(room.id) }, cfg().keep).unref()
}

// ---------- what each phone sees ----------
function view(room, pid) {
  const opp = room.ids.find((x) => x !== pid), r = room.round
  const v = {
    serverNow: Date.now(), game: room.game, matchId: room.id, phase: room.phase, cap: capSec(room.game), stake: room.stake,
    you: { id: pid, name: room.players.get(pid).name },
    opp: { id: opp, name: room.players.get(opp).name, connected: room.players.get(opp).conns.size > 0 },
    score: { you: room.score[pid], opp: room.score[opp] }, round: room.roundNo, winRounds: WIN_ROUNDS,
  }
  if (r && ['countdown', 'playing', 'roundover'].includes(room.phase)) {
    const me = r.per[pid], op = r.per[opp]
    v.start = r.start
    if (room.game === 'sharp') { v.target = r.target; if (room.phase !== 'countdown') v.layout = r.layout }
    else if (room.phase !== 'countdown') v.sentence = r.sentence
    v.me = { pen: me.pen, done: me.done, failed: me.failed, adj: me.adj }
    v.oppState = { pen: op.pen, done: op.done, failed: op.failed, adj: op.done ? op.adj : null }
    if (room.game === 'finger') v.oppState.text = op.text   // you watch their typing live
  }
  if (room.last) {
    const l = room.last
    v.last = { n: l.n, winner: l.winner === 'tie' ? 'tie' : l.winner === pid ? 'you' : 'opp', you: l.per[pid], opp: l.per[opp] }
  }
  if (room.final) v.final = { winner: room.final.winner === 'draw' ? 'draw' : room.final.winner === pid ? 'you' : 'opp', why: room.final.why, settled: room.final.settled, error: room.final.error || null }
  return v
}

function broadcast(room) {
  for (const p of room.players.values()) {
    if (!p.conns.size) continue
    const data = `event: state\ndata: ${JSON.stringify(view(room, p.id))}\n\n`
    for (const c of p.conns) { try { c.res.write(data) } catch { /* closed */ } }
  }
}

// for tests
export const _rooms = rooms
export function _resetForTests() { for (const r of rooms.values()) clearRoom(r); rooms.clear(); tickets.clear() }
