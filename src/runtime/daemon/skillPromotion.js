const fs = require('node:fs')
const path = require('node:path')

function nowIso() {
  return new Date().toISOString()
}

function compactChainSignature(chain) {
  if (!Array.isArray(chain)) return 'empty'
  return chain
    .map((s) => {
      const t = s?.type || 'unknown'
      if (t === 'dig') return `dig:${s.target || ''}`
      if (t === 'craft') return `craft:${s.item || ''}#${s.count || 1}`
      if (t === 'equip') return `equip:${s.item || ''}`
      if (t === 'navigate') return `nav:${s.target || (s.position ? 'pos' : '')}`
      if (t === 'attack') return `atk:${s.target || 'nearest'}`
      if (t === 'skill') return `skill:${s.skillName || 'anon'}`
      return t
    })
    .join(' -> ')
    .slice(0, 300)
}

function toLearnedKey(signature) {
  return `learned:auto:${signature}`
}

function stepToCodeLine(step) {
  const t = step?.type
  if (t === 'chat') return `await api.chat(${JSON.stringify(String(step.message || ''))})`
  if (t === 'wait') return `await api.sleep(${Number(step.timeoutMs || 800)})`
  if (t === 'craft' && step.item) return `await api.craftItem(${JSON.stringify(step.item)}, ${Number(step.count || 1)})`
  if (t === 'equip' && step.item) return `await api.equipByName(${JSON.stringify(step.item)}, 'hand')`
  if (t === 'navigate') {
    if (step.position && typeof step.position.x === 'number') {
      const p = step.position
      return `await api.navigateTo({ x:${Number(p.x)}, y:${Number(p.y)}, z:${Number(p.z)} }, { sprint:${!!step.sprint} })`
    }
    if (typeof step.target === 'string' && step.target.startsWith('nearest_')) {
      const name = step.target.replace('nearest_', '')
      return `await api.navigateToNearestBlock(${JSON.stringify(name)}, 32, { sprint:${!!step.sprint} })`
    }
  }
  if (t === 'dig' && step.target) return `await api.digByName(${JSON.stringify(step.target)}, { maxDistance: 20, navigate: true })`
  if (t === 'attack') {
    const target = step.target && step.target !== 'nearest' ? JSON.stringify(step.target) : 'undefined'
    return `await api.attackNearest(${target})`
  }
  return null
}

function synthesizeSkillCodeFromChain(chain, skillNameHint = 'auto_chain_skill') {
  const lines = (Array.isArray(chain) ? chain : [])
    .slice(0, 12)
    .map(stepToCodeLine)
    .filter(Boolean)
  if (lines.length === 0) return null
  const skillName = String(skillNameHint || 'auto_chain_skill').replace(/[^a-zA-Z0-9._-]/g, '_')
  return [
    `// Auto-generated from stable action chain: ${skillName}`,
    'module.exports.run = async ({ api, ctx }) => {',
    '  try {',
    ...lines.map((x) => `    ${x}`),
    '    return { done: true, learned: true }',
    '  } catch (err) {',
    '    return { done: false, error: err?.message || String(err) }',
    '  }',
    '}',
    '',
  ].join('\n')
}

function validatePromotableSkill({ code, bot }) {
  const src = String(code || '')
  if (!src.includes('module.exports.run')) return { ok: false, reason: 'missing_run_export' }
  const navMatches = [...src.matchAll(/navigateToNearestBlock\(\s*["']([^"']+)["']/g)]
  if (navMatches.length > 0) {
    try {
      const mcData = require('minecraft-data')(bot?.version || '1.20.1')
      for (const m of navMatches) {
        const blockName = m[1]
        if (!mcData?.blocksByName?.[blockName]) {
          return { ok: false, reason: `invalid_block_target:${blockName}` }
        }
      }
    } catch {
      // If validation data unavailable, keep conservative and allow
    }
  }
  return { ok: true }
}

function chainSucceeded(chainResult) {
  return !!chainResult
    && chainResult.completed >= chainResult.total
    && !chainResult.failedStep
    && !chainResult.interrupted
    && Array.isArray(chainResult.results)
    && chainResult.results.every((r) => r?.status === 'success' || r?.ok === true)
}

async function promoteSkillIfStable({
  memory,
  decision,
  chainResult,
  bot,
  logger,
  cycle,
}) {
  if (!memory || !Array.isArray(decision?.actionChain) || decision.actionChain.length === 0) return
  const signature = compactChainSignature(decision.actionChain)
  const key = toLearnedKey(signature)
  const prev = memory.get(key) || {
    signature,
    successCount: 0,
    failCount: 0,
    promoted: false,
    firstSeenAt: nowIso(),
  }
  const success = chainSucceeded(chainResult)
  const next = {
    ...prev,
    lastSeenAt: nowIso(),
    successCount: prev.successCount + (success ? 1 : 0),
    failCount: prev.failCount + (success ? 0 : 1),
  }
  await memory.set(key, next)

  if (!success) return
  if (next.promoted) return
  if (next.successCount < 3) return
  if (!next.pendingVerification) {
    await memory.set(key, { ...next, pendingVerification: true, pendingSince: nowIso() })
    return
  }
  if (next.successCount < 4) return

  const skillStep = decision.actionChain.find((s) => s?.type === 'skill' && s.code)
  const synthesizedCode = skillStep
    ? String(skillStep.code)
    : synthesizeSkillCodeFromChain(decision.actionChain, 'learned_chain')
  if (!synthesizedCode) return

  const safeSkill = String(skillStep?.skillName || 'learned_chain').replace(/[^a-zA-Z0-9._-]/g, '_')
  const fileBase = `${safeSkill}_auto_${Date.now()}`
  const skillsDir = path.resolve(process.cwd(), 'skills')
  const jsPath = path.join(skillsDir, `${fileBase}.js`)
  const metaPath = path.join(skillsDir, `${fileBase}.meta.json`)

  try {
    const quality = validatePromotableSkill({ code: synthesizedCode, bot })
    if (!quality.ok) {
      await memory.set(key, {
        ...next,
        blocked: true,
        blockedReason: quality.reason,
        pendingVerification: false,
      })
      if (logger) {
        await logger.log({
          type: 'skill_promote_blocked',
          cycle,
          signature,
          reason: quality.reason,
        })
      }
      return
    }

    await fs.promises.mkdir(skillsDir, { recursive: true })
    await fs.promises.writeFile(jsPath, synthesizedCode, 'utf8')
    await fs.promises.writeFile(metaPath, JSON.stringify({
      skillName: fileBase,
      thought: decision.thought || '',
      intent: decision.nextGoalHint || signature,
      tags: ['auto_promoted', 'daemon', skillStep ? 'llm_skill' : 'chain_synthesized'],
      updatedAt: nowIso(),
    }, null, 2), 'utf8')

    await memory.set(`skill:${fileBase}`, {
      skillName: fileBase,
      filePath: jsPath,
      source: 'auto_promoted',
      signature,
      successCount: next.successCount,
      promotedAt: nowIso(),
    })
    await memory.set(key, {
      ...next,
      promoted: true,
      promotedType: skillStep ? 'skill_file' : 'synthesized_skill_file',
      promotedSkillName: fileBase,
      pendingVerification: false,
    })

    if (logger) {
      await logger.log({
        type: 'skill_promoted',
        cycle,
        promotedType: skillStep ? 'skill_file' : 'synthesized_skill_file',
        skillName: fileBase,
        signature,
        successCount: next.successCount,
      })
    }
  } catch (err) {
    if (logger) {
      await logger.log({
        type: 'skill_promote_error',
        cycle,
        error: err.message || String(err),
        signature,
      })
    }
  }
}

module.exports = {
  compactChainSignature,
  toLearnedKey,
  stepToCodeLine,
  synthesizeSkillCodeFromChain,
  validatePromotableSkill,
  chainSucceeded,
  promoteSkillIfStable,
}
