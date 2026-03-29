/**
 * Emergency fallback — used ONLY when LLM is completely unavailable.
 *
 * Design principle (CLAUDE.md):
 *   All decisions go through planner + personality weighting.
 *   This module does NOT make behavioral decisions.
 *   When LLM fails, the only safe action is idle/wait.
 *   The next cycle will retry the LLM.
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
 * Returns an empty chain — caller must handle the empty case as safe idle.
 * No keyword-to-action mapping. All decisions belong to the LLM planner.
 */
function buildIntentAwareChain({ goalText, playerTexts = [], snapshot = null }) {
  void goalText
  void playerTexts
  void snapshot
  return []
}

module.exports = {
  buildIntentAwareChain,
  shouldSuppressAutoWood,
  blobFrom,
}
