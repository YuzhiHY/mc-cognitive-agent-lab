/**
 * Minimal keyword/heuristic chains to advance explicit user intent without LLM.
 * Used when we must not auto-gather wood but also must not spin on empty wait steps.
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
  return !/\b(oak|log|wood|tree|plank|砍|树|木头|木材)\b/.test(b)
}

function buildIntentAwareChain({ goalText, playerTexts = [], snapshot = null }) {
  const b = blobFrom(goalText, playerTexts)
  if (!b) return []

  // --- Combat / Survival ---
  if (/attack|fight|kill|defend|pvp|打|杀|战斗|干掉|反击/.test(b)) {
    return [{ type: 'skill_ref', name: 'attack_nearest_hostile', args: {} }]
  }
  if (/flee|run away|escape|retreat|逃|跑开|撤退|快跑/.test(b)) {
    return [{ type: 'skill_ref', name: 'retreat_from_threat', args: {} }]
  }
  if (/eat|food|hungry|bread|吃饱|吃东西|吃|饥饿/.test(b)) {
    return [{ type: 'skill_ref', name: 'eat_best_food', args: {} }]
  }

  // --- Navigation / Movement ---
  if (/come here|come to me|follow me|过来|跟我|到我这|来这里/.test(b)) {
    return [{ type: 'navigate', target: 'nearest_player', sprint: true }]
  }
  if (/go to|walk to|move to|navigate to|head to|travel to|去|走到|前往|到/.test(b)) {
    // Try to extract a target from the text
    const targetMatch = b.match(/(?:go to|walk to|move to|navigate to|head to|travel to|去|走到|前往|到)\s*(?:the\s+)?(\S+)/)
    if (targetMatch && targetMatch[1]) {
      const raw = targetMatch[1].replace(/[。，！？,.!?]/g, '')
      if (raw && raw.length > 1) {
        return [{ type: 'skill_ref', name: 'approach_target', args: { target: raw, sprint: true } }]
      }
    }
    return [{ type: 'navigate', target: 'nearest_player', sprint: true }]
  }
  if (/explore|wander|look around|scout|探索|四处看看|逛逛|侦查/.test(b)) {
    return [{ type: 'skill_ref', name: 'approach_target', args: { target: 'oak_log', sprint: true } }]
  }

  // --- Lighting / Utility ---
  if (/torch|light|照明|火把/.test(b)) {
    void snapshot
    return [{ type: 'skill_ref', name: 'place_torch_safely', args: { count: 1 } }]
  }

  // --- Recovery ---
  if (/stuck|卡住|动不了|出不来|挤住/.test(b)) {
    return [{ type: 'skill_ref', name: 'recover_from_stuck', args: {} }]
  }

  // --- Collection ---
  if (/pick up|collect|loot|捡|收集|拾取/.test(b)) {
    return [{ type: 'skill_ref', name: 'collect_nearby_drop', args: {} }]
  }

  // --- Mining / Digging ---
  if (/mine|dig|break|chop|quarry|砍|挖|掘|破坏|gather.*log|get.*log/.test(b)) {
    let block = 'oak_log'
    if (/\bstone\b|石头|原石/.test(b)) block = 'stone'
    else if (/\bdirt\b|泥土/.test(b)) block = 'dirt'
    else if (/iron_ore|铁矿/.test(b)) block = 'iron_ore'
    else if (/coal_ore|煤/.test(b)) block = 'coal_ore'
    else if (/cobble/.test(b)) block = 'cobblestone'
    const m = b.match(/\b([a-z]{2,20}_?(?:log|ore|stone|dirt|sand|gravel))\b/)
    if (m && m[1]) block = m[1].replace(/-/g, '_')
    return [
      { type: 'skill_ref', name: 'approach_target', args: { target: block, sprint: true } },
      { type: 'skill_ref', name: 'mine_named_block', args: { block, maxDistance: 22 } },
    ]
  }

  // --- Crafting ---
  if (/craft|make|build|合成|制作|造个|建造|搭建/.test(b)) {
    let item = 'stick'
    const m = b.match(/\b(wooden_pickaxe|stone_pickaxe|iron_pickaxe|diamond_pickaxe|crafting_table|torch|stick|furnace|oak_planks|chest|wooden_sword|stone_sword)\b/)
    if (m) item = m[1]
    return [{ type: 'skill_ref', name: 'simple_craft_item', args: { item, count: 1 } }]
  }

  // --- Smelting ---
  if (/smelt|furnace|熔炼|烧/.test(b)) {
    let item = 'iron_ingot'
    const m = b.match(/\b(glass|iron_ingot|charcoal|cobblestone)\b/)
    if (m) item = m[1]
    return [{ type: 'smelt', item, count: 1 }]
  }

  return []
}

module.exports = {
  buildIntentAwareChain,
  shouldSuppressAutoWood,
  blobFrom,
}
