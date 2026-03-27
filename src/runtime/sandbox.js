const vm = require('node:vm')

function createTimeoutError(ms) {
  const err = new Error(`Hard timeout exceeded (${ms}ms)`)
  err.code = 'HARD_TIMEOUT'
  return err
}

function serializeError(err) {
  if (!err) return null
  return {
    name: err.name || 'Error',
    message: String(err.message ?? err),
    stack: err.stack ? String(err.stack) : null,
    code: err.code ?? null,
  }
}

function withTimeout(promise, ms, onTimeout) {
  if (!Number.isFinite(ms) || ms <= 0) return promise
  let t = null
  let timedOut = false
  const timeoutPromise = new Promise((_, reject) => {
    t = setTimeout(async () => {
      timedOut = true
      if (typeof onTimeout === 'function') {
        try { await onTimeout() } catch { /* timeout cleanup is best-effort */ }
      }
      reject(createTimeoutError(ms))
    }, ms)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (t) clearTimeout(t)
    if (!timedOut) return
  })
}

function compileCjsModule(code, { filename = 'skill.js' } = {}) {
  const wrapped = `(function (exports, require, module, __filename, __dirname) {\n${code}\n})`
  const script = new vm.Script(wrapped, { filename })
  return { script }
}

function makeRequire() {
  // Sandboxed skills should not be able to import arbitrary modules.
  // If you want to allow a curated allowlist later, implement it here.
  return function sandboxRequire() {
    throw new Error('require is disabled in sandbox')
  }
}

async function runSkillInSandbox({
  code,
  ctx,
  api,
  timeoutMs = 10_000,
  filename = 'skill.js',
}) {
  const logs = []
  const sandboxConsole = Object.freeze({
    log: (...args) => logs.push({ level: 'log', ts: Date.now(), args }),
    warn: (...args) => logs.push({ level: 'warn', ts: Date.now(), args }),
    error: (...args) => logs.push({ level: 'error', ts: Date.now(), args }),
  })

  const context = vm.createContext({
    console: sandboxConsole,
    setTimeout,
    clearTimeout,
    Promise,
  })

  const { script } = compileCjsModule(code, { filename })
  const fn = script.runInContext(context, { timeout: Math.min(timeoutMs, 2000) })

  const module = { exports: {} }
  const exports = module.exports
  const require = makeRequire()

  try {
    fn(exports, require, module, filename, '/')
  } catch (err) {
    return {
      ok: false,
      error: serializeError(err),
      logs,
    }
  }

  const run = module.exports?.run
  if (typeof run !== 'function') {
    return {
      ok: false,
      error: serializeError(
        new Error('Skill module must export: module.exports.run = async ({ api, ctx }) => { ... }')
      ),
      logs,
    }
  }

  try {
    const result = await withTimeout(Promise.resolve(run({ api, ctx })), timeoutMs)
    return {
      ok: true,
      result,
      logs,
    }
  } catch (err) {
    return {
      ok: false,
      error: serializeError(err),
      logs,
    }
  }
}

module.exports = { runSkillInSandbox, serializeError, withTimeout }

