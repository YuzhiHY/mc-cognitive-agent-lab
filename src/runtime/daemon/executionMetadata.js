const { compactChainSignature } = require('./skillPromotion')

function inferExecutionMetaFromChain(chain, stableSkills) {
  const arr = Array.isArray(chain) ? chain : []
  const first = arr[0] || null
  const chainSignature = compactChainSignature(arr)
  let interruptible = true
  let skillName = null
  let timeoutMs = null
  if (first?.type === 'skill_ref' && first?.name) {
    skillName = String(first.name)
    const skill = stableSkills?.get?.(skillName)
    if (skill) {
      interruptible = skill.canInterrupt !== false
      timeoutMs = Number(skill.timeoutMs || 0) || null
    }
  } else if (first?.type === 'wait') {
    interruptible = false
    timeoutMs = Number(first.timeoutMs || 0) || null
  }
  return {
    interruptible,
    skillName,
    chainSignature,
    timeoutMs,
    stepType: first?.type || null,
  }
}

module.exports = { inferExecutionMetaFromChain }
