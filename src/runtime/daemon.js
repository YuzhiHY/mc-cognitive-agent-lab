const fs = require('node:fs')
const path = require('node:path')
const { sense, nearestHostileDistance } = require('./sense')
const { createApi } = require('./api')
const { createJsonlLogger } = require('./logger')
const { buildMemoryHint } = require('./memoryHint')
const { createPersonality } = require('./personality')
const { createTaskStateMachine } = require('./taskStateMachine')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nowIso() {
  return new Date().toISOString()
}

function currentThreat(snapshot, bot) {
  if (snapshot?.threat_level) return snapshot.threat_level
  if (!bot) return 'none'
  const d = nearestHostileDistance(bot)
  if (d <= 4.5) return 'high'
  if (d <= 10) return 'low'
  return 'none'
}

function shouldSpeakVoice({ voice, snapshot, isExecuting, recentVoices }) {
  if (!voice || !String(voice).trim()) return false
  const threat = currentThreat(snapshot)
  if (isExecuting || threat === 'high' || threat === 'low') return false
  const normalized = String(voice).trim()
  const compact = normalized.toLowerCase().replace(/\s+/g, '')
  const recent = recentVoices || []
  if (recent.includes(normalized)) return false
  for (const rv of recent) {
    const c = String(rv).toLowerCase().replace(/\s+/g, '')
    if (!c) continue
    if (compact.startsWith(c.slice(0, Math.min(18, c.length)))) return false
    if (c.startsWith(compact.slice(0, Math.min(18, compact.length)))) return false
  }
  return true
}

function voiceCooldownMs(snapshot) {
  const threat = currentThreat(snapshot)
  if (threat === 'high') return 8000
  if (threat === 'low') return 5200
  return 3200
}

function formatVoiceOutput(voice, { taskBusy = false } = {}) {
  const raw = String(voice || '').trim()
  if (!taskBusy) return raw
  const oneLine = raw.split(/[。！？!?]/)[0]?.trim() || raw
  return oneLine.length > 36 ? `${oneLine.slice(0, 36)}...` : oneLine
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
  // Guard common semantic mismatch: navigateToNearestBlock("player")
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
  const success = !!chainResult && chainResult.completed >= chainResult.total && !chainResult.failedStep
  const next = {
    ...prev,
    lastSeenAt: nowIso(),
    successCount: prev.successCount + (success ? 1 : 0),
    failCount: prev.failCount + (success ? 0 : 1),
  }
  await memory.set(key, next)

  if (!success) return
  if (next.promoted) return
  // Replay-verify gate: require an extra successful replay after threshold.
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

function evaluateExpectation({ expectation, chainResult }) {
  if (!expectation) return null
  if (chainResult?.interrupted) {
    return {
      matched: false,
      deviation: 'interrupted_by_reflex',
      cause: 'reflex_interrupt',
      decision: 'replan',
      mood: 'cautious',
    }
  }
  const succeeded = !!chainResult
    && chainResult.completed >= chainResult.total
    && !chainResult.failedStep
    && !chainResult.interrupted
    && Array.isArray(chainResult.results)
    && chainResult.results.every((r) => r?.status === 'success' || r?.ok === true)
  if (succeeded) {
    return {
      matched: true,
      deviation: null,
      cause: null,
      decision: 'keep_method',
      mood: 'calm',
    }
  }
  const failedMsg = chainResult?.failedStep?.error?.message || 'unknown_failure'
  return {
    matched: false,
    deviation: failedMsg,
    cause: 'execution_failed',
    decision: expectation.fallbackHint ? 'replan' : 'ask_user',
    mood: expectation.emotionIfFail || 'confused',
  }
}

function significantWorldStateChange(prev, next) {
  if (!prev || !next) return false
  const prevThreat = String(prev.threat_level || 'none')
  const nextThreat = String(next.threat_level || 'none')
  if (prevThreat !== nextThreat) return true
  const prevHp = Number(prev?.status?.health ?? 20)
  const nextHp = Number(next?.status?.health ?? 20)
  if (Math.abs(prevHp - nextHp) >= 2) return true
  const prevHostiles = Number(prev?.threat_bands?.dangerClose || 0)
  const nextHostiles = Number(next?.threat_bands?.dangerClose || 0)
  if (prevHostiles !== nextHostiles) return true
  return false
}

function createDaemon({
  bot,
  llm,
  personalityLlm,
  reflexLayer,
  centralReasoning,
  chainExecutor,
  memory,
  thinkIntervalMs = 2000,
}) {
  const api = createApi(bot)
  let stopped = false
  let started = false
  let cycleCount = 0
  let lastDamageAt = 0
  let healthListener = null
  let chatListener = null
  let reflexTicker = null
  let activeTask = null
  let lastCycleSnapshot = null
  const stateTransitionTrace = []

  const taskSm = createTaskStateMachine()

  function executionLocked() {
    return taskSm.isExecutionLocked()
  }

  const personalityEnabled =
    String(process.env.PERSONALITY_ENABLED || 'false').toLowerCase() === 'true'
  const personality = createPersonality({
    enabled: personalityEnabled,
    personalityLlm,
    cooldownSteps: process.env.PERSONALITY_TRIGGER_COOLDOWN_STEPS
      ? Number(process.env.PERSONALITY_TRIGGER_COOLDOWN_STEPS)
      : 3,
  })
  const metrics = {
    cycles: 0,
    reflexCount: 0,
    reasoningCount: 0,
    errorCount: 0,
    combatHoldCount: 0,
  }

  const playerMessageQueue = []
  const recentVoices = []
  let lastVoiceAt = 0

  const logger = createJsonlLogger({
    enabled: process.env.LOG_TO_FILE !== undefined ? process.env.LOG_TO_FILE : true,
    dir: process.env.LOG_DIR || 'logs',
    taskId: 'daemon',
    filePrefix: process.env.LOG_FILE_PREFIX || 'agent',
  })

  function chainSucceeded(chainResult) {
    return !!chainResult
      && chainResult.completed >= chainResult.total
      && !chainResult.failedStep
      && !chainResult.interrupted
      && Array.isArray(chainResult.results)
      && chainResult.results.every((r) => r?.status === 'success' || r?.ok === true)
  }

  async function executeInterruptTakeover({
    source = 'cycle',
    interrupt,
    reflexAction,
    snapshot,
    ctx,
  }) {
    if (!interrupt?.shouldInterrupt || !reflexAction) return null
    await logger.log({
      type: 'daemon_reflex',
      cycle: cycleCount,
      action: reflexAction.name,
      reason: reflexAction.reason,
      interruptPriority: interrupt.priority,
      interruptReason: interrupt.interruptReason,
      interruptMetadata: interrupt.metadata || {},
      source,
    })
    try {
      taskSm.setExecutionLock(true, `${source}_reflex_action`)
      await setTaskState('interrupted', {
        reason: `${source}_reflex_takeover`,
        cycle: cycleCount,
        skillName: reflexAction.name,
      })
      try { bot.pathfinder?.setGoal?.(null) } catch { /* */ }
      try { api.clearControlStates?.() } catch { /* */ }
      const reflexResult = typeof reflexLayer.execute === 'function'
        ? await reflexLayer.execute(reflexAction, { api, bot, ctx: ctx || { snapshot } })
        : await reflexAction.execute({ api, bot, ctx: ctx || { snapshot } })
      metrics.reflexCount += 1
      await logger.log({
        type: 'daemon_reflex_result',
        cycle: cycleCount,
        status: reflexResult?.status || null,
        reason: reflexResult?.reason || reflexAction.reason,
        ok: reflexResult?.ok ?? true,
        actionType: reflexResult?.actionType || reflexAction.name,
        interruptPriority: interrupt.priority,
        source,
      })
      taskSm.setExecutionLock(false, `${source}_reflex_done`)
      await setTaskState('recovering', {
        reason: `${source}_reflex_recover`,
        cycle: cycleCount,
        goal: activeTask?.goal || null,
        skillName: reflexAction.name,
      })
      return {
        type: 'reflex',
        action: reflexAction.name,
        interruptPriority: interrupt.priority,
        interruptReason: interrupt.interruptReason,
      }
    } catch (err) {
      metrics.errorCount += 1
      taskSm.setExecutionLock(false, `${source}_reflex_error`)
      await setTaskState('failed', {
        reason: `${source}_reflex_failed`,
        error: err.message || String(err),
        cycle: cycleCount,
        skillName: reflexAction.name,
      })
      await logger.log({
        type: 'daemon_reflex_error',
        cycle: cycleCount,
        action: reflexAction.name,
        error: err.message || String(err),
        source,
      })
      return { type: 'error', error: err.message || String(err) }
    } finally {
      taskSm.setExecutionLock(false, `${source}_reflex_exit`)
    }
  }

  async function setTaskState(state, extra = {}) {
    if (!activeTask) {
      activeTask = {
        id: `daemon-task-${Date.now()}`,
        state: 'pending',
        createdAt: nowIso(),
      }
    }
    // TODO(phase3.5-followup): activeTask.state currently mirrors taskSm state for log payload
    // compatibility. Remove duplicate storage once downstream consumers read taskSm directly.
    const prev = taskSm.getState()
    const tx = taskSm.transition(state, {
      reason: extra.reason || null,
      meta: extra || null,
      force: extra.force === true,
    })
    const cur = taskSm.getState()
    if (!tx?.ok) {
      await logger.log({
        type: 'daemon_state_transition_rejected',
        taskId: activeTask.id,
        from: prev.state,
        to: state,
        reason: tx?.reason || 'invalid_transition',
        cycle: extra.cycle ?? cycleCount,
      })
      return
    }
    activeTask = {
      ...activeTask,
      state: cur.state,
      updatedAt: nowIso(),
      ...extra,
    }
    await logger.log({
      type: 'daemon_task_state',
      taskId: activeTask.id,
      state: activeTask.state,
      reason: extra.reason || null,
      error: extra.error || null,
    })
    await logger.log({
      type: 'daemon_state_transition',
      taskId: activeTask.id,
      from: prev.state,
      to: cur.state,
      executionLock: cur.executionLock,
      reason: extra.reason || null,
      cycle: extra.cycle ?? cycleCount,
      goal: extra.goal || null,
      skillName: extra.skillName || null,
      chainSignature: extra.chainSignature || null,
    })
    stateTransitionTrace.push({
      from: prev.state,
      to: cur.state,
      reason: extra.reason || null,
      executionLock: cur.executionLock,
      cycle: extra.cycle ?? cycleCount,
      goal: extra.goal || null,
      skillName: extra.skillName || null,
      chainSignature: extra.chainSignature || null,
    })
    if (stateTransitionTrace.length > 80) stateTransitionTrace.shift()
  }

  async function runCycle() {
    cycleCount += 1
    metrics.cycles += 1
    const cycleStart = Date.now()
    const snapshot = sense(bot, { radius: 5 })
    const hasSignificantChange = significantWorldStateChange(lastCycleSnapshot, snapshot)
    lastCycleSnapshot = snapshot

    await setTaskState('assessing', { reason: 'cycle_assess', cycle: cycleCount })

    const memoryHint = await buildMemoryHint({
      currentPos: snapshot.status?.position,
      currentSnapshot: snapshot,
    })

    const pendingPlayerMessages = playerMessageQueue.splice(0)

    const ctx = {
      snapshot,
      cycle: cycleCount,
      memory_hint: memoryHint,
      capabilities: typeof api.getCapabilities === 'function' ? api.getCapabilities() : {},
      personality: personality.isEnabled() ? personality.getState() : undefined,
      memorySnapshot: memory ? memory.getAll() : {},
      playerMessages: pendingPlayerMessages.length > 0 ? pendingPlayerMessages : undefined,
    }
    ctx.snapshot.status = {
      ...(ctx.snapshot.status || {}),
      recentDamageMs: lastDamageAt ? (Date.now() - lastDamageAt) : null,
    }

    const highPriorityInterrupt = ctx.snapshot?.close_threat === true
      || (ctx.snapshot?.status?.recentDamageMs != null && ctx.snapshot.status.recentDamageMs < 2500)
    if (executionLocked() && !taskSm.shouldInterruptExecution({
      reflexTriggered: false,
      highPriorityInterrupt,
      significantWorldChange: hasSignificantChange,
    })) {
      await logger.log({
        type: 'daemon_execution_lock_hold',
        cycle: cycleCount,
        reason: 'execution_in_progress',
        state: taskSm.getState().state,
        executionLock: true,
      })
      return { type: 'executing_hold', elapsedMs: Date.now() - cycleStart }
    }

    // Reflex/interrupt arbitration is always checked before planner.
    if (reflexLayer) {
      const interrupt = typeof reflexLayer.arbitrate === 'function'
        ? reflexLayer.arbitrate(snapshot, ctx)
        : {
          shouldInterrupt: !!reflexLayer.check(snapshot, ctx),
          priority: 'high',
          interruptReason: 'legacy_reflex',
          suggestedSkill: null,
          fallbackMode: 'reflex_safe',
          metadata: {},
        }
      if (interrupt?.shouldInterrupt) {
        const reflexAction = reflexLayer.check(snapshot, ctx)
        const out = await executeInterruptTakeover({
          source: 'cycle',
          interrupt,
          reflexAction,
          snapshot,
          ctx,
        })
        if (personality.isEnabled()) {
          try {
            await personality.processEvent(
              { ok: true, result: { done: true } },
              { ...ctx, _reflexAction: reflexAction.name }
            )
          } catch { /* personality must never break daemon */ }
        }
        return { ...(out || { type: 'reflex' }), elapsedMs: Date.now() - cycleStart }
      }
    }

    // Phase 5B: central reasoning (3-phase)
    if (centralReasoning) {
      if (!taskSm.canPlan()) {
        await logger.log({
          type: 'daemon_planner_gate',
          cycle: cycleCount,
          allowed: false,
          reason: 'task_state_machine_canPlan_false',
          state: taskSm.getState().state,
          executionLock: taskSm.getState().executionLock,
        })
        return { type: 'planner_gated', elapsedMs: Date.now() - cycleStart }
      }
      await logger.log({
        type: 'daemon_planner_gate',
        cycle: cycleCount,
        allowed: true,
        reason: 'task_state_machine_canPlan_true',
        state: taskSm.getState().state,
        executionLock: taskSm.getState().executionLock,
      })
      if (typeof reflexLayer?.isCombatMode === 'function' && reflexLayer.isCombatMode()) {
        metrics.combatHoldCount += 1
        await logger.log({
          type: 'daemon_combat_mode_hold',
          cycle: cycleCount,
          threat: snapshot.threat_level,
        })
        metrics.reasoningCount += 1
        return { type: 'combat_mode_hold', elapsedMs: Date.now() - cycleStart }
      }
      try {
        await setTaskState('planning', {
          reason: 'central_reasoning',
          cycle: cycleCount,
          goal: activeTask?.goal || null,
        })
        const decision = await centralReasoning.think({
          ctx,
          bot,
          memory,
          personality,
          logger,
          cycle: cycleCount,
        })

        // Say personality voice in-game chat (gated to avoid spam/repetition/off-task chatter)
        if (personality.isEnabled()) {
          const pState = personality.getState()
          const sayText = formatVoiceOutput(pState?.voice, {
            taskBusy: executionLocked() || !!bot.pathfinder?.goal,
          })
          if (Date.now() - lastVoiceAt > voiceCooldownMs(ctx.snapshot)
              && shouldSpeakVoice({
                voice: sayText,
                snapshot: ctx.snapshot,
                isExecuting: executionLocked(),
                recentVoices,
              })) {
            bot.chat(sayText)
            lastVoiceAt = Date.now()
            recentVoices.push(String(sayText).trim())
            if (recentVoices.length > 4) recentVoices.shift()
          }
        }

        await logger.log({
          type: 'daemon_decision', cycle: cycleCount,
          thought: decision?.thought || null,
          actionChainLength: decision?.actionChain?.length || 0,
          goalHint: decision?.nextGoalHint || null,
        })
        const chainSignature = compactChainSignature(decision?.actionChain || [])

        // Apply memory updates from central LLM
        if (memory && Array.isArray(decision?.memoryUpdates)) {
          for (const update of decision.memoryUpdates) {
            if (update.action === 'remember' && update.key) {
              await memory.set(update.key, update.value)
            } else if (update.action === 'forget' && update.key) {
              await memory.delete(update.key)
            }
          }
        }

        // Phase 5C: execute action chain (refresh snapshot so chain sees live world state)
        if (chainExecutor && Array.isArray(decision?.actionChain) && decision.actionChain.length > 0) {
          const freshSnapshot = sense(bot, { radius: 5 })
          const freshCtx = { ...ctx, snapshot: freshSnapshot }
          taskSm.setExecutionLock(true, 'chain_execute')
          await setTaskState('executing', {
            reason: 'chain_execute',
            cycle: cycleCount,
            goal: decision?.nextGoalHint || null,
            chainSignature,
          })
          const chainResult = await chainExecutor.run({
            chain: decision.actionChain,
            api,
            bot,
            ctx: freshCtx,
            reflexLayer,
            logger,
            cycle: cycleCount,
          })
          await logger.log({
            type: 'daemon_chain_result', cycle: cycleCount,
            completed: chainResult.completed,
            total: chainResult.total,
            interrupted: chainResult.interrupted || false,
            failedStep: chainResult.failedStep || null,
          })

          if (centralReasoning && typeof centralReasoning.setLastChainResult === 'function') {
            centralReasoning.setLastChainResult(chainResult)
          }

          const expectationEval = evaluateExpectation({
            expectation: decision?.expectation,
            chainResult,
          })
          if (expectationEval) {
            await logger.log({
              type: 'expectation_evaluated',
              cycle: cycleCount,
              expectedOutcome: decision.expectation?.expectedOutcome || '',
              confidence: decision.expectation?.confidence ?? 0.5,
              ...expectationEval,
            })
            if (memory) {
              await memory.set(`knowledge:expectation:last:${cycleCount}`, {
                expectedOutcome: decision.expectation?.expectedOutcome || '',
                confidence: decision.expectation?.confidence ?? 0.5,
                ...expectationEval,
                ts: nowIso(),
              })
            }
          }

          await promoteSkillIfStable({
            memory,
            decision,
            chainResult,
            bot,
            logger,
            cycle: cycleCount,
          })

          if (typeof centralReasoning?.evaluateLearnProgress === 'function') {
            await centralReasoning.evaluateLearnProgress({
              memory,
              chainResult,
              decision,
              logger,
              cycle: cycleCount,
            })
          }

          if (personality.isEnabled() && typeof personality.reinforcePreferenceProfile === 'function') {
            try {
              const hints = decision?.personaPreferenceHints
                || decision?.preferenceHints
                || decision?.personalityPreferenceHints
                || []
              const success = chainSucceeded(chainResult)
              const profile = await personality.reinforcePreferenceProfile({
                usedHints: hints,
                success,
                interrupted: !!chainResult.interrupted,
              })
              if (memory && profile) {
                await memory.set('knowledge:persona:preference_profile', profile)
              }
              if (logger && profile) {
                await logger.log({
                  type: 'persona_preference_feedback',
                  cycle: cycleCount,
                  success,
                  interrupted: !!chainResult.interrupted,
                  usedHints: hints,
                  stabilityScore: profile.stabilityScore,
                  strategyBias: profile.strategyBias,
                })
              }
            } catch {
              // preference feedback is optional and must never break loop
            }
          }

          const success = chainSucceeded(chainResult)
          taskSm.setExecutionLock(false, success ? 'chain_completed' : 'chain_failed')
          await setTaskState(success ? 'completed' : 'failed', {
            reason: success ? 'chain_completed' : 'chain_failed',
            error: success ? null : (chainResult.failedStep?.error?.message || 'chain_failed'),
            cycle: cycleCount,
            goal: decision?.nextGoalHint || null,
            chainSignature,
          })
          if (!success) {
            const failedMsg = String(chainResult?.failedStep?.error?.message || '').toLowerCase()
            if (failedMsg.includes('stuck') || failedMsg.includes('no path') || failedMsg.includes('path')) {
              reflexLayer?.noteStuck?.()
            }
            await setTaskState('recovering', {
              reason: 'post_failure_recover',
              cycle: cycleCount,
              goal: decision?.nextGoalHint || null,
              chainSignature,
            })
          }
        } else {
          taskSm.setExecutionLock(false, 'no_chain')
          await setTaskState('completed', {
            reason: 'no_chain',
            cycle: cycleCount,
            goal: decision?.nextGoalHint || null,
          })
        }

        return { type: 'reasoning', elapsedMs: Date.now() - cycleStart }
      } catch (err) {
        metrics.errorCount += 1
        taskSm.setExecutionLock(false, 'reasoning_error')
        await setTaskState('failed', {
          reason: 'reasoning_error',
          error: err.message || String(err),
          cycle: cycleCount,
        })
        await logger.log({
          type: 'daemon_reasoning_error', cycle: cycleCount,
          error: err.message || String(err),
        })
        return { type: 'error', error: err.message, elapsedMs: Date.now() - cycleStart }
      }
    }

    // Fallback: no central reasoning configured yet, just log sense data
    await logger.log({
      type: 'daemon_idle', cycle: cycleCount,
      threat_level: snapshot.threat_level,
      health: snapshot.status?.health,
      entities: snapshot.nearby?.entities?.length || 0,
    })
    return { type: 'idle', elapsedMs: Date.now() - cycleStart }
  }

  async function start() {
    if (started) throw new Error('daemon.start called more than once on same instance')
    started = true
    stopped = false
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      type: 'daemon_start',
      ts: nowIso(),
      thinkIntervalMs,
      personalityEnabled,
      reflexEnabled: !!reflexLayer,
      centralReasoningEnabled: !!centralReasoning,
      chainExecutorEnabled: !!chainExecutor,
      memoryEnabled: !!memory,
    }, null, 2))

    await logger.log({
      type: 'daemon_start', ts: nowIso(), thinkIntervalMs,
    })

    // Real-time damage interrupt: when hit during execution, force a reflex check next cycle
    // TODO(phase3.5-followup): migrate damageInterrupt into taskSm-owned interrupt queue.
    let damageInterrupt = false
    healthListener = () => {
      if (bot.health < (bot._lastDaemonHealth ?? 20)) {
        damageInterrupt = true
        lastDamageAt = Date.now()
        if (typeof reflexLayer?.noteDamage === 'function') reflexLayer.noteDamage()
      }
      bot._lastDaemonHealth = bot.health
    }
    bot.on('health', healthListener)

    // Chat listener: queue player messages for central reasoning + personality reaction
    chatListener = async (username, message) => {
      if (username === bot.username) return
      playerMessageQueue.push({ from: username, text: message, ts: Date.now() })
      if (!personality.isEnabled()) return
      try {
        const brief = `玩家${username}对你说了："${message}"`
        const result = await personality.consultSync(brief)
        const live = sense(bot, { radius: 5, farScan: false })
        const sayText = formatVoiceOutput(result?.voice, {
          taskBusy: executionLocked() || !!bot.pathfinder?.goal,
        })
        if (Date.now() - lastVoiceAt > voiceCooldownMs(live)
            && shouldSpeakVoice({
              voice: sayText,
              snapshot: live,
            isExecuting: executionLocked(),
              recentVoices,
            })) {
          bot.chat(sayText)
          lastVoiceAt = Date.now()
          recentVoices.push(String(sayText).trim())
          if (recentVoices.length > 4) recentVoices.shift()
          await logger.log({
            type: 'daemon_chat_reaction', cycle: cycleCount,
            from: username, message, voice: sayText,
            emotionalTags: result.emotionalTags || [],
          })
        }
      } catch { /* chat reaction must not crash daemon */ }
    }
    bot.on('chat', chatListener)

    // High-frequency reflex ticker:
    // runs independently from slow LLM reasoning so close threats react immediately.
    reflexTicker = setInterval(async () => {
      if (!reflexLayer) return
      const snapshot = sense(bot, { radius: 5, farScan: false })
      const nearest = nearestHostileDistance(bot)
      const emergency = snapshot?.close_threat === true || nearest <= 3.2 || (bot.health ?? 20) <= 6
      if (!emergency) return
      try {
        const interrupt = typeof reflexLayer.arbitrate === 'function'
          ? reflexLayer.arbitrate(snapshot, { snapshot, cycle: cycleCount })
          : null
        if (!interrupt?.shouldInterrupt) return
        const reflexAction = reflexLayer.check(snapshot, { snapshot, cycle: cycleCount })
        if (!reflexAction) return
        // Ignore low-urgency reflexes in high-frequency lane.
        const urgent = ['flee_burst', 'fight_back', 'emergency_jump', 'flee']
        if (!urgent.includes(reflexAction.name)) return
        await logger.log({
          type: 'daemon_fast_reflex',
          cycle: cycleCount,
          action: reflexAction.name,
          reason: reflexAction.reason,
          nearestHostile: nearest,
          health: bot.health,
          interruptPriority: interrupt.priority,
        })
        await executeInterruptTakeover({
          source: 'fast_ticker',
          interrupt,
          reflexAction,
          snapshot,
          ctx: { snapshot, cycle: cycleCount },
        })
      } catch {
        // fast reflex must never crash daemon
        taskSm.setExecutionLock(false, 'fast_reflex_error')
      }
    }, 120)

    while (!stopped) {
      try {
        // If damage was taken mid-execution, run an immediate reflex check
        // Skip if bot is actively digging (unless critical health)
        if (damageInterrupt && reflexLayer && !executionLocked()
            && (!bot.targetDigBlock || (bot.health ?? 20) <= 5)) {
          damageInterrupt = false
          const emergencySnapshot = sense(bot, { radius: 5 })
          const interrupt = typeof reflexLayer.arbitrate === 'function'
            ? reflexLayer.arbitrate(emergencySnapshot, { snapshot: emergencySnapshot, cycle: cycleCount })
            : null
          const reflexAction = reflexLayer.check(emergencySnapshot, {})
          if (reflexAction) {
            await logger.log({
              type: 'daemon_damage_reflex', cycle: cycleCount,
              action: reflexAction.name, reason: reflexAction.reason,
              health: bot.health,
            })
            await executeInterruptTakeover({
              source: 'damage_interrupt',
              interrupt: interrupt || {
                shouldInterrupt: true,
                priority: 'high',
                interruptReason: 'damage_interrupt',
              },
              reflexAction,
              snapshot: emergencySnapshot,
              ctx: { snapshot: emergencySnapshot, cycle: cycleCount },
            })
            continue
          }
        }

        if (!bot.targetDigBlock) {
          const result = await runCycle()
          if (result.type !== 'idle') {
            // eslint-disable-next-line no-console
            console.log(JSON.stringify({
              type: 'daemon_cycle', cycle: cycleCount, ...result,
            }))
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[daemon] cycle ${cycleCount} error:`, err.message)
      }

      const liveSnapshot = sense(bot, { radius: 5, farScan: false })
      const hostileDist = nearestHostileDistance(bot)
      const threat = currentThreat(liveSnapshot, bot)
      const isNight = liveSnapshot?.status?.isNight === true
      const inCombatMode = typeof reflexLayer?.isCombatMode === 'function' && reflexLayer.isCombatMode()
      let pollMs = Math.min(thinkIntervalMs, 700)
      if (inCombatMode) pollMs = 90
      else if (threat === 'high' || hostileDist <= 4.5) pollMs = 120
      else if (threat === 'low' || hostileDist <= 10) pollMs = 200
      else if (isNight) pollMs = Math.min(thinkIntervalMs, 320)
      await sleep(pollMs)
    }

    taskSm.setExecutionLock(false, 'daemon_stop')
    await setTaskState('cooling_down', { reason: 'daemon_stop', force: true, cycle: cycleCount })
    await logger.log({ type: 'daemon_stop', ts: nowIso(), totalCycles: cycleCount })
    const readiness = {
      combatReflexReady: metrics.reflexCount > 0,
      reasoningLoopReady: metrics.reasoningCount > 0,
      errorRate: metrics.cycles > 0 ? Number((metrics.errorCount / metrics.cycles).toFixed(3)) : 0,
      combatHoldCount: metrics.combatHoldCount,
      residualRisks: [
        'Requires live server scenarios for full day/night/combat validation',
      ],
    }
    await logger.log({ type: 'daemon_readiness', ts: nowIso(), ...readiness })
    await logger.close()
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ type: 'daemon_stop', totalCycles: cycleCount }))
  }

  function stop() {
    stopped = true
    if (reflexTicker) {
      clearInterval(reflexTicker)
      reflexTicker = null
    }
    if (healthListener) {
      bot.off('health', healthListener)
      healthListener = null
    }
    if (chatListener) {
      bot.off('chat', chatListener)
      chatListener = null
    }
  }

  function getTaskState() {
    return taskSm.getState()
  }

  function getStateTransitionTrace() {
    return stateTransitionTrace.slice()
  }

  async function runSingleCycleForTest() {
    return runCycle()
  }

  return Object.freeze({
    start,
    stop,
    getTaskState,
    getStateTransitionTrace,
    runSingleCycleForTest,
  })
}

module.exports = { createDaemon }
