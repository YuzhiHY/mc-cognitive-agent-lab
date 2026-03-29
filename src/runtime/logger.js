const fs = require('node:fs')
const path = require('node:path')

function toBool(v, defaultValue = false) {
  if (v === undefined) return defaultValue
  const s = String(v).toLowerCase().trim()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

function safeJsonLine(x) {
  try {
    return JSON.stringify(x)
  } catch (e) {
    return JSON.stringify({ error: 'Failed to stringify log payload', reason: String(e) })
  }
}

/**
 * Serialize an error into a plain object preserving stack, name, code.
 * Safe to call with non-Error values.
 */
function serializeError(err) {
  if (!err) return { message: 'unknown_error' }
  if (typeof err === 'string') return { message: err }
  const out = { message: err.message || String(err) }
  if (err.name) out.name = err.name
  if (err.code) out.code = err.code
  if (err.stack) {
    // Keep first 5 stack frames to stay compact
    const lines = err.stack.split('\n')
    out.stack = lines.slice(0, 6).join('\n')
  }
  return out
}

function createJsonlLogger({ enabled, dir, taskId, filePrefix = 'agent' }) {
  const isEnabled = toBool(enabled, true)
  if (!isEnabled) {
    return Object.freeze({
      log: async () => {},
      close: async () => {},
    })
  }

  const logDir = path.resolve(process.cwd(), dir || 'logs')
  const file = path.join(logDir, `${filePrefix}_${taskId}.jsonl`)
  const maxBytes = Number(process.env.LOG_ROTATE_MAX_BYTES || 5 * 1024 * 1024)
  const keepFiles = Number(process.env.LOG_ROTATE_KEEP_FILES || 5)
  let ensured = false

  async function ensure() {
    if (ensured) return
    ensured = true
    await fs.promises.mkdir(logDir, { recursive: true })
  }

  async function rotateIfNeeded() {
    try {
      const st = await fs.promises.stat(file)
      if (!Number.isFinite(maxBytes) || maxBytes <= 0 || st.size < maxBytes) return
    } catch {
      return
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const rotated = path.join(logDir, `${filePrefix}_${taskId}.${ts}.jsonl`)
    try {
      await fs.promises.rename(file, rotated)
    } catch {
      return
    }

    try {
      const entries = await fs.promises.readdir(logDir)
      const prefix = `${filePrefix}_${taskId}.`
      const rotatedFiles = entries
        .filter((name) => name.startsWith(prefix) && name.endsWith('.jsonl'))
        .sort()
      const extra = rotatedFiles.length - Math.max(1, keepFiles)
      if (extra > 0) {
        for (const name of rotatedFiles.slice(0, extra)) {
          await fs.promises.unlink(path.join(logDir, name)).catch(() => {})
        }
      }
    } catch {
      // ignore cleanup issues
    }
  }

  return Object.freeze({
    async log(payload) {
      if (!payload || typeof payload !== 'object') return
      try {
        await ensure()
        await rotateIfNeeded()
        const line = safeJsonLine({
          ts: new Date().toISOString(),
          ...payload,
        })
        await fs.promises.appendFile(file, `${line}\n`, 'utf8')
      } catch {
        // Logging must never break the agent loop.
      }
    },
    async close() {},
  })
}

module.exports = { createJsonlLogger, serializeError }

