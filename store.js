// A tiny JSON-file store for delivered purchases and owned skins.
// NOTE: on Render's free plan the disk is wiped on every restart or deploy. That is fine for a cosmetic skin
// (the game also remembers it, and Vatar.purchases() re-delivers anything not marked delivered), but use a
// real database before you sell anything that matters.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const file = () => process.env.DATA_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'store.json')
let db = null

function load() {
  if (db) return db
  try { db = JSON.parse(fs.readFileSync(file(), 'utf8')) } catch { db = {} }
  db.delivered ||= {}; db.skins ||= {}; db.events ||= {}
  return db
}
function save() {
  try { fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(db)) }
  catch (e) { console.warn('store: could not save', e.message) }
}

/** Give the item once per purchase id. Returns true the first time. */
export function giveItem(playerId, productId, purchaseId) {
  const d = load()
  if (d.delivered[purchaseId]) return false
  ;(d.skins[playerId] ||= [])
  if (!d.skins[playerId].includes(productId)) d.skins[playerId].push(productId)
  d.delivered[purchaseId] = Date.now()
  save()
  return true
}
export const ownedBy = (playerId) => [...(load().skins[playerId] || [])]
export const eventSeen = (id) => !!load().events[id]
export function markEventSeen(id) {
  const d = load(); d.events[id] = Date.now()
  const ids = Object.keys(d.events); if (ids.length > 500) for (const k of ids.slice(0, ids.length - 500)) delete d.events[k]
  save()
}
export function _resetForTests() { db = null }
