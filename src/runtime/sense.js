function round(n, digits = 2) {
  const p = 10 ** digits
  return Math.round(n * p) / p
}

function vec3ToObj(v) {
  if (!v) return null
  return { x: round(v.x, 2), y: round(v.y, 2), z: round(v.z, 2) }
}

function getStatus(bot) {
  const pos = bot.entity?.position
  const yaw = bot.entity?.yaw
  const pitch = bot.entity?.pitch
  return {
    username: bot.username,
    dimension: bot.game?.dimension ?? null,
    position: vec3ToObj(pos),
    yaw: typeof yaw === 'number' ? round(yaw, 3) : null,
    pitch: typeof pitch === 'number' ? round(pitch, 3) : null,
    health: typeof bot.health === 'number' ? round(bot.health, 1) : null,
    food: typeof bot.food === 'number' ? round(bot.food, 1) : null,
    experience: typeof bot.experience?.level === 'number' ? bot.experience.level : null,
    isSleeping: !!bot.isSleeping,
    onGround: bot.entity?.onGround ?? null,
    worldTime: typeof bot.time?.timeOfDay === 'number' ? bot.time.timeOfDay : null,
    isNight: typeof bot.time?.isDay === 'boolean' ? !bot.time.isDay : null,
  }
}

function getInventory(bot) {
  const items = bot.inventory?.items?.() ?? []
  const byName = new Map()
  for (const it of items) {
    const key = it.name || 'unknown'
    byName.set(key, (byName.get(key) || 0) + (it.count || 0))
  }

  const summary = Array.from(byName.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 30)
    .map(([name, count]) => ({ name, count }))

  return {
    slotsUsed: items.length,
    summary,
  }
}

function getNearbyBlocks(bot, radius = 5, limit = 200) {
  const origin = bot.entity?.position
  if (!origin) return []
  if (typeof origin.floored !== 'function' || typeof origin.offset !== 'function') return []

  const blocks = []
  const base = origin.floored()
  const botY = base.y

  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const minDy = -2
      const maxDy = radius
      for (let dy = minDy; dy <= maxDy; dy++) {
        if (blocks.length >= limit) return blocks
        const blockPos = base.offset(dx, dy, dz)
        let b
        try {
          b = bot.blockAt(blockPos)
        } catch { continue }
        if (!b) continue
        if (b.name === 'air') continue
        blocks.push({
          name: b.name,
          pos: { x: b.position.x, y: b.position.y, z: b.position.z },
          rel: { x: dx, y: dy, z: dz },
        })
      }
    }
  }

  return blocks
}

const FAR_SCAN_RESOURCES = [
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
  'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'copper_ore',
  'crafting_table', 'furnace', 'chest',
  'sugar_cane', 'pumpkin', 'melon',
]

function getFarResources(bot, maxDistance = 32) {
  const results = []
  try {
    const mcData = require('minecraft-data')(bot.version)
    const origin = bot.entity?.position
    if (!origin) return results

    for (const name of FAR_SCAN_RESOURCES) {
      const blockType = mcData.blocksByName[name]
      if (!blockType) continue
      const found = bot.findBlock({ matching: blockType.id, maxDistance })
      if (found?.position) {
        const dist = origin.distanceTo(found.position)
        results.push({
          name,
          pos: { x: found.position.x, y: found.position.y, z: found.position.z },
          distance: round(dist, 1),
        })
      }
    }
  } catch { /* minecraft-data or findBlock not available */ }
  return results
}

function getNearestEntities(bot, n = 3) {
  const origin = bot.entity?.position
  if (!origin) return []

  const entities = Object.values(bot.entities ?? {})
    .filter((e) => e && e.position && e.id !== bot.entity?.id)
    .map((e) => {
      const dx = e.position.x - origin.x
      const dy = e.position.y - origin.y
      const dz = e.position.z - origin.z
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      return {
        id: e.id,
        type: e.type ?? null,
        name: e.name ?? null,
        kind: e.kind ?? null,
        username: e.username ?? null,
        distance: round(dist, 2),
        position: vec3ToObj(e.position),
        rel: { x: round(dx, 2), y: round(dy, 2), z: round(dz, 2) },
      }
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, n)

  return entities
}

const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman',
  'witch', 'slime', 'magma_cube', 'blaze', 'ghast', 'wither_skeleton',
  'phantom', 'drowned', 'husk', 'stray', 'pillager', 'vindicator',
  'ravager', 'evoker', 'vex', 'hoglin', 'piglin_brute', 'warden',
  'zombified_piglin', 'guardian', 'elder_guardian', 'shulker',
])

const RESOURCE_CATEGORIES = {
  wood: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'],
  stone: ['stone', 'cobblestone', 'deepslate', 'granite', 'diorite', 'andesite'],
  ore: ['coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'emerald_ore', 'lapis_ore', 'redstone_ore', 'copper_ore', 'deepslate_coal_ore', 'deepslate_iron_ore', 'deepslate_gold_ore', 'deepslate_diamond_ore', 'deepslate_emerald_ore', 'deepslate_lapis_ore', 'deepslate_redstone_ore', 'deepslate_copper_ore'],
  sand: ['sand', 'red_sand', 'gravel'],
  dirt: ['dirt', 'grass_block', 'podzol', 'mycelium'],
  crop: ['wheat', 'carrots', 'potatoes', 'beetroots', 'melon', 'pumpkin', 'sugar_cane', 'bamboo'],
}

const HAZARD_BLOCKS = new Set(['water', 'lava', 'flowing_water', 'flowing_lava'])

function assessThreatLevel(entities) {
  let closestHostileDist = Infinity
  for (const e of entities) {
    const mobName = (e.name || e.kind || '').toLowerCase()
    if (HOSTILE_MOBS.has(mobName)) {
      closestHostileDist = Math.min(closestHostileDist, e.distance)
    }
  }
  if (closestHostileDist <= 5) return 'high'
  if (closestHostileDist <= 10) return 'low'
  return 'none'
}

function hostileDistanceBands(entities) {
  let within2 = 0
  let within4 = 0
  let within8 = 0
  let closest = Infinity
  for (const e of entities || []) {
    const mobName = (e.name || e.kind || '').toLowerCase()
    if (!HOSTILE_MOBS.has(mobName)) continue
    const d = Number(e.distance) || Infinity
    if (d <= 2.8) within2 += 1
    if (d <= 4.5) within4 += 1
    if (d <= 8) within8 += 1
    if (d < closest) closest = d
  }
  return {
    within2,
    within4,
    within8,
    closest: Number.isFinite(closest) ? round(closest, 2) : null,
  }
}

function deriveThreatLevel(entities, status) {
  const bands = hostileDistanceBands(entities)
  const hp = status?.health ?? 20
  const isNight = status?.isNight === true
  if (bands.within2 >= 1) return 'high'
  if (bands.within4 >= 2) return 'high'
  if (bands.within4 >= 1) return hp <= 12 ? 'high' : 'low'
  if (bands.within8 >= 2) return 'low'
  if (bands.within8 >= 1 && isNight) return 'low'
  return 'none'
}

/** O(1) scan from live bot.entities — for daemon interval / reflex without waiting on LLM */
function nearestHostileDistance(bot, maxReasonable = 32) {
  const origin = bot.entity?.position
  if (!origin) return Infinity
  let best = Infinity
  for (const e of Object.values(bot.entities ?? {})) {
    if (!e?.position || e.id === bot.entity?.id) continue
    const name = (e.name || e.kind || '').toLowerCase()
    if (!HOSTILE_MOBS.has(name)) continue
    const d = origin.distanceTo(e.position)
    if (d < best && d <= maxReasonable) best = d
  }
  return best
}

function summarizeResources(blocks) {
  const result = []
  for (const [category, names] of Object.entries(RESOURCE_CATEGORIES)) {
    const nameSet = new Set(names)
    const matching = blocks.filter((b) => nameSet.has(b.name))
    if (matching.length > 0) {
      const uniqueNames = [...new Set(matching.map((b) => b.name))]
      result.push({ type: category, blocks: uniqueNames, count: matching.length })
    }
  }
  return result
}

function detectObstacles(blocks) {
  let water = false
  let lava = false
  let cliff = false

  const yByXZ = new Map()
  for (const b of blocks) {
    if (HAZARD_BLOCKS.has(b.name)) {
      if (b.name.includes('lava')) lava = true
      if (b.name.includes('water')) water = true
    }
    const key = `${b.pos.x},${b.pos.z}`
    const arr = yByXZ.get(key) || []
    arr.push(b.pos.y)
    yByXZ.set(key, arr)
  }

  for (const [, ys] of yByXZ) {
    if (ys.length < 2) continue
    ys.sort((a, b) => a - b)
    for (let i = 1; i < ys.length; i++) {
      if (ys[i] - ys[i - 1] >= 4) { cliff = true; break }
    }
    if (cliff) break
  }

  return { water, lava, cliff }
}

function sense(bot, { radius = 5, farScan = true } = {}) {
  const blocks = getNearbyBlocks(bot, radius)
  const entities = getNearestEntities(bot, 24)
  const farResources = farScan ? getFarResources(bot, 32) : []
  const status = getStatus(bot)
  const bands = hostileDistanceBands(entities)
  const threat = deriveThreatLevel(entities, status)
  const nearestHostile = nearestHostileDistance(bot)

  return {
    ts: Date.now(),
    status,
    inventory: getInventory(bot),
    nearby: {
      blocks,
      entities: entities.slice(0, 5),
    },
    farResources,
    threat_level: threat,
    close_threat: nearestHostile <= 2.8,
    nearest_hostile_distance: Number.isFinite(nearestHostile) ? round(nearestHostile, 2) : null,
    threat_bands: bands,
    resources: summarizeResources(blocks),
    obstacles: detectObstacles(blocks),
  }
}

module.exports = { sense, nearestHostileDistance, HOSTILE_MOBS }

