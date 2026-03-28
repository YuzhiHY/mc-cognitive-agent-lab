/**
 * Emergency keyword fallback — used ONLY when LLM is completely unavailable.
 *
 * Design principle: match only unambiguous, explicit action commands.
 * Do NOT try to parse natural language or Chinese chat — that is the LLM's job.
 * When nothing matches, return [] and let the caller decide a safe default action.
 */

function norm(s) {
  return String(s || '').trim().toLowerCase()
}

function blobFrom(goalText, playerTexts) {
  const parts = [norm(goalText), ...(Array.isArray(playerTexts) ? playerTexts : []).map(norm)]
  return parts.filter(Boolean).join(' ')
}

function shouldSuppressAutoWood(goalText, playerTexts) {
  const b = blobFrom(goalText, playerTexts)
  if (!b) return false
  return !/\b(oak|log|wood|tree|plank)\b/.test(b)
}

/**
 * Build an action chain from explicit, unambiguous intent keywords.
 * Returns [] when nothing matches — caller must handle the empty case.
 */
function buildIntentAwareChain({ goalText, playerTexts = [], snapshot = null }) {
  const b = blobFrom(goalText, playerTexts)
  if (!b) return []
  void snapshot

  // --- Only match clear, unambiguous action verbs ---

  if (/\b(attack|fight|kill|defend)\b/.test(b)) {
    return [{ type: 'skill_ref', name: 'attack_nearest_hostile', args: {} }]
  }
  if (/\b(flee|run away|escape|retreat)\b/.test(b)) {
    return [{ type: 'skill_ref', name: 'retreat_from_threat', args: {} }]
  }
  if (/\b(eat|food|hungry)\b/.test(b)) {
    return [{ type: 'skill_ref', name: 'eat_best_food', args: {} }]
  }
  if (/\b(torch|place.?light)\b/.test(b)) {
    return [{ type: 'skill_ref', name: 'place_torch_safely', args: { count: 1 } }]
  }
  if (/\b(stuck|unstuck)\b/.test(b)) {
    return [{ type: 'skill_ref', name: 'recover_from_stuck', args: {} }]
  }
  if (/\b(pick up|collect|loot)\b/.test(b)) {
    return [{ type: 'skill_ref', name: 'collect_nearby_drop', args: {} }]
  }
  if (/\b(follow me|come here|come to me)\b/.test(b)) {
    return [{ type: 'navigate', target: 'nearest_player', sprint: true }]
  }

  // Mine/dig — only if a known block name is explicitly mentioned
  if (/\b(mine|dig|chop|break)\b/.test(b)) {
    let block = 'oak_log'
    if (/\bstone\b/.test(b)) block = 'stone'
    else if (/\bdirt\b/.test(b)) block = 'dirt'
    else if (/\biron_ore\b/.test(b)) block = 'iron_ore'
    else if (/\bcoal_ore\b/.test(b)) block = 'coal_ore'
    else if (/\bcobblestone\b/.test(b)) block = 'cobblestone'
    else if (/\bsand\b/.test(b)) block = 'sand'
    const m = b.match(/\b([a-z]{2,20}_(?:log|ore|stone|dirt|sand|gravel))\b/)
    if (m && m[1]) block = m[1]
    return [
      { type: 'skill_ref', name: 'approach_target', args: { target: block, sprint: true } },
      { type: 'skill_ref', name: 'mine_named_block', args: { block, maxDistance: 22 } },
    ]
  }

  // Craft — only if an item name is explicitly mentioned
  if (/\b(craft|make)\b/.test(b)) {
    let item = 'stick'
    const m = b.match(/\b(wooden_pickaxe|stone_pickaxe|iron_pickaxe|crafting_table|torch|stick|furnace|oak_planks|wooden_sword|stone_sword|chest)\b/)
    if (m) item = m[1]
    return [{ type: 'skill_ref', name: 'simple_craft_item', args: { item, count: 1 } }]
  }

  if (/\b(smelt)\b/.test(b)) {
    let item = 'iron_ingot'
    const m = b.match(/\b(glass|iron_ingot|charcoal)\b/)
    if (m) item = m[1]
    return [{ type: 'smelt', item, count: 1 }]
  }

  // No match — return empty. Caller decides the fallback action.
  return []
}

module.exports = {
  buildIntentAwareChain,
  shouldSuppressAutoWood,
  blobFrom,
}
