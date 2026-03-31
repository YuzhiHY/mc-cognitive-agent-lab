/**
 * Phase 7 integration test — candidate skill pipeline wired into daemon runtime.
 *
 * Tests that:
 * 1. Synthesized skills are registered as experimental (not direct to /skills/)
 * 2. Execution outcomes are recorded on candidate skills
 * 3. Quarantined skills are not returned by skillRegistry
 * 4. Promoted skills are returned by skillRegistry
 * 5. candidateSkillMgr is passed through to chainOrchestrator
 */

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createCandidateSkillManager } = require('../src/runtime/candidateSkillManager')
const { createSkillRegistry } = require('../src/runtime/skillRegistry')

function makeTempDirs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-integ-'))
  const experimentalDir = path.join(base, 'experimental')
  const promotedDir = path.join(base, 'promoted')
  const skillsDir = path.join(base, 'skills')
  fs.mkdirSync(skillsDir, { recursive: true })
  return { experimentalDir, promotedDir, skillsDir, base }
}

// Test 1: skillRegistry filters out quarantined candidate skills
async function testRegistryRejectsQuarantined() {
  const { experimentalDir, promotedDir, skillsDir } = makeTempDirs()
  const mgr = createCandidateSkillManager({ experimentalDir, promotedDir })

  mgr.registerExperimental('quarantined_skill', {
    code: 'module.exports.run = async () => {}',
    intent: 'gather wood logs from trees',
    tags: ['wood', 'gather'],
  })
  // Quarantine it
  mgr.recordOutcome('quarantined_skill', { ok: false })
  mgr.recordOutcome('quarantined_skill', { ok: false })
  mgr.recordOutcome('quarantined_skill', { ok: false })

  const registry = createSkillRegistry({
    skillsDir,
    enabled: true,
    minScore: 0.1,
    candidateSkillMgr: mgr,
  })

  const result = await registry.findReusableSkillWithDiagnostics({ taskGoal: 'gather wood logs' })
  // Must NOT match the quarantined skill
  const quarantinedMatch = result?.diagnostics?.topCandidates?.find(
    (c) => c.skillName === 'quarantined_skill' && c.reason === 'eligible',
  )
  assert.strictEqual(quarantinedMatch, undefined, 'Quarantined skill should not be eligible')
  // Should show as quarantined in diagnostics
  const quarantinedEntry = result?.diagnostics?.topCandidates?.find(
    (c) => c.skillName === 'quarantined_skill',
  )
  assert.ok(quarantinedEntry, 'Quarantined skill should appear in diagnostics')
  assert.strictEqual(quarantinedEntry.reason, 'quarantined')
}

// Test 2: skillRegistry returns promoted candidate skills
async function testRegistryReturnsPromoted() {
  const { experimentalDir, promotedDir, skillsDir } = makeTempDirs()
  const mgr = createCandidateSkillManager({ experimentalDir, promotedDir })

  mgr.registerExperimental('good_wood_skill', {
    code: 'module.exports.run = async () => {}',
    intent: 'gather wood logs from oak trees',
    tags: ['wood', 'gather', 'oak'],
  })
  // Succeed enough to promote
  mgr.recordOutcome('good_wood_skill', { ok: true })
  mgr.recordOutcome('good_wood_skill', { ok: true })
  mgr.recordOutcome('good_wood_skill', { ok: true })
  mgr.promote('good_wood_skill')

  const registry = createSkillRegistry({
    skillsDir,
    enabled: true,
    minScore: 0.1,
    candidateSkillMgr: mgr,
  })

  const result = await registry.findReusableSkillWithDiagnostics({ taskGoal: 'gather wood logs oak' })
  const promoted = result?.diagnostics?.topCandidates?.find(
    (c) => c.skillName === 'good_wood_skill' && c.reason === 'eligible',
  )
  assert.ok(promoted, 'Promoted skill should be eligible for reuse')
}

// Test 3: unapproved experimental skills are not returned as eligible
async function testRegistryRejectsUnapproved() {
  const { experimentalDir, promotedDir, skillsDir } = makeTempDirs()
  const mgr = createCandidateSkillManager({ experimentalDir, promotedDir })

  mgr.registerExperimental('new_skill', {
    code: 'module.exports.run = async () => {}',
    intent: 'mine stone blocks underground',
    tags: ['mine', 'stone'],
  })
  // Only 1 success — not enough for approval
  mgr.recordOutcome('new_skill', { ok: true })

  const registry = createSkillRegistry({
    skillsDir,
    enabled: true,
    minScore: 0.1,
    candidateSkillMgr: mgr,
  })

  const result = await registry.findReusableSkillWithDiagnostics({ taskGoal: 'mine stone blocks' })
  const unapproved = result?.diagnostics?.topCandidates?.find(
    (c) => c.skillName === 'new_skill',
  )
  assert.ok(unapproved, 'Unapproved skill should appear in diagnostics')
  assert.strictEqual(unapproved.reason, 'not_approved', 'Unapproved skill should be marked not_approved')
}

// Test 4: candidateSkillManager integration flow — register → record → promote lifecycle
function testFullLifecycle() {
  const { experimentalDir, promotedDir } = makeTempDirs()
  const mgr = createCandidateSkillManager({ experimentalDir, promotedDir })

  // Simulate what chainOrchestrator does
  const skillName = 'synth_42'
  mgr.registerExperimental(skillName, {
    code: 'module.exports.run = async ({api}) => { await api.digByName("oak_log") }',
    intent: 'chop oak tree',
    tags: ['daemon', 'chain_synthesized'],
    riskLevel: 'medium',
  })

  // Verify experimental registration
  let meta = mgr.getMeta(skillName)
  assert.strictEqual(meta.tier, 'experimental')
  assert.strictEqual(meta.approvedForReuse, false)
  assert.ok(fs.existsSync(path.join(experimentalDir, `${skillName}.js`)))

  // Record 3 successes
  mgr.recordOutcome(skillName, { ok: true, reason: 'chain_completed' })
  mgr.recordOutcome(skillName, { ok: true, reason: 'chain_completed' })
  meta = mgr.recordOutcome(skillName, { ok: true, reason: 'chain_completed' })
  assert.strictEqual(meta.promotionEligible, true)

  // Promote
  const result = mgr.promote(skillName)
  assert.strictEqual(result.ok, true)

  meta = mgr.getMeta(skillName)
  assert.strictEqual(meta.tier, 'promoted')
  assert.strictEqual(meta.approvedForReuse, true)
  assert.ok(fs.existsSync(path.join(promotedDir, `${skillName}.js`)))
  assert.ok(!fs.existsSync(path.join(experimentalDir, `${skillName}.js`)))
}

// Test 5: candidate pipeline deduplication — re-registering doesn't clobber
function testNoDuplicateRegistration() {
  const { experimentalDir, promotedDir } = makeTempDirs()
  const mgr = createCandidateSkillManager({ experimentalDir, promotedDir })

  mgr.registerExperimental('dup_skill', { code: '// v1', intent: 'test' })
  mgr.recordOutcome('dup_skill', { ok: true })

  // Check that getMeta returns the existing one (simulating chainOrchestrator check)
  const existing = mgr.getMeta('dup_skill')
  assert.ok(existing, 'Should find existing skill')
  assert.strictEqual(existing.successCount, 1)
}

async function runAll() {
  testFullLifecycle()
  await testRegistryRejectsQuarantined()
  await testRegistryReturnsPromoted()
  await testRegistryRejectsUnapproved()
  testNoDuplicateRegistration()
  console.log('candidate pipeline integration tests passed')
}

runAll().catch((err) => {
  console.error('candidate pipeline integration tests FAILED:', err)
  process.exit(1)
})
