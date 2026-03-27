const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createCandidateSkillManager } = require('../src/runtime/candidateSkillManager')

function makeTempDirs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-pipeline-'))
  const experimentalDir = path.join(base, 'experimental')
  const promotedDir = path.join(base, 'promoted')
  return { experimentalDir, promotedDir, base }
}

function testRegisterExperimental() {
  const { experimentalDir, promotedDir } = makeTempDirs()
  const mgr = createCandidateSkillManager({ experimentalDir, promotedDir })
  const meta = mgr.registerExperimental('test_skill', {
    code: 'module.exports.run = async () => {}',
    intent: 'test',
    tags: ['test'],
    riskLevel: 'low',
  })
  assert.strictEqual(meta.name, 'test_skill')
  assert.strictEqual(meta.origin, 'llm_generated')
  assert.strictEqual(meta.tier, 'experimental')
  assert.strictEqual(meta.successCount, 0)
  assert.strictEqual(meta.quarantined, false)
  assert.strictEqual(meta.promotionEligible, false)

  // Code file exists
  assert.ok(fs.existsSync(path.join(experimentalDir, 'test_skill.js')))
}

function testPromotionAfterSuccesses() {
  const { experimentalDir, promotedDir } = makeTempDirs()
  const mgr = createCandidateSkillManager({ experimentalDir, promotedDir })
  mgr.registerExperimental('promo_skill', { code: '// ok' })

  // 3 successes should make it promotable
  mgr.recordOutcome('promo_skill', { ok: true, reason: 'test1' })
  mgr.recordOutcome('promo_skill', { ok: true, reason: 'test2' })
  const meta = mgr.recordOutcome('promo_skill', { ok: true, reason: 'test3' })
  assert.strictEqual(meta.promotionEligible, true)
  assert.strictEqual(meta.successCount, 3)

  const result = mgr.promote('promo_skill')
  assert.strictEqual(result.ok, true)

  const updated = mgr.getMeta('promo_skill')
  assert.strictEqual(updated.tier, 'promoted')
  assert.strictEqual(updated.approvedForReuse, true)
  assert.ok(fs.existsSync(path.join(promotedDir, 'promo_skill.js')))
}

function testQuarantineAfterFailures() {
  const { experimentalDir, promotedDir } = makeTempDirs()
  const mgr = createCandidateSkillManager({ experimentalDir, promotedDir })
  mgr.registerExperimental('bad_skill', { code: '// bad' })

  mgr.recordOutcome('bad_skill', { ok: false, reason: 'fail1' })
  mgr.recordOutcome('bad_skill', { ok: false, reason: 'fail2' })
  const meta = mgr.recordOutcome('bad_skill', { ok: false, reason: 'fail3' })
  assert.strictEqual(meta.quarantined, true)
  assert.strictEqual(meta.approvedForReuse, false)
  assert.strictEqual(meta.promotionEligible, false)

  // Cannot promote quarantined skill
  const result = mgr.promote('bad_skill')
  assert.strictEqual(result.ok, false)
  assert.ok(result.reason === 'not_eligible' || result.reason === 'quarantined')
}

function testMixedOutcomesNotPromotable() {
  const { experimentalDir, promotedDir } = makeTempDirs()
  const mgr = createCandidateSkillManager({ experimentalDir, promotedDir })
  mgr.registerExperimental('mixed_skill', { code: '// mixed' })

  // 2 success + 2 fail = 50% ratio, below 75% threshold
  mgr.recordOutcome('mixed_skill', { ok: true })
  mgr.recordOutcome('mixed_skill', { ok: false })
  mgr.recordOutcome('mixed_skill', { ok: true })
  const meta = mgr.recordOutcome('mixed_skill', { ok: false })
  assert.strictEqual(meta.promotionEligible, false)
}

function testListAll() {
  const { experimentalDir, promotedDir } = makeTempDirs()
  const mgr = createCandidateSkillManager({ experimentalDir, promotedDir })
  mgr.registerExperimental('skill_a', { code: '// a' })
  mgr.registerExperimental('skill_b', { code: '// b' })
  const list = mgr.listAll()
  assert.strictEqual(list.length, 2)
  assert.ok(list.some((s) => s.name === 'skill_a'))
  assert.ok(list.some((s) => s.name === 'skill_b'))
}

function testIsApproved() {
  const { experimentalDir, promotedDir } = makeTempDirs()
  const mgr = createCandidateSkillManager({ experimentalDir, promotedDir })
  mgr.registerExperimental('check_skill', { code: '// c' })
  assert.strictEqual(mgr.isApproved('check_skill'), false)

  mgr.recordOutcome('check_skill', { ok: true })
  mgr.recordOutcome('check_skill', { ok: true })
  mgr.recordOutcome('check_skill', { ok: true })
  mgr.promote('check_skill')
  assert.strictEqual(mgr.isApproved('check_skill'), true)
}

testRegisterExperimental()
testPromotionAfterSuccesses()
testQuarantineAfterFailures()
testMixedOutcomesNotPromotable()
testListAll()
testIsApproved()
console.log('candidate skill pipeline tests passed')
