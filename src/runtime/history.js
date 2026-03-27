function safeString(v, limit = 200) {
  return String(v).slice(0, limit)
}

function sanitizeErrorForLLM(error) {
  if (!error || typeof error !== 'object') return error
  return {
    name: safeString(error.name ?? 'Error', 80),
    message: safeString(error.message ?? error, 2000),
    stack: typeof error.stack === 'string' ? safeString(error.stack, 3000) : null,
    code: error.code ?? null,
  }
}

function sanitizeExecutionForLLM(execution) {
  if (!execution || typeof execution !== 'object') return execution
  const out = {
    ok: execution.ok,
    result: execution.result,
    error: execution.error ? sanitizeErrorForLLM(execution.error) : null,
  }

  if (Array.isArray(execution.logs)) {
    const logs = execution.logs.slice(-10).map((l) => ({
      level: l.level,
      ts: l.ts,
      args: Array.isArray(l.args) ? l.args.map((a) => safeString(a, 200)) : [],
    }))
    out.logs = logs
  }

  return out
}

function sanitizeHistoryEntryForLLM(entry) {
  if (!entry || typeof entry !== 'object') return entry
  const out = { ...entry }
  if (out.error) out.error = sanitizeErrorForLLM(out.error)
  if (out.execution) out.execution = sanitizeExecutionForLLM(out.execution)
  return out
}

function truncateHistoryForLLM(history, { maxItems = 20, maxChars = 8000 } = {}) {
  const safeMaxItems = Number.isFinite(maxItems) && maxItems > 0 ? maxItems : 20
  const safeMaxChars = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 8000

  const sanitized = history.map(sanitizeHistoryEntryForLLM)
  let trimmed = sanitized.slice(-safeMaxItems)

  // Ensure we stay under a rough payload size limit.
  while (trimmed.length > 1) {
    const asText = JSON.stringify(trimmed)
    if (asText.length <= safeMaxChars) break
    trimmed.shift()
  }

  return trimmed
}

module.exports = { truncateHistoryForLLM }

