const crypto = require('node:crypto')

const QUEUE_KEY = 'knowledge:learn_tasks_queue'
const HABITS_INDEX_KEY = 'knowledge:learned_habits_index'

function hash16(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16)
}

function getQueue(memory) {
  if (!memory) return []
  const v = memory.get(QUEUE_KEY)
  return Array.isArray(v) ? v : []
}

async function saveQueue(memory, queue) {
  if (!memory) return
  await memory.set(QUEUE_KEY, queue)
}

function getHabitsIndex(memory) {
  if (!memory) return []
  const v = memory.get(HABITS_INDEX_KEY)
  return Array.isArray(v) ? v : []
}

async function appendHabit(memory, entry) {
  if (!memory) return
  const list = getHabitsIndex(memory)
  list.push(entry)
  await memory.set(HABITS_INDEX_KEY, list.slice(-50))
  await memory.set(`habit:${entry.id}`, entry)
}

/**
 * Merge LLM proposals into queue (dedupe by id or summary hash).
 */
async function mergeProposalsFromAnalysis(memory, proposals, logger, cycle) {
  if (!memory || !Array.isArray(proposals) || proposals.length === 0) return
  let queue = getQueue(memory)
  const seen = new Set(queue.map((t) => t.id))

  for (const p of proposals) {
    const summary = typeof p.summary === 'string' ? p.summary.trim() : ''
    const successCriteria = typeof p.successCriteria === 'string' ? p.successCriteria.trim() : ''
    if (!summary || !successCriteria) continue

    const rawReq = Number(p.successesRequired)
    const successesRequired = rawReq === 2 ? 2 : 1
    const id = typeof p.id === 'string' && p.id.trim()
      ? p.id.trim().replace(/[^a-zA-Z0-9._:-]/g, '_')
      : `lt_${hash16(summary)}`

    if (seen.has(id)) continue
    const dupBySummary = queue.some((t) => t.summary === summary)
    if (dupBySummary) continue

    seen.add(id)
    queue.push({
      id,
      summary,
      successCriteria,
      successesRequired,
      successCount: 0,
      evidenceFromChat: typeof p.evidenceFromChat === 'string' ? p.evidenceFromChat : '',
      priorityTier: 'user_long_term_habit',
      createdAt: new Date().toISOString(),
    })

    if (logger) {
      await logger.log({
        type: 'learn_task_proposed',
        cycle,
        taskId: id,
        summary,
        successesRequired,
      })
    }
  }

  await saveQueue(memory, queue)
}

function compactChainForEval(chain) {
  if (!Array.isArray(chain)) return []
  return chain.map((s) => ({
    type: s?.type,
    target: s?.target,
    item: s?.item,
    message: s?.message ? String(s.message).slice(0, 80) : undefined,
  }))
}

function compactChainResults(results) {
  if (!Array.isArray(results)) return []
  return results.map((r) => ({
    step: r.step,
    type: r.type,
    ok: r.ok,
    err: r.error?.message || null,
  }))
}

module.exports = {
  QUEUE_KEY,
  HABITS_INDEX_KEY,
  getQueue,
  saveQueue,
  getHabitsIndex,
  appendHabit,
  mergeProposalsFromAnalysis,
  compactChainForEval,
  compactChainResults,
  hash16,
}
