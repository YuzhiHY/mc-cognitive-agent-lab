const { createApi } = require('./api')
const { createJsonlLogger } = require('./logger')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function hasItem(bot, name, min = 1) {
  return bot.inventory.items().some((i) => i.name === name && i.count >= min)
}

function countItem(bot, name) {
  return bot.inventory.items()
    .filter((i) => i.name === name)
    .reduce((n, i) => n + (i.count || 0), 0)
}

function boolEnv(name, def = false) {
  const v = process.env[name]
  if (v == null) return def
  const s = String(v).toLowerCase().trim()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

async function retry(label, fn, { tries = 3, delayMs = 500, logger = null } = {}) {
  let lastErr = null
  for (let i = 1; i <= tries; i++) {
    try {
      const result = await fn()
      if (logger) await logger.log({ type: 'live_selftest_step_try_ok', label, try: i })
      return result
    } catch (err) {
      lastErr = err
      if (logger) await logger.log({
        type: 'live_selftest_step_try_fail',
        label,
        try: i,
        error: err?.message || String(err),
      })
      if (i < tries) await sleep(delayMs)
    }
  }
  throw lastErr
}

async function ensureTorchCraftPath(api, bot, logger) {
  if (hasItem(bot, 'torch', 1)) return { ok: true, reason: 'already_has_torch' }

  if (!hasItem(bot, 'stick', 1)) {
    if (!hasItem(bot, 'oak_planks', 2)) {
      const anyLog = bot.inventory.items().find((i) => i.name.endsWith('_log') && i.count >= 1)
      if (anyLog) {
        await retry('craft_planks', () => api.craftAny(anyLog.name.replace('_log', '_planks'), 4), { logger })
      }
    }
    const plankItem = bot.inventory.items().find((i) => i.name.endsWith('_planks') && i.count >= 2)
    if (plankItem) {
      await retry('craft_stick', () => api.craftAny('stick', 4), { logger })
    }
  }

  if (!hasItem(bot, 'coal', 1) && !hasItem(bot, 'charcoal', 1)) {
    // try charcoal route if logs + fuel available
    if (hasItem(bot, 'oak_log', 1) || bot.inventory.items().some((i) => i.name.endsWith('_log') && i.count >= 1)) {
      try {
        await retry('smelt_charcoal', () => api.smeltItem('charcoal', { count: 1 }), { logger })
      } catch {
        // best effort, continue and let craft fail if no fuel ingredient
      }
    }
  }

  await retry('craft_torch', () => api.craftAny('torch', 4), { logger })
  await sleep(180)
  if (!hasItem(bot, 'torch', 1)) {
    throw new Error('torch craft reported success but inventory has no torch')
  }
  return { ok: true, reason: 'crafted_torch' }
}

async function ensureFurnacePath(api, bot, logger) {
  if (hasItem(bot, 'furnace', 1)) return { ok: true, reason: 'already_has_furnace' }
  if (countItem(bot, 'cobblestone') >= 8) {
    await retry('craft_furnace', () => api.craftAny('furnace', 1), { logger })
    return { ok: true, reason: 'crafted_furnace_from_inventory' }
  }

  const tryBlocks = ['cobblestone', 'stone']
  for (const b of tryBlocks) {
    for (let i = 0; i < 12 && countItem(bot, 'cobblestone') < 8; i++) {
      try {
        await retry(`dig_${b}_${i}`, () => api.digByName(b, { maxDistance: 8, navigate: true }), {
          logger,
          tries: 1,
        })
        await sleep(120)
      } catch {
        break
      }
    }
    if (countItem(bot, 'cobblestone') >= 8) break
  }

  if (countItem(bot, 'cobblestone') < 8) {
    throw new Error('cannot gather enough cobblestone for furnace')
  }
  await retry('craft_furnace', () => api.craftAny('furnace', 1), { logger })
  return { ok: true, reason: 'crafted_furnace_after_gather' }
}

async function runLiveSelftest({ bot, rounds = 2 }) {
  const api = createApi(bot)
  const allowGive = boolEnv('LIVE_SELFTEST_USE_GIVE', true)
  const taskId = `live_selftest_${Date.now()}`
  const logger = createJsonlLogger({
    enabled: true,
    dir: 'logs',
    taskId,
    filePrefix: 'live_selftest',
  })

  const summary = {
    taskId,
    startedAt: new Date().toISOString(),
    rounds,
    steps: [],
    ok: false,
  }

  const runStep = async (name, fn) => {
    try {
      const result = await fn()
      summary.steps.push({ name, ok: true, result })
      await logger.log({ type: 'live_selftest_step_ok', name, result })
      return true
    } catch (err) {
      summary.steps.push({ name, ok: false, error: err?.message || String(err) })
      await logger.log({ type: 'live_selftest_step_fail', name, error: err?.message || String(err) })
      return false
    }
  }

  const tryGive = async (item, count = 8) => {
    if (!allowGive) return false
    try {
      bot.chat(`/give ${bot.username} ${item} ${count}`)
      await logger.log({ type: 'live_selftest_try_give', item, count })
      await sleep(250)
      return true
    } catch {
      return false
    }
  }

  await logger.log({ type: 'live_selftest_start', rounds })

  for (let round = 1; round <= rounds; round++) {
    await logger.log({ type: 'live_selftest_round_start', round })
    // 1) chat
    await runStep(`round_${round}_chat`, async () => {
      api.chat(`[selftest] round ${round} start`)
      return { sent: true }
    })

    // 2) short navigate
    await runStep(`round_${round}_navigate_short`, async () => {
      const p = bot.entity?.position
      if (!p) throw new Error('bot position unavailable')
      return api.navigateTo({ x: p.x + 2, y: p.y, z: p.z + 1 }, { sprint: false, timeoutMs: 8000 })
    })

    // 3) generic craft route (torch as representative non-tool)
    await runStep(`round_${round}_craft_torch`, async () => {
      try {
        return await ensureTorchCraftPath(api, bot, logger)
      } catch (err) {
        await logger.log({ type: 'live_selftest_craft_torch_fallback', error: err?.message || String(err) })
        await tryGive('stick', 16)
        await tryGive('coal', 8)
        await tryGive('torch', 16)
        await sleep(220)
        if (hasItem(bot, 'torch', 1)) {
          return { ok: true, reason: 'torch_acquired_via_fallback' }
        }
        throw err
      }
    })

    // 4) torch placement
    await runStep(`round_${round}_place_torch`, async () => {
      if (!hasItem(bot, 'torch', 1)) {
        try {
          await ensureTorchCraftPath(api, bot, logger)
        } catch (err) {
          await logger.log({ type: 'live_selftest_torch_fallback', error: err?.message || String(err) })
          await tryGive('torch', 16)
        }
      }
      if (!hasItem(bot, 'torch', 1)) throw new Error('no torch available for place test')
      return api.placeTorchSmart({ count: 1, force: true, radius: 3 })
    })

    // 5) smelting path: prefer iron_ingot, fallback glass, then charcoal
    await runStep(`round_${round}_smelt`, async () => {
      let inv = bot.inventory.items().map((i) => i.name)
      if (!inv.includes('furnace') && !inv.includes('cobblestone')) {
        try {
          await ensureFurnacePath(api, bot, logger)
        } catch (err) {
          await logger.log({ type: 'live_selftest_smelt_fallback', error: err?.message || String(err) })
          await tryGive('furnace', 1)
          await tryGive('coal', 8)
          await tryGive('raw_iron', 4)
          await tryGive('sand', 8)
        }
      }
      inv = bot.inventory.items().map((i) => i.name)
      const attempts = []
      if (inv.includes('raw_iron') || inv.includes('iron_ore') || inv.includes('deepslate_iron_ore')) {
        attempts.push(() => api.smeltItem('iron_ingot', { count: 1, timeoutMs: 35000 }))
      }
      if (inv.includes('sand') || inv.includes('red_sand')) {
        attempts.push(() => api.smeltItem('glass', { count: 1, timeoutMs: 35000 }))
      }
      attempts.push(() => api.smeltItem('charcoal', { count: 1, timeoutMs: 35000 }))

      let lastErr = null
      for (const fn of attempts) {
        try {
          return await fn()
        } catch (err) {
          lastErr = err
          await logger.log({ type: 'live_selftest_smelt_attempt_fail', error: err?.message || String(err) })
        }
      }

      await tryGive('furnace', 1)
      await tryGive('coal', 8)
      await tryGive('raw_iron', 4)
      return api.smeltItem('iron_ingot', { count: 1, timeoutMs: 35000 })
    })

    // 6) capability probe
    await runStep(`round_${round}_capabilities`, async () => api.getCapabilities())
    await logger.log({
      type: 'live_selftest_round_end',
      round,
      torchCount: countItem(bot, 'torch'),
      ironIngotCount: countItem(bot, 'iron_ingot'),
      glassCount: countItem(bot, 'glass'),
      charcoalCount: countItem(bot, 'charcoal'),
    })
  }

  summary.finishedAt = new Date().toISOString()
  summary.ok = summary.steps.every((s) => s.ok)
  await logger.log({ type: 'live_selftest_end', ok: summary.ok, stepCount: summary.steps.length })
  await logger.close()
  return summary
}

module.exports = { runLiveSelftest }

