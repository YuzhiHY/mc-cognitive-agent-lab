function resolveField(obj, fieldPath) {
  if (!obj || typeof fieldPath !== 'string') return undefined
  const parts = fieldPath.split('.')
  let current = obj
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined
    current = current[part]
  }
  return current
}

function evaluate(op, actual, expected) {
  switch (op) {
    case 'eq': return actual === expected
    case 'neq': return actual !== expected
    case 'gt': return typeof actual === 'number' && actual > expected
    case 'gte': return typeof actual === 'number' && actual >= expected
    case 'lt': return typeof actual === 'number' && actual < expected
    case 'lte': return typeof actual === 'number' && actual <= expected
    case 'exists': return actual !== undefined && actual !== null
    case 'not_exists': return actual === undefined || actual === null
    default: return true
  }
}

function checkPreconditions(preconditions, ctx) {
  if (!Array.isArray(preconditions) || preconditions.length === 0) {
    return { passed: true, failed: [] }
  }

  const failed = []
  for (const cond of preconditions) {
    if (!cond || typeof cond !== 'object') continue
    const { field, op, value } = cond
    if (!field || !op) continue

    const actual = resolveField(ctx, field)
    if (!evaluate(op, actual, value)) {
      failed.push({
        field,
        op,
        expected: value,
        actual: actual === undefined ? 'undefined' : actual,
      })
    }
  }

  return { passed: failed.length === 0, failed }
}

module.exports = { checkPreconditions, resolveField }
