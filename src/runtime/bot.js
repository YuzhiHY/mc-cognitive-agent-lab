const mineflayer = require('mineflayer')

function requireEnv(name) {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

async function createBot({ host, port, username, version }) {
  const resolvedHost = host || requireEnv('MC_HOST')
  const resolvedPort = port || (process.env.MC_PORT ? Number(process.env.MC_PORT) : 25565)
  const resolvedUsername = username || requireEnv('MC_USERNAME')
  const resolvedVersion = version || undefined
  const bot = mineflayer.createBot({
    host: resolvedHost,
    port: resolvedPort,
    username: resolvedUsername,
    version: resolvedVersion,
  })

  const spawnTimeoutMs = process.env.MC_SPAWN_TIMEOUT_MS
    ? Number(process.env.MC_SPAWN_TIMEOUT_MS)
    : 60_000

  await new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(`Timed out waiting for bot spawn after ${spawnTimeoutMs}ms`))
    }, spawnTimeoutMs)

    const onSpawn = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      resolve()
    }
    const onError = (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      reject(err)
    }
    const cleanup = () => {
      bot.off('spawn', onSpawn)
      bot.off('error', onError)
      bot.off('kicked', onError)
    }
    bot.on('spawn', onSpawn)
    bot.on('error', onError)
    bot.on('kicked', onError)
  })

  // After login, chunks are often not loaded yet; blockAt() would be empty until columns exist.
  if (typeof bot.waitForChunksToLoad === 'function') {
    await bot.waitForChunksToLoad()
  }

  return bot
}

module.exports = { createBot }

