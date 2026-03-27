function nowMs() {
  return Date.now()
}

function base({
  ok,
  status,
  source,
  actionType,
  skillName = null,
  startedAt = null,
  endedAt = null,
  reason = null,
  errorMessage = null,
  interruptReason = null,
  retryable = false,
  details = null,
}) {
  const s = Number.isFinite(startedAt) ? startedAt : null
  const e = Number.isFinite(endedAt) ? endedAt : nowMs()
  const durationMs = s != null && e != null ? Math.max(0, e - s) : null
  return Object.freeze({
    ok: !!ok,
    status,
    source: String(source || 'unknown'),
    actionType: String(actionType || 'unknown'),
    skillName: skillName || undefined,
    startedAt: s == null ? undefined : s,
    endedAt: e == null ? undefined : e,
    durationMs: durationMs == null ? undefined : durationMs,
    reason: reason || undefined,
    errorMessage: errorMessage || undefined,
    interruptReason: interruptReason || undefined,
    retryable: !!retryable,
    details: details && typeof details === 'object' ? details : undefined,
  })
}

function successResult({
  source,
  actionType,
  skillName,
  startedAt,
  endedAt,
  reason = 'ok',
  details = null,
}) {
  return base({
    ok: true,
    status: 'success',
    source,
    actionType,
    skillName,
    startedAt,
    endedAt,
    reason,
    details,
  })
}

function failureResult({
  source,
  actionType,
  skillName,
  startedAt,
  endedAt,
  reason = 'failed',
  errorMessage = null,
  retryable = false,
  details = null,
}) {
  return base({
    ok: false,
    status: 'failure',
    source,
    actionType,
    skillName,
    startedAt,
    endedAt,
    reason,
    errorMessage,
    retryable,
    details,
  })
}

function timeoutResult({
  source,
  actionType,
  skillName,
  startedAt,
  endedAt,
  reason = 'timeout',
  errorMessage = null,
  retryable = true,
  details = null,
}) {
  return base({
    ok: false,
    status: 'timeout',
    source,
    actionType,
    skillName,
    startedAt,
    endedAt,
    reason,
    errorMessage,
    retryable,
    details,
  })
}

function interruptedResult({
  source,
  actionType,
  skillName,
  startedAt,
  endedAt,
  interruptReason = 'interrupted',
  details = null,
}) {
  return base({
    ok: false,
    status: 'interrupted',
    source,
    actionType,
    skillName,
    startedAt,
    endedAt,
    reason: 'interrupted',
    interruptReason,
    retryable: true,
    details,
  })
}

function invalidResult({
  source,
  actionType,
  skillName,
  startedAt,
  endedAt,
  reason = 'invalid',
  errorMessage = null,
  details = null,
}) {
  return base({
    ok: false,
    status: 'invalid',
    source,
    actionType,
    skillName,
    startedAt,
    endedAt,
    reason,
    errorMessage,
    retryable: false,
    details,
  })
}

function blockedResult({
  source,
  actionType,
  skillName,
  startedAt,
  endedAt,
  reason = 'blocked',
  errorMessage = null,
  retryable = true,
  details = null,
}) {
  return base({
    ok: false,
    status: 'blocked',
    source,
    actionType,
    skillName,
    startedAt,
    endedAt,
    reason,
    errorMessage,
    retryable,
    details,
  })
}

module.exports = {
  successResult,
  failureResult,
  timeoutResult,
  interruptedResult,
  invalidResult,
  blockedResult,
}

