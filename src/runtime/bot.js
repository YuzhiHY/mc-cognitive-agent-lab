const mineflayer = require('mineflayer')

function requireEnv(name) {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function reasonText(errOrReason) {
  if (errOrReason == null) return ''
  if (typeof errOrReason === 'string') return errOrReason
  if (errOrReason instanceof Error && errOrReason.message) return String(errOrReason.message)
  try {
    return JSON.stringify(errOrReason)
  } catch {
    return String(errOrReason)
  }
}

function isSlowLoginFailure(text) {
  return typeof text === 'string' && text.includes('slow_login')
}

function isRetryableConnectFailure(text) {
  if (!text) return false
  if (isSlowLoginFailure(text)) return true
  // node-minecraft-protocol: TCP end before spawn often surfaces as end("socketClosed")
  // keepalive: client.end('keepAliveError') or Error client timed out after N ms
  if (/^socketClosed$/i.test(text)) return true
  if (/keepAliveError|client timed out after/i.test(text)) return true
  return /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|timed out|socket hang up|reset by peer|broken pipe/i.test(
    text
  )
}

function safeEndBot(bot, reason) {
  if (!bot) return
  try {
    if (typeof bot.end === 'function') bot.end(reason || 'connect_retry')
  } catch (_) {
    /* ignore */
  }
}

function buildBotOptions({ host, port, username, version }) {
  // Default 2m: library default 30s often coincides with slow handshakes / login stalls
  // (see node-minecraft-protocol client/keepalive.js). Override with MC_CHECK_TIMEOUT_MS.
  const checkMsRaw = process.env.MC_CHECK_TIMEOUT_MS
  const checkMs = checkMsRaw != null && String(checkMsRaw).trim() !== ''
    ? Number(checkMsRaw)
    : 120_000
  const opts = {
    host,
    port,
    username,
    version,
    checkTimeoutInterval: Number.isFinite(checkMs) && checkMs > 0 ? checkMs : 120_000,
  }
  return opts
}

async function createBotOnce({ host, port, username, version, attempt, startedAt }) {
  const bot = mineflayer.createBot(buildBotOptions({ host, port, username, version }))

  let loginAt = null
  const onLogin = () => {
    loginAt = Date.now()
  }
  bot.once('login', onLogin)

  const spawnTimeoutMs = process.env.MC_SPAWN_TIMEOUT_MS
    ? Number(process.env.MC_SPAWN_TIMEOUT_MS)
    : 60_000

  try {
    await new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error(`Timed out waiting for bot spawn after ${spawnTimeoutMs}ms`))
      }, spawnTimeoutMs)

      const finish = (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        cleanup()
        if (err) reject(err)
        else resolve()
      }

      const onSpawn = () => finish(null)
      const onFail = (reason) => {
        const msg = reasonText(reason)
        finish(new Error(msg || 'connection closed before spawn'))
      }
      const onEndBeforeSpawn = (reason) => {
        onFail(reasonText(reason) || 'end before spawn')
      }
      const cleanup = () => {
        bot.off('spawn', onSpawn)
        bot.off('error', onFail)
        bot.off('kicked', onFail)
        bot.off('end', onEndBeforeSpawn)
        bot.removeListener('login', onLogin)
      }

      bot.once('spawn', onSpawn)
      bot.once('error', onFail)
      bot.once('kicked', onFail)
      bot.once('end', onEndBeforeSpawn)
    })
  } catch (err) {
    safeEndBot(bot, 'createBotOnce_failed')
    throw err
  }

  const spawnAt = Date.now()
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      type: 'bot_connect_ok',
      attempt,
      elapsedTotalMs: spawnAt - startedAt,
      elapsedLoginMs: loginAt != null ? loginAt - startedAt : null,
      elapsedSpawnMs: loginAt != null ? spawnAt - loginAt : null,
      username,
      host,
      port,
    })
  )

  if (typeof bot.waitForChunksToLoad === 'function') {
    await bot.waitForChunksToLoad()
  }

  return bot
}

async function createBot({ host, port, username, version }) {
  const resolvedHost = host || requireEnv('MC_HOST')
  const resolvedPort = port || (process.env.MC_PORT ? Number(process.env.MC_PORT) : 25565)
  const resolvedUsername = username || requireEnv('MC_USERNAME')
  const resolvedVersion = version || undefined

  const maxAttempts = Math.max(1, Number(process.env.MC_CONNECT_MAX_ATTEMPTS || 4) || 4)
  const retryMs = Math.max(0, Number(process.env.MC_CONNECT_RETRY_MS || 2500) || 2500)

  let lastErr = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = Date.now()
    try {
      return await createBotOnce({
        host: resolvedHost,
        port: resolvedPort,
        username: resolvedUsername,
        version: resolvedVersion,
        attempt,
        startedAt,
      })
    } catch (err) {
      lastErr = err
      const text = reasonText(err)
      const elapsedMs = Date.now() - startedAt
      // eslint-disable-next-line no-console
      console.error(
        JSON.stringify({
          type: 'bot_connect_failed',
          attempt,
          maxAttempts,
          elapsedMs,
          slowLogin: isSlowLoginFailure(text),
          retryable: isRetryableConnectFailure(text),
          message: text.slice(0, 800),
          hint:
            attempt < maxAttempts && isRetryableConnectFailure(text)
              ? 'retrying (slow_login is often transient; ensure no duplicate username online and MC_VERSION matches server)'
              : 'giving up',
        })
      )
      if (attempt < maxAttempts && isRetryableConnectFailure(text)) {
        await sleep(retryMs)
        continue
      }
      throw err
    }
  }
  throw lastErr || new Error('createBot: exhausted retries')
}

module.exports = { createBot }
