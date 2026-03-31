/**
 * Daemon — thin composition shell (Phase 9.5).
 *
 * Creates shared state, instantiates sub-orchestrators, composes runCycle
 * as a pipeline of gate evaluators + orchestrators, and owns the main loop.
 *
 * Orchestration responsibilities are delegated to:
 *   interruptGate    — rank + evaluate interrupt candidates
 *   reflexGate       — reflex arbitration + policy
 *   plannerGate      — planning eligibility
 *   interruptExecutor — full interrupt takeover lifecycle
 *   chainOrchestrator — plan → execute → post-process pipeline
 *   eventReactor     — health/chat/reflex/stuck event wiring
 *   voiceController  — voice output dedup + cooldown
 *   taskStateHelper  — state transition bridge with logging
 */

const { sense, senseTiered, nearestHostileDistance } = require('./sense')
const { createApi } = require('./api')
const { createJsonlLogger, serializeError } = require('./logger')
const { buildMemoryHint } = require('./memoryHint')
const { createPersonality } = require('./personality')
const { createTaskStateMachine } = require('./taskStateMachine')
const { createInterruptQueue } = require('./interruptQueue')
const { systemInterrupt } = require('./contracts/interruptDecision')
const { createStableSkillRepository } = require('./skills')
const { createMemorySystem } = require('./memory2')
const { createCandidateSkillManager } = require('./candidateSkillManager')

// Phase 9 pure-function modules
const { currentThreat } = require('./daemon/pacingPolicy')
const { significantWorldStateChange, buildWorldChangeInterrupt } = require('./daemon/worldStateInterrupt')

// Phase 9.5 orchestration modules
const { createSharedState } = require('./daemon/sharedState')
const { createTaskStateHelper } = require('./daemon/taskStateHelper')
const { evaluateInterruptGate } = require('./daemon/interruptGate')
const { evaluateReflexGate } = require('./daemon/reflexGate')
const { evaluatePlannerGate } = require('./daemon/plannerGate')
const { createInterruptExecutor } = require('./daemon/interruptExecutor')
const { createChainOrchestrator } = require('./daemon/chainOrchestrator')
const { createVoiceController } = require('./daemon/voiceController')
const { createEventReactor } = require('./daemon/eventReactor')
const { logCycleSummary } = require('./daemon/cycleLogger')

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
  const taskSm = createTaskStateMachine()
  const stableSkills = createStableSkillRepository()
  const interruptQueue = createInterruptQueue()
  const shared = createSharedState()
  const candidateSkillMgr = createCandidateSkillManager()

  const personalityEnabled =
    String(process.env.PERSONALITY_ENABLED || 'false').toLowerCase() === 'true'
  const personality = createPersonality({
    enabled: personalityEnabled,
    personalityLlm,
    cooldownSteps: process.env.PERSONALITY_TRIGGER_COOLDOWN_STEPS
      ? Number(process.env.PERSONALITY_TRIGGER_COOLDOWN_STEPS)
      : 3,
  })

  const logger = createJsonlLogger({
    enabled: process.env.LOG_TO_FILE !== undefined ? process.env.LOG_TO_FILE : true,
    dir: process.env.LOG_DIR || 'logs',
    taskId: 'daemon',
    filePrefix: process.env.LOG_FILE_PREFIX || 'agent',
  })

  // --- Memory system v2 ---
  const memoryDir = process.env.MEMORY_DIR || 'memory'
  const memorySystem = createMemorySystem({ memory, memoryDir })

  // --- Sub-orchestrator wiring ---

  const { setTaskState } = createTaskStateHelper({ taskSm, logger, shared })

  const interruptExecutor = createInterruptExecutor({
    reflexLayer, taskSm, api, bot, logger, shared, setTaskState,
  })

  const voiceController = createVoiceController({
    bot, personality, logger, shared,
  })

  const chainOrch = createChainOrchestrator({
    centralReasoning, chainExecutor, reflexLayer, taskSm, api, bot,
    memory, personality, logger, shared, setTaskState, stableSkills, voiceController,
    memorySystem, candidateSkillMgr,
  })

  const eventReactor = createEventReactor({
    bot, reflexLayer, taskSm, interruptQueue, logger, shared,
    interruptExecutor, voiceController, personality,
    workingMemory: memorySystem.workingMemory,
    promotionEngine: memorySystem.promotionEngine,
  })

  // --- Convenience ---

  function executionLocked() {
    return taskSm.isExecutionLocked()
  }

  // --- Core cycle ---

  async function runCycle() {
    shared.cycleCount += 1
    shared.metrics.cycles += 1
    const cycleStart = Date.now()

    // 0. Working memory maintenance
    memorySystem.workingMemory.decay(shared.cycleCount)

    // 1. Sense
    const dmgSource = typeof reflexLayer?.getLastDamageSource === 'function'
      ? reflexLayer.getLastDamageSource()
      : null
    const tiered = senseTiered(bot, { radius: 5 }, {
      recentDamageMs: shared.lastDamageAt ? (Date.now() - shared.lastDamageAt) : null,
      damageSource: dmgSource && dmgSource.at && (Date.now() - dmgSource.at < 6000)
        ? dmgSource
        : null,
    })
    const snapshot = tiered.flat
    const hasSignificantChange = significantWorldStateChange(shared.lastCycleSnapshot, snapshot)
    shared.lastCycleSnapshot = snapshot

    await setTaskState('assessing', { reason: 'cycle_assess', cycle: shared.cycleCount })

    const memoryHint = await buildMemoryHint({
      currentPos: snapshot.status?.position,
      currentSnapshot: snapshot,
    })

    const pendingPlayerMessages = shared.playerMessageQueue.splice(0)

    const ctx = {
      snapshot,
      tiered,
      cycle: shared.cycleCount,
      memory_hint: memoryHint,
      capabilities: typeof api.getCapabilities === 'function' ? api.getCapabilities() : {},
      personality: personality.isEnabled() ? personality.getState() : undefined,
      memorySnapshot: memory ? memory.getAll() : {},
      playerMessages: pendingPlayerMessages.length > 0 ? pendingPlayerMessages : undefined,
      memorySystem,
      runtimeDirectives: {
        primaryGoal: shared.activeTask?.goal || process.env.TASK_GOAL || null,
        hadPlayerMessageBatch: pendingPlayerMessages.length > 0,
      },
    }

    // 2. Interrupt gate
    const worldChangeDecision = buildWorldChangeInterrupt({
      changed: hasSignificantChange,
      cycle: shared.cycleCount,
      snapshot: ctx.snapshot,
    })
    const queuedDecision = interruptQueue.peekHighest()

    const gate = evaluateInterruptGate({
      snapshot,
      cycleCount: shared.cycleCount,
      queuedDecision,
      worldChangeDecision,
      taskSm,
      shared,
    })

    await logger.log({
      type: 'interrupt_decision',
      cycle: shared.cycleCount,
      source: gate.topDecision.source,
      shouldInterrupt: gate.topDecision.shouldInterrupt,
      priority: gate.topDecision.priority,
      interruptReason: gate.topDecision.interruptReason,
      matchedRuleId: gate.topDecision?.metadata?.ruleId || null,
      executionLock: executionLocked(),
      taskState: taskSm.getState().state,
      goal: shared.activeTask?.goal || null,
      skillName: shared.activeTask?.skillName || null,
    })

    if (gate.topDecision?.source === 'damage' && gate.policy.accept) interruptQueue.popHighest()

    if (gate.holdExecution) {
      await logger.log({
        type: 'interrupt_ignored',
        cycle: shared.cycleCount,
        source: gate.topDecision.source,
        shouldInterrupt: gate.topDecision.shouldInterrupt,
        priority: gate.topDecision.priority,
        interruptReason: gate.topDecision.interruptReason,
        matchedRuleId: gate.topDecision?.metadata?.ruleId || null,
        reason: 'execution_lock_and_policy_reject',
        policyReason: gate.policy.policyReason,
        currentExecutionSkill: shared.currentExecutionMeta?.skillName || null,
        currentExecutionInterruptible: shared.currentExecutionMeta?.interruptible ?? null,
        fallbackMode: gate.topDecision?.fallbackMode || null,
        state: taskSm.getState().state,
        executionLock: true,
        goal: shared.activeTask?.goal || null,
        skillName: shared.activeTask?.skillName || null,
      })
      return { type: 'executing_hold', elapsedMs: Date.now() - cycleStart }
    }

    // 3. Reflex gate
    const reflex = evaluateReflexGate({
      reflexLayer, snapshot, ctx, taskSm, shared,
    })
    if (reflex) {
      if (reflex.holdExecution) {
        await logger.log({
          type: 'interrupt_ignored',
          cycle: shared.cycleCount,
          source: reflex.interrupt.source || 'reflex',
          shouldInterrupt: reflex.interrupt.shouldInterrupt,
          priority: reflex.interrupt.priority,
          interruptReason: reflex.interrupt.interruptReason,
          matchedRuleId: reflex.interrupt?.metadata?.ruleId || null,
          reason: 'reflex_policy_reject',
          policyReason: reflex.policy.policyReason,
          currentExecutionSkill: shared.currentExecutionMeta?.skillName || null,
          currentExecutionInterruptible: shared.currentExecutionMeta?.interruptible ?? null,
          currentTaskState: taskSm.getState().state,
          fallbackMode: reflex.interrupt?.fallbackMode || null,
        })
        return { type: 'executing_hold', elapsedMs: Date.now() - cycleStart }
      }
      const out = await interruptExecutor.executeTakeover({
        source: 'cycle',
        interrupt: reflex.interrupt,
        reflexAction: reflex.reflexAction,
        snapshot,
        ctx,
        policyReason: reflex.policy.policyReason,
      })
      if (personality.isEnabled()) {
        try {
          await personality.processEvent(
            { ok: true, result: { done: true } },
            { ...ctx, _reflexAction: reflex.reflexAction.name },
          )
        } catch { /* personality must never break daemon */ }
      }
      return { ...(out || { type: 'reflex' }), elapsedMs: Date.now() - cycleStart }
    }

    // 4. Planner gate
    if (centralReasoning) {
      const planGate = evaluatePlannerGate({
        taskSm, reflexLayer, snapshot, cycleCount: shared.cycleCount,
      })
      await logger.log({
        type: 'daemon_planner_gate',
        cycle: shared.cycleCount,
        allowed: planGate.allowed,
        reason: planGate.reason,
        state: planGate.state,
        executionLock: planGate.executionLock,
      })
      if (!planGate.allowed) {
        if (planGate.combatHold) {
          shared.metrics.combatHoldCount += 1
          shared.metrics.reasoningCount += 1
          return { type: 'combat_mode_hold', elapsedMs: Date.now() - cycleStart }
        }
        return { type: 'planner_gated', elapsedMs: Date.now() - cycleStart }
      }

      // 5. Chain orchestration
      try {
        await chainOrch.orchestrate(ctx)
        return { type: 'reasoning', elapsedMs: Date.now() - cycleStart }
      } catch (err) {
        shared.metrics.errorCount += 1
        taskSm.setExecutionLock(false, 'reasoning_error')
        shared.currentExecutionMeta = null
        shared.currentSkillMeta = null
        const errDetail = serializeError(err)
        await setTaskState('failed', {
          reason: 'reasoning_error',
          error: errDetail.message,
          cycle: shared.cycleCount,
        })
        await logger.log({
          type: 'daemon_reasoning_error',
          cycle: shared.cycleCount,
          error: errDetail,
        })
        return { type: 'error', error: errDetail.message, elapsedMs: Date.now() - cycleStart }
      }
    }

    // Fallback: no central reasoning configured
    await logger.log({
      type: 'daemon_idle',
      cycle: shared.cycleCount,
      threat_level: snapshot.threat_level,
      health: snapshot.status?.health,
      entities: snapshot.nearby?.entities?.length || 0,
    })
    return { type: 'idle', elapsedMs: Date.now() - cycleStart }
  }

  // --- Main loop ---

  async function start() {
    if (shared.started) throw new Error('daemon.start called more than once on same instance')
    shared.started = true
    shared.stopped = false
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

    await logger.log({ type: 'daemon_start', ts: nowIso(), thinkIntervalMs })

    eventReactor.setup()

    while (!shared.stopped) {
      try {
        // Damage interrupt pre-check from queue
        const queuedDamage = interruptQueue.peekHighest()
        if (queuedDamage?.source === 'damage' && reflexLayer && !shared.reflexTakeoverInFlight
            && (!bot.targetDigBlock || (bot.health ?? 20) <= 5)) {
          const emergencySnapshot = sense(bot, { radius: 5 })
          const interrupt = interruptQueue.popHighest()
          const reflexAction = reflexLayer.check(emergencySnapshot, {})
          const damagePolicy = taskSm.evaluateInterruptPolicy({
            decision: interrupt,
            currentSkillMeta: shared.currentSkillMeta,
            currentExecutionMeta: shared.currentExecutionMeta,
            currentState: taskSm.getState().state,
            runtimeMode: taskSm.getState().state === 'recovering' ? 'recovering' : 'normal',
          })
          if (executionLocked() && !damagePolicy.accept) {
            await logger.log({
              type: 'interrupt_ignored',
              cycle: shared.cycleCount,
              source: interrupt?.source || 'damage',
              shouldInterrupt: interrupt?.shouldInterrupt ?? true,
              priority: interrupt?.priority || 'high',
              interruptReason: interrupt?.interruptReason || 'damage_interrupt',
              matchedRuleId: interrupt?.metadata?.ruleId || null,
              reason: 'damage_policy_reject',
              policyReason: damagePolicy.policyReason,
              currentExecutionSkill: shared.currentExecutionMeta?.skillName || null,
              currentExecutionInterruptible: shared.currentExecutionMeta?.interruptible ?? null,
              currentTaskState: taskSm.getState().state,
              fallbackMode: interrupt?.fallbackMode || null,
            })
            continue
          }
          if (reflexAction) {
            await logger.log({
              type: 'daemon_damage_reflex',
              cycle: shared.cycleCount,
              action: reflexAction.name,
              reason: reflexAction.reason,
              health: bot.health,
            })
          }
          await interruptExecutor.executeTakeover({
            source: 'damage_interrupt',
            interrupt: interrupt || systemInterrupt({
              source: 'damage',
              priority: 'high',
              interruptReason: 'damage_interrupt',
            }),
            reflexAction,
            snapshot: emergencySnapshot,
            ctx: { snapshot: emergencySnapshot, cycle: shared.cycleCount },
            policyReason: damagePolicy.policyReason || 'damage_interrupt_path',
          })
          continue
        }

        if (!bot.targetDigBlock) {
          const result = await runCycle()
          if (result.type !== 'idle') {
            // eslint-disable-next-line no-console
            console.log(JSON.stringify({
              type: 'daemon_cycle', cycle: shared.cycleCount, ...result,
            }))
          }
          if (result.type === 'error') {
            // eslint-disable-next-line no-console
            console.error(`[daemon] cycle ${shared.cycleCount} returned error: ${result.error}`)
          }
          // Cycle summary for debug output (AGENT_DEBUG=1)
          const liveSnap = sense(bot, { radius: 5, farScan: false })
          await logCycleSummary(logger, {
            cycleId: shared.cycleCount,
            state: taskSm.getState().state,
            goal: shared.activeTask?.goal || null,
            chosenSkill: shared.currentExecutionMeta?.skillName || null,
            resultStatus: result.type,
            reflexTriggered: result.type === 'reflex',
            interruptReason: result.type === 'executing_hold' ? 'hold' : null,
            planningInvoked: result.type === 'reasoning',
            durationMs: result.elapsedMs || null,
            threat: liveSnap?.threat_level || null,
            health: liveSnap?.status?.health ?? null,
            error: result.error || null,
          })
        }
      } catch (err) {
        const errDetail = serializeError(err)
        // eslint-disable-next-line no-console
        console.error(`[daemon] cycle ${shared.cycleCount} error:`, errDetail.message, errDetail.stack || '')
        void Promise.resolve(logger.log({
          type: 'daemon_cycle_error',
          cycle: shared.cycleCount,
          error: errDetail,
        })).catch(() => {})
      }

      // Adaptive polling
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

    // Shutdown
    taskSm.setExecutionLock(false, 'daemon_stop')
    await setTaskState('cooling_down', { reason: 'daemon_stop', force: true, cycle: shared.cycleCount })
    await logger.log({ type: 'daemon_stop', ts: nowIso(), totalCycles: shared.cycleCount })
    const readiness = {
      combatReflexReady: shared.metrics.reflexCount > 0,
      reasoningLoopReady: shared.metrics.reasoningCount > 0,
      errorRate: shared.metrics.cycles > 0 ? Number((shared.metrics.errorCount / shared.metrics.cycles).toFixed(3)) : 0,
      combatHoldCount: shared.metrics.combatHoldCount,
      residualRisks: ['Requires live server scenarios for full day/night/combat validation'],
    }
    await logger.log({ type: 'daemon_readiness', ts: nowIso(), ...readiness })
    await logger.close()
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ type: 'daemon_stop', totalCycles: shared.cycleCount }))
  }

  function stop() {
    shared.stopped = true
    eventReactor.teardown()
  }

  function getTaskState() {
    return taskSm.getState()
  }

  function getStateTransitionTrace() {
    return shared.stateTransitionTrace.slice()
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
