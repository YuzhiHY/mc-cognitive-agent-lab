/**
 * Game Knowledge Builder
 *
 * Generates a dynamic, cycle-specific reference object for the LLM decide phase.
 * Contains only valid options derived from the current snapshot + skill registry,
 * so the LLM's output space is constrained to things that actually exist right now.
 */

const COMMON_CRAFTING_CHAINS = Object.freeze({
  oak_planks: '1 oak_log → 4 oak_planks (手工2x2)',
  birch_planks: '1 birch_log → 4 birch_planks (手工2x2)',
  spruce_planks: '1 spruce_log → 4 spruce_planks (手工2x2)',
  stick: '2 任意_planks → 4 stick (手工2x2)',
  crafting_table: '4 任意_planks → 1 crafting_table (手工2x2)',
  wooden_pickaxe: '3 planks + 2 stick → 需要 crafting_table',
  wooden_axe: '3 planks + 2 stick → 需要 crafting_table',
  wooden_sword: '2 planks + 1 stick → 需要 crafting_table',
  wooden_shovel: '1 plank + 2 stick → 需要 crafting_table',
  stone_pickaxe: '3 cobblestone + 2 stick → 需要 crafting_table',
  stone_axe: '3 cobblestone + 2 stick → 需要 crafting_table',
  stone_sword: '2 cobblestone + 1 stick → 需要 crafting_table',
  furnace: '8 cobblestone → 需要 crafting_table',
  torch: '1 stick + 1 coal/charcoal → 需要 crafting_table',
  chest: '8 planks → 需要 crafting_table',
  iron_pickaxe: '3 iron_ingot + 2 stick → 需要 crafting_table',
  iron_sword: '2 iron_ingot + 1 stick → 需要 crafting_table',
  iron_ingot: '1 raw_iron/iron_ore → 熔炼(furnace + fuel)',
  charcoal: '1 任意_log → 熔炼(furnace + fuel)',
  bread: '3 wheat → 需要 crafting_table',
})

// Blocks not useful as navigation targets
const IGNORE_BLOCKS = new Set([
  'air', 'cave_air', 'void_air', 'bedrock', 'barrier',
  'water', 'lava', 'flowing_water', 'flowing_lava',
])

// Known hostile entity types
const HOSTILE_TYPES = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'enderman',
  'witch', 'slime', 'phantom', 'drowned', 'husk', 'stray',
  'cave_spider', 'blaze', 'ghast', 'magma_cube', 'pillager',
  'vindicator', 'ravager', 'warden', 'piglin_brute',
])

/**
 * Build gameKnowledge from current snapshot + skill registry.
 *
 * @param {object} snapshot - current perception snapshot
 * @param {object} stableSkills - skill repository with list()/get()
 * @param {object} [opts] - { goalHint?: string }
 * @returns {object} gameKnowledge for LLM payload
 */
function buildGameKnowledge(snapshot, stableSkills, opts = {}) {
  const nearby = snapshot?.nearby || {}
  const blocks = Array.isArray(nearby.blocks) ? nearby.blocks : []
  const entities = Array.isArray(nearby.entities) ? nearby.entities : []
  const inventory = Array.isArray(snapshot?.inventory?.summary) ? snapshot.inventory.summary : []

  // --- Nearby block names (deduplicated, raw names) ---
  const blockNameSet = new Set()
  for (const b of blocks) {
    const name = String(b?.name || '').toLowerCase()
    if (name && !IGNORE_BLOCKS.has(name)) blockNameSet.add(name)
  }
  const sortedBlockNames = [...blockNameSet].sort()

  // navigableTargets: for `navigate` action (nearest_ prefix)
  const navigableTargets = sortedBlockNames.map((n) => `nearest_${n}`)
  const hasPlayer = entities.some((e) => e.type === 'player' || e.username)
  if (hasPlayer) navigableTargets.push('nearest_player')

  // blockTargets: raw block names for skill_ref args (approach_target, mine_named_block, etc.)
  const blockTargets = [...sortedBlockNames]
  if (hasPlayer) blockTargets.push('nearest_player')

  // --- Diggable blocks (same set, just raw names) ---
  const diggableBlocks = [...sortedBlockNames]

  // --- Attackable entities ---
  const attackable = []
  for (const e of entities) {
    const name = String(e.name || e.kind || '').toLowerCase()
    if (name && HOSTILE_TYPES.has(name)) {
      if (!attackable.includes(name)) attackable.push(name)
    }
  }

  // --- Inventory items (equippable) ---
  const equippableItems = inventory.map((i) => i.name).filter(Boolean)

  // --- Craftable items (based on what's in inventory) ---
  const invNames = new Set(equippableItems)
  const craftable = []
  const hasLogs = equippableItems.some((n) => n.endsWith('_log'))
  const hasPlanks = equippableItems.some((n) => n.endsWith('_planks'))
  const hasSticks = invNames.has('stick')
  const hasCobble = invNames.has('cobblestone')
  const hasIronIngot = invNames.has('iron_ingot')
  const hasCoal = invNames.has('coal') || invNames.has('charcoal')

  if (hasLogs) craftable.push('oak_planks', 'birch_planks', 'spruce_planks')
  if (hasPlanks) craftable.push('stick', 'crafting_table')
  if (hasPlanks && hasSticks) craftable.push('wooden_pickaxe', 'wooden_axe', 'wooden_sword', 'wooden_shovel')
  if (hasCobble && hasSticks) craftable.push('stone_pickaxe', 'stone_axe', 'stone_sword', 'furnace')
  if (hasIronIngot && hasSticks) craftable.push('iron_pickaxe', 'iron_sword')
  if (hasSticks && hasCoal) craftable.push('torch')
  if (hasPlanks) craftable.push('chest')
  // Deduplicate
  const craftableItems = [...new Set(craftable)]

  // --- Available skills ---
  const skillList = stableSkills && typeof stableSkills.list === 'function'
    ? stableSkills.list()
    : []
  const availableSkills = skillList.map((s) => ({
    name: s.name,
    description: s.description || '',
    args: summarizeSkillArgs(s),
  }))

  // --- Crafting chains (filtered to relevant ones) ---
  const relevantChains = {}
  for (const item of craftableItems) {
    if (COMMON_CRAFTING_CHAINS[item]) {
      relevantChains[item] = COMMON_CRAFTING_CHAINS[item]
    }
  }
  // Always include basic chain entries so LLM knows the dependency tree
  if (hasLogs && !relevantChains.oak_planks) relevantChains.oak_planks = COMMON_CRAFTING_CHAINS.oak_planks
  if (hasPlanks && !relevantChains.stick) relevantChains.stick = COMMON_CRAFTING_CHAINS.stick

  return {
    actionSchema: {
      skill_ref: 'name (from availableSkills), args中的target/block用blockTargets中的值（裸方块名，不带nearest_前缀）',
      navigate: 'target (from navigableTargets, 带nearest_前缀)',
      dig: 'target (from diggableBlocks)',
      craft: 'item (from craftableItems), count (number)',
      equip: 'item (from equippableItems)',
      attack: 'target (from attackableEntities, or "nearest")',
      chat: 'message (string)',
      wait: 'timeoutMs (number, 500-3000)',
      smelt: 'item (string), count (number), fuel (string)',
      place: 'item (from equippableItems)',
    },
    availableSkills,
    navigableTargets,
    blockTargets,
    diggableBlocks,
    craftableItems,
    attackableEntities: attackable,
    equippableItems: equippableItems.slice(0, 15),
    craftingChains: relevantChains,
  }
}

function summarizeSkillArgs(skill) {
  const name = skill.name
  const argMap = {
    approach_target: 'target (from blockTargets, 裸方块名不带nearest_前缀), sprint (boolean)',
    follow_player: 'distance (number, default 3)',
    mine_named_block: 'block (block name), maxDistance (number)',
    attack_nearest_hostile: '(no args needed)',
    retreat_from_threat: '(no args needed)',
    eat_best_food: '(no args needed)',
    collect_nearby_drop: '(no args needed)',
    place_torch_safely: 'count (number)',
    simple_craft_item: 'item (item name), count (number)',
    equip_named_item: 'item (item name)',
    face_target: 'target (block name or position)',
    place_named_block: 'block (block name)',
    recover_from_stuck: '(no args needed)',
  }
  return argMap[name] || '(see skill description)'
}

/**
 * Build anchor facts for personalityBrief — hard facts that LLM cannot omit or soften.
 */
function buildAnchorFacts(snapshot, failureContext) {
  const hp = snapshot?.status?.health ?? 20
  const food = snapshot?.status?.food ?? 20
  const threatLevel = snapshot?.threat_level || 'none'
  const recentDamageMs = snapshot?.status?.recentDamageMs
  const recentlyHurt = typeof recentDamageMs === 'number' && recentDamageMs >= 0 && recentDamageMs < 6000
  const damageSource = snapshot?.status?.damageSource || null
  const damageFromPlayer = recentlyHurt && damageSource?.type === 'player'
  const consecutiveFailures = failureContext?.consecutiveOrRecentFailures || 0
  const entities = Array.isArray(snapshot?.nearby?.entities) ? snapshot.nearby.entities : []
  const nearbyPlayerCount = entities.filter((e) => e.type === 'player' || e.username).length

  const hurtStr = recentlyHurt
    ? (damageFromPlayer ? `是(来自玩家${damageSource.name || ''})` : '是(来自环境/怪物)')
    : '否'

  return {
    healthPercent: Math.round(hp / 20 * 100),
    foodPercent: Math.round(food / 20 * 100),
    threatLevel,
    recentlyHurt,
    damageSource: damageSource?.type || null,
    damageFromPlayer,
    consecutiveFailures,
    nearbyPlayerCount,
    isNight: snapshot?.status?.isNight || false,
    formatted: `HP:${Math.round(hp / 20 * 100)}% 饥饿:${Math.round(food / 20 * 100)}% 威胁:${threatLevel} 连续失败:${consecutiveFailures} 受击:${hurtStr} 附近玩家:${nearbyPlayerCount}`,
  }
}

module.exports = { buildGameKnowledge, buildAnchorFacts, HOSTILE_TYPES }
