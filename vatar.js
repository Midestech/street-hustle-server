// Calls to the Vatar server API. Your secrets come from environment variables, never from the game page.
import crypto from 'node:crypto'

const env = () => process.env
export const apiBase = () => (env().VATAR_API || 'https://lagoslife.app/api/games/v1').replace(/\/+$/, '')

/** Same shape as the docs example: { http: <status>, ...body } */
export async function api(path, body) {
  try {
    const r = await fetch(apiBase() + path, {
      method: body ? 'POST' : 'GET',
      body: body && JSON.stringify(body),
      headers: { Authorization: `Bearer ${env().VATAR_SECRET}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    let data = {}
    try { data = await r.json() } catch { /* empty body */ }
    return { http: r.status, ...data }
  } catch (e) {
    return { http: 0, error: 'unreachable', message: String(e && e.message) }
  }
}

export const verifySession = (session) => api('/session/verify', { session })
export const getMatch = (id) => api(`/matches/${encodeURIComponent(id)}`)
export const getPurchase = (id) => api(`/purchases/${encodeURIComponent(id)}`)
export const deliver = (id) => api(`/purchases/${encodeURIComponent(id)}/deliver`, {})

/** Post a match result: signed with the results secret, exactly as the docs describe. winner is a playerId or "draw". */
export async function postMatchResult(match, winner) {
  const base = new URL(apiBase())
  const path = `${base.pathname.replace(/\/+$/, '')}/matches/${encodeURIComponent(match.id)}/result`
  const body = JSON.stringify({ winner })
  const ts = String(Math.floor(Date.now() / 1000))
  const sha = crypto.createHash('sha256').update(body).digest('hex')
  const sig = 'v1=' + crypto.createHmac('sha256', env().VATAR_RESULTS_SECRET || '')
    .update(['POST', path, ts, match.nonce, sha].join('\n')).digest('hex')
  try {
    const r = await fetch(base.origin + path, {
      method: 'POST', body,
      headers: {
        Authorization: `Bearer ${env().VATAR_SECRET}`, 'Content-Type': 'application/json',
        'X-Vatar-Timestamp': ts, 'X-Vatar-Signature': sig,
      },
      signal: AbortSignal.timeout(8000),
    })
    let data = {}
    try { data = await r.json() } catch { /* empty body */ }
    return { http: r.status, ...data }
  } catch (e) {
    return { http: 0, error: 'unreachable', message: String(e && e.message) }
  }
}
