const { sense, senseTiered, nearestHostileDistance } = require('./sense')
const { createApi } = require('./api')
const { createJsonlLogger } = require('./logger')
const { buildMemoryHint } = require('./memoryHint')
const { createPersonality } = require('./personality')
const { createTaskStateMachine } = require('./taskStateMachine')
const { createInterruptQueue } = require('./interruptQueue')
const {
  noInterrupt,
  systemInterrupt,
} = require('./contracts/interruptDecision')
const { createStableSkillRepository } = require('./skills')
const { createChainRunControl } = require('./chainRunControl')

// Extracted daemon sub-modules (Phase 9)
const { currentThreat, shouldSpeakVoice, voiceCooldownMs, formatVoiceOutput } = require('./daemon/pacingPolicy')
const { compactChainSignature, chainSucceeded, promoteSkillIfStable } = require('./daemon/skillPromotion')
const { evaluateExpectation } = require('./daemon/expectationEvaluator')
const { significantWorldStateChange, buildWorldChangeInterrupt } = require('./daemon/worldStateInterrupt')
const { inferExecutionMetaFromChain } = require('./daemon/executionMetadata')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nowIso() {
  return new Date().toISOString()
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
  let stuckWatchTicker = null
  let currentChainRunControl = null
  let reflexTakeoverInFlight = false
  let lastReflexCooldownKey = null
  let lastReflexCooldownAt = 0
  let stuckWatchLastPos = null
  let stuckWatchLastAt = 0
  const reflexCooldownMs = Number(process.env.REFLEX_TAKEOVER_COOLDOWN_MS || 3800)
  let activeTask = null
  let lastCycleSnapshot = null
  const stateTransitionTrace = []
  const interruptQueue = createInterruptQueue()
  let currentExecutionMeta = null
  let currentSkillMeta = null

  const taskSm = createTaskStateMachine()
  const stableSkills = createStableSkillRepository()

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

  async function executeInterruptTakeover({
    source = 'cycle',
    interrupt,
    reflexAction,
    snapshot,
    ctx,
    policyReason = null,
  }) {
    if (!interrupt?.shouldInterrupt) {
      await logger.log({
        type: 'interrupt_ignored',
        cycle: cycleCount,
        source: interrupt?.source || source,
        shouldInterrupt: false,
        priority: interrupt?.priority || 'low',
        interruptReason: interrupt?.interruptReason || 'no_interrupt',
        matchedRuleId: interrupt?.metadata?.ruleId || null,
        reason: 'decision_false',
        policyReason: 'decision_false',
        currentExecutionSkill: currentExecutionMeta?.skillName || null,
        currentExecutionInterruptible: currentExecutionMeta?.interruptible ?? null,
        fallbackMode: interrupt?.fallbackMode || null,
        executionLock: executionLocked(),
        currentTaskState: taskSm.getState().state,
      })
      return null
    }
    let resolvedReflex = reflexAction
    const damageLike = String(interrupt?.source || '') === 'damage'
      || String(interrupt?.interruptReason || '').includes('damage')
    if (!resolvedReflex && damageLike && typeof reflexLayer?.getDamageFallbackAction === 'function') {
      resolvedReflex = reflexLayer.getDamageFallbackAction(snapshot, ctx)
    }
    if (!resolvedReflex) {
      await logger.log({
        type: 'interrupt_ignored',
        cycle: cycleCount,
        source: interrupt.source || source,
        shouldInterrupt: true,
        priority: interrupt.priority,
        interruptReason: interrupt.interruptReason,
        matchedRuleId: interrupt?.metadata?.ruleId || null,
        reason: 'no_reflex_action_available',
        policyReason: 'no_reflex_action_available',
        currentExecutionSkill: currentExecutionMeta?.skillName || null,
        currentExecutionInterruptible: currentExecutionMeta?.interruptible ?? null,
        fallbackMode: interrupt?.fallbackMode || null,
        executionLock: executionLocked(),
        currentTaskState: taskSm.getState().state,
      })
      return null
    }
    reflexAction = resolvedReflex
    const ruleId = interrupt?.metadata?.ruleId || reflexAction?.id || reflexAction?.name || 'unknown'
    const cooldownKey = `${ruleId}:${reflexAction?.name || 'action'}`
    const nowCooldown = Date.now()
    if (reflexTakeoverInFlight) {
      await logger.log({
        type: 'interrupt_ignored',
        cycle: cycleCount,
        source: interrupt.source || source,
        shouldInterrupt: true,
        priority: interrupt.priority,
        interruptReason: interrupt.interruptReason,
        matchedRuleId: interrupt?.metadata?.ruleId || null,
        reason: 'reflex_takeover_in_flight',
        policyReason: 'reflex_takeover_in_flight',
        executionLock: executionLocked(),
        currentTaskState: taskSm.getState().state,
      })
      return null
    }
    if (cooldownKey === lastReflexCooldownKey
      && Number.isFinite(reflexCooldownMs) && reflexCooldownMs > 0
      && nowCooldown - lastReflexCooldownAt < reflexCooldownMs) {
      await logger.log({
        type: 'interrupt_ignored',
        cycle: cycleCount,
        source: interrupt.source || source,
        shouldInterrupt: true,
        priority: interrupt.priority,
        interruptReason: interrupt.interruptReason,
        matchedRuleId: interrupt?.metadata?.ruleId || null,
        reason: 'reflex_cooldown',
        policyReason: 'reflex_cooldown',
        cooldownMs: reflexCooldownMs,
        cooldownKey,
        executionLock: executionLocked(),
        currentTaskState: taskSm.getState().state,
      })
      return null
    }

    if (currentChainRunControl && !currentChainRunControl.signal.aborted) {
      const ar = interrupt.interruptReason || `${source}_takeover`
      currentChainRunControl.abort(String(ar))
      await logger.log({
        type: 'chain_abort_requested',
        cycle: cycleCount,
        takeoverSource: source,
        reason: String(ar),
        interruptPriority: interrupt.priority,
        matchedRuleId: interrupt?.metadata?.ruleId || null,
      })
    }
    reflexTakeoverInFlight = true
    lastReflexCooldownKey = cooldownKey
    lastReflexCooldownAt = nowCooldown
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
    await logger.log({
      type: 'interrupt_applied',
      cycle: cycleCount,
      source: interrupt.source || source,
      shouldInterrupt: true,
      priority: interrupt.priority,
      interruptReason: interrupt.interruptReason,
      matchedRuleId: interrupt?.metadata?.ruleId || null,
      accepted: true,
      policyReason: policyReason || 'accepted_by_policy',
      currentExecutionSkill: currentExecutionMeta?.skillName || null,
      currentExecutionInterruptible: currentExecutionMeta?.interruptible ?? null,
      fallbackMode: interrupt?.fallbackMode || null,
      executionLock: executionLocked(),
      taskState: taskSm.getState().state,
      goal: activeTask?.goal || null,
      skillName: activeTask?.skillName || null,
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
      reflexTakeoverInFlight = false
      taskSm.setExecutionLock(false, `${source}_reflex_exit`)
    }
  }

  async function setTaskState(state, extra = {}) {
    if (!activeTask) {
      activeTask = {
        id: `daemon-task-${Date.now()}`,
        createdAt: nowIso(),
      }
    }
    // activeTask remains metadata-only; runtime state authority is taskSm.
    const prev = taskSm.getState()
    if (prev.state === state && extra.force !== true) {
      await logger.log({
        type: 'daemon_state_transition_skip',
        taskId: activeTask.id,
        state,
        cycle: extra.cycle ?? cycleCount,
        reason: 'already_in_state',
      })
      return
    }
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
      updatedAt: nowIso(),
      ...extra,
    }
    await logger.log({
      type: 'daemon_task_state',
      taskId: activeTask.id,
      state: cur.state,
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
    const tiered = senseTiered(bot, { radius: 5 }, {
      recentDamageMs: lastDamageAt ? (Date.now() - lastDamageAt) : null,
    })
    const snapshot = tiered.flat
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
      tiered,
      cycle: cycleCount,
      memory_hint: memoryHint,
      capabilities: typeof api.getCapabilities === 'function' ? api.getCapabilities() : {},
      personality: personality.isEnabled() ? personality.getState() : undefined,
      memorySnapshot: memory ? memory.getAll() : {},
      playerMessages: pendingPlayerMessages.length > 0 ? pendingPlayerMessages : undefined,
      runtimeDirectives: {
        primaryGoal: activeTask?.goal || process.env.TASK_GOAL || null,
        hadPlayerMessageBatch: pendingPlayerMessages.length > 0,
      },
    }

    const worldChangeDecision = buildWorldChangeInterrupt({
      changed: hasSignificantChange,
      cycle: cycleCount,
      snapshot: ctx.snapshot,
    })
    const immediateDangerDecision = (ctx.snapshot?.close_threat === true
      || (ctx.snapshot?.status?.recentDamageMs != null && ctx.snapshot.status.recentDamageMs < 2500))
      ? systemInterrupt({
        source: 'system',
        priority: 'high',
        interruptReason: 'high_priority_danger_window',
        metadata: {
          cycle: cycleCount,
          closeThreat: ctx.snapshot?.close_threat === true,
          recentDamageMs: ctx.snapshot?.status?.recentDamageMs ?? null,
        },
      })
      : noInterrupt({ source: 'system', reason: 'no_high_priority_window', metadata: { cycle: cycleCount } })

    const queuedDecision = interruptQueue.peekHighest()
    const pendingDecisions = [
      queuedDecision,
      immediateDangerDecision,
      worldChangeDecision,
    ].filter((d) => d && d.shouldInterrupt)
      .sort((a, b) => {
        const rank = { fatal_immediate: 4, high: 3, medium: 2, low: 1 }
        return (rank[b.priority] || 0) - (rank[a.priority] || 0)
      })
    const topDecision = pendingDecisions[0] || noInterrupt({
      source: 'system',
      reason: 'no_interrupt_candidate',
      metadata: { cycle: cycleCount },
    })

    await logger.log({
      type: 'interrupt_decision',
      cycle: cycleCount,
      source: topDecision.source,
      shouldInterrupt: topDecision.shouldInterrupt,
      priority: topDecision.priority,
      interruptReason: topDecision.interruptReason,
      matchedRuleId: topDecision?.metadata?.ruleId || null,
      executionLock: executionLocked(),
      taskState: taskSm.getState().state,
      goal: activeTask?.goal || null,
      skillName: activeTask?.skillName || null,
    })
    const policy = taskSm.evaluateInterruptPolicy({
      decision: topDecision,
      currentSkillMeta,
      currentExecutionMeta,
      currentState: taskSm.getState().state,
      runtimeMode: taskSm.getState().state === 'recovering' ? 'recovering' : 'normal',
    })
    if (topDecision?.source === 'damage' && policy.accept) interruptQueue.popHighest()

    if (executionLocked() && !policy.accept) {
      await logger.log({
        type: 'interrupt_ignored',
        cycle: cycleCount,
        source: topDecision.source,
        shouldInterrupt: topDecision.shouldInterrupt,
        priority: topDecision.priority,
        interruptReason: topDecision.interruptReason,
        matchedRuleId: topDecision?.metadata?.ruleId || null,
        reason: 'execution_lock_and_policy_reject',
        policyReason: policy.policyReason,
        currentExecutionSkill: currentExecutionMeta?.skillName || null,
        currentExecutionInterruptible: currentExecutionMeta?.interruptible ?? null,
        fallbackMode: topDecision?.fallbackMode || null,
        state: taskSm.getState().state,
        executionLock: true,
        goal: activeTask?.goal || null,
        skillName: activeTask?.skillName || null,
      })
      return { type: 'executing_hold', elapsedMs: Date.now() - cycleStart }
    }

    // Reflex/interrupt arbitration is always checked before planner.
    if (reflexLayer) {
      let interrupt, reflexAction
      if (typeof reflexLayer.arbitrate === 'function') {
        const arbitrated = reflexLayer.arbitrate(snapshot, ctx)
        interrupt = arbitrated.decision
        reflexAction = arbitrated.matchedRule
      } else {
        reflexAction = reflexLayer.check(snapshot, ctx)
        interrupt = reflexAction !== null
          ? {
            shouldInterrupt: true,
            priority: 'high',
            interruptReason: 'legacy_reflex',
            suggestedSkill: null,
            fallbackMode: 'reflex_safe',
            metadata: {},
          }
          : { shouldInterrupt: false }
      }
      if (interrupt?.shouldInterrupt && reflexAction) {
        const reflexPolicy = taskSm.evaluateInterruptPolicy({
          decision: interrupt,
          currentSkillMeta,
          currentExecutionMeta,
          currentState: taskSm.getState().state,
          runtimeMode: taskSm.getState().state === 'recovering' ? 'recovering' : 'normal',
        })
        if (executionLocked() && !reflexPolicy.accept) {
          await logger.log({
            type: 'interrupt_ignored',
            cycle: cycleCount,
            source: interrupt.source || 'reflex',
            shouldInterrupt: interrupt.shouldInterrupt,
            priority: interrupt.priority,
            interruptReason: interrupt.interruptReason,
            matchedRuleId: interrupt?.metadata?.ruleId || null,
            reason: 'reflex_policy_reject',
            policyReason: reflexPolicy.policyReason,
            currentExecutionSkill: currentExecutionMeta?.skillName || null,
            currentExecutionInterruptible: currentExecutionMeta?.interruptible ?? null,
            currentTaskState: taskSm.getState().state,
            fallbackMode: interrupt?.fallbackMode || null,
          })
          return { type: 'executing_hold', elapsedMs: Date.now() - cycleStart }
        }
        const out = await executeInterruptTakeover({
          source: 'cycle',
          interrupt,
          reflexAction,
          snapshot,
          ctx,
          policyReason: reflexPolicy.policyReason,
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

        await logger.log({
          type: 'daemon_decision', cycle: cycleCount,
          thought: decision?.thought || null,
          actionChainLength: decision?.actionChain?.length || 0,
          goalHint: decision?.nextGoalHint || null,
        })
        const chainSignature = compactChainSignature(decision?.actionChain || [])
        currentExecutionMeta = inferExecutionMetaFromChain(decision?.actionChain || [], stableSkills)
        currentSkillMeta = currentExecutionMeta?.skillName
          ? stableSkills.get(currentExecutionMeta.skillName) || null
          : null

        // Align in-game voice with a committed plan (avoid "said X but did Y")
        if (personality.isEnabled()
          && Array.isArray(decision?.actionChain)
          && decision.actionChain.length > 0) {
          const thought = String(decision?.thought || '')
          const skipVoice = thought.includes('fast_fallback: gather nearby oak')
            || thought.includes('defer auto wood')
            || thought.includes('fast_fallback: no clear target')
            || thought.includes('intent_recovery_probe')
          if (!skipVoice) {
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
        }

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
          const freshCtx = {
            ...ctx,
            snapshot: freshSnapshot,
            reportStuck: (reason) => {
              try { reflexLayer?.noteStuck?.() } catch { /* */ }
              void Promise.resolve(logger.log({
                type: 'chain_step_stuck_signal',
                cycle: cycleCount,
                reason: String(reason || 'unknown'),
              })).catch(() => {})
            },
          }
          taskSm.setExecutionLock(true, 'chain_execute')
          await setTaskState('executing', {
            reason: 'chain_execute',
            cycle: cycleCount,
            goal: decision?.nextGoalHint || null,
            chainSignature,
          })
          currentChainRunControl = createChainRunControl()
          stuckWatchLastPos = bot.entity?.position ? bot.entity.position.clone() : null
          stuckWatchLastAt = Date.now()
          let chainResult
          try {
            chainResult = await chainExecutor.run({
              chain: decision.actionChain,
              api,
              bot,
              ctx: freshCtx,
              reflexLayer,
              logger,
              cycle: cycleCount,
              runControl: currentChainRunControl,
            })
          } catch (err) {
            chainResult = {
              completed: 0,
              total: decision.actionChain.length,
              interrupted: false,
              failedStep: { index: 0, type: 'chain', error: { message: err?.message || String(err) } },
              results: [],
            }
            metrics.errorCount += 1
          } finally {
            currentChainRunControl = null
            stuckWatchLastPos = null
          }
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
          currentExecutionMeta = null
          currentSkillMeta = null
        } else {
          taskSm.setExecutionLock(false, 'no_chain')
          await setTaskState('completed', {
            reason: 'no_chain',
            cycle: cycleCount,
            goal: decision?.nextGoalHint || null,
          })
          currentExecutionMeta = null
          currentSkillMeta = null
        }

        return { type: 'reasoning', elapsedMs: Date.now() - cycleStart }
      } catch (err) {
        metrics.errorCount += 1
        taskSm.setExecutionLock(false, 'reasoning_error')
        currentExecutionMeta = null
        currentSkillMeta = null
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

    // Real-time damage interrupt is represented as structured decisions in interruptQueue.
    healthListener = () => {
      if (bot.health < (bot._lastDaemonHealth ?? 20)) {
        lastDamageAt = Date.now()
        if (typeof reflexLayer?.noteDamage === 'function') reflexLayer.noteDamage()
        interruptQueue.enqueue(systemInterrupt({
          source: 'damage',
          priority: 'high',
          interruptReason: 'recent_damage_event',
          metadata: {
            cycle: cycleCount,
            health: bot.health,
          },
        }))
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
      if (!reflexLayer || reflexTakeoverInFlight) return
      const snapshot = sense(bot, { radius: 5, farScan: false })
      const nearest = nearestHostileDistance(bot)
      const emergency = snapshot?.close_threat === true || nearest <= 3.2 || (bot.health ?? 20) <= 6
      if (!emergency) return
      try {
        const arbitrated = typeof reflexLayer.arbitrate === 'function'
          ? reflexLayer.arbitrate(snapshot, { snapshot, cycle: cycleCount })
          : null
        const interrupt = arbitrated?.decision ?? null
        const reflexAction = arbitrated?.matchedRule ?? null
        if (!interrupt?.shouldInterrupt || !reflexAction) return
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
        const fastPolicy = taskSm.evaluateInterruptPolicy({
          decision: interrupt,
          currentSkillMeta,
          currentExecutionMeta,
          currentState: taskSm.getState().state,
          runtimeMode: 'reflex_safe',
        })
        if (!executionLocked() || fastPolicy.accept) {
          await executeInterruptTakeover({
            source: 'fast_ticker',
            interrupt,
            reflexAction,
            snapshot,
            ctx: { snapshot, cycle: cycleCount },
            policyReason: fastPolicy.policyReason,
          })
        } else {
          await logger.log({
            type: 'interrupt_ignored',
            cycle: cycleCount,
            source: interrupt.source || 'reflex',
            shouldInterrupt: interrupt.shouldInterrupt,
            priority: interrupt.priority,
            interruptReason: interrupt.interruptReason,
            matchedRuleId: interrupt?.metadata?.ruleId || null,
            reason: 'fast_ticker_policy_reject',
            policyReason: fastPolicy.policyReason,
            currentExecutionSkill: currentExecutionMeta?.skillName || null,
            currentExecutionInterruptible: currentExecutionMeta?.interruptible ?? null,
            currentTaskState: taskSm.getState().state,
            fallbackMode: interrupt?.fallbackMode || null,
          })
        }
      } catch {
        // fast reflex must never crash daemon
        taskSm.setExecutionLock(false, 'fast_reflex_error')
      }
    }, 120)

    stuckWatchTicker = setInterval(() => {
      try {
        const rc = currentChainRunControl
        if (!rc || rc.signal.aborted) return
        if (taskSm.getState().state !== 'executing') return
        if (!taskSm.isExecutionLocked()) return
        const pos = bot.entity?.position
        if (!pos) return
        const now = Date.now()
        if (!stuckWatchLastPos) {
          stuckWatchLastPos = pos.clone()
          stuckWatchLastAt = now
          return
        }
        if (now - stuckWatchLastAt < 3800) return
        const moved = pos.distanceTo(stuckWatchLastPos)
        if (moved < 0.095) {
          reflexLayer?.noteStuck?.()
          void Promise.resolve(logger.log({
            type: 'daemon_stuck_evidence',
            cycle: cycleCount,
            moved,
            sampleAgeMs: now - stuckWatchLastAt,
            note: 'low_displacement_during_chain',
          })).catch(() => {})
          rc.abort('movement_stuck_timeout')
          void Promise.resolve(logger.log({
            type: 'daemon_stuck_abort_chain',
            cycle: cycleCount,
            moved,
            msSinceSample: now - stuckWatchLastAt,
          })).catch(() => {})
        }
        stuckWatchLastPos = pos.clone()
        stuckWatchLastAt = now
      } catch { /* */ }
    }, 1150)

    while (!stopped) {
      try {
        // If damage was taken mid-execution, run an immediate reflex check
        // Skip if bot is actively digging (unless critical health)
        const queuedDamage = interruptQueue.peekHighest()
        if (queuedDamage?.source === 'damage' && reflexLayer && !reflexTakeoverInFlight
            && (!bot.targetDigBlock || (bot.health ?? 20) <= 5)) {
          const emergencySnapshot = sense(bot, { radius: 5 })
          const interrupt = interruptQueue.popHighest()
          const reflexAction = reflexLayer.check(emergencySnapshot, {})
          const damagePolicy = taskSm.evaluateInterruptPolicy({
            decision: interrupt,
            currentSkillMeta,
            currentExecutionMeta,
            currentState: taskSm.getState().state,
            runtimeMode: taskSm.getState().state === 'recovering' ? 'recovering' : 'normal',
          })
          if (executionLocked() && !damagePolicy.accept) {
            await logger.log({
              type: 'interrupt_ignored',
              cycle: cycleCount,
              source: interrupt?.source || 'damage',
              shouldInterrupt: interrupt?.shouldInterrupt ?? true,
              priority: interrupt?.priority || 'high',
              interruptReason: interrupt?.interruptReason || 'damage_interrupt',
              matchedRuleId: interrupt?.metadata?.ruleId || null,
              reason: 'damage_policy_reject',
              policyReason: damagePolicy.policyReason,
              currentExecutionSkill: currentExecutionMeta?.skillName || null,
              currentExecutionInterruptible: currentExecutionMeta?.interruptible ?? null,
              currentTaskState: taskSm.getState().state,
              fallbackMode: interrupt?.fallbackMode || null,
            })
            continue
          }
          if (reflexAction) {
            await logger.log({
              type: 'daemon_damage_reflex', cycle: cycleCount,
              action: reflexAction.name, reason: reflexAction.reason,
              health: bot.health,
            })
          }
          await executeInterruptTakeover({
            source: 'damage_interrupt',
            interrupt: interrupt || systemInterrupt({
              source: 'damage',
              priority: 'high',
              interruptReason: 'damage_interrupt',
            }),
            reflexAction,
            snapshot: emergencySnapshot,
            ctx: { snapshot: emergencySnapshot, cycle: cycleCount },
            policyReason: damagePolicy.policyReason || 'damage_interrupt_path',
          })
          continue
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
    if (stuckWatchTicker) {
      clearInterval(stuckWatchTicker)
      stuckWatchTicker = null
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

  function enqueueInterruptForTest(decision) {
    return interruptQueue.enqueue(decision)
  }

  return Object.freeze({
    start,
    stop,
    getTaskState,
    getStateTransitionTrace,
    runSingleCycleForTest,
    enqueueInterruptForTest,
  })
}

module.exports = { createDaemon }
