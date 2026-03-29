/**
 * Interrupt Executor (Phase 9.5).
 *
 * Encapsulates the full interrupt takeover lifecycle:
 * cooldown checking, chain abort, reflex execution, state transitions.
 *
 * Owns: reflexTakeoverInFlight, lastReflexCooldownKey, lastReflexCooldownAt
 * on the shared state bag.
 */

function createInterruptExecutor({
  reflexLayer,
  taskSm,
  api,
  bot,
  logger,
  shared,
  setTaskState,
}) {
  const reflexCooldownMs = Number(process.env.REFLEX_TAKEOVER_COOLDOWN_MS || 3800)

  function executionLocked() {
    return taskSm.isExecutionLocked()
  }

  /**
   * Execute a full interrupt takeover. Returns the takeover result or null if suppressed.
   */
  async function executeTakeover({
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
        cycle: shared.cycleCount,
        source: interrupt?.source || source,
        shouldInterrupt: false,
        priority: interrupt?.priority || 'low',
        interruptReason: interrupt?.interruptReason || 'no_interrupt',
        matchedRuleId: interrupt?.metadata?.ruleId || null,
        reason: 'decision_false',
        policyReason: 'decision_false',
        currentExecutionSkill: shared.currentExecutionMeta?.skillName || null,
        currentExecutionInterruptible: shared.currentExecutionMeta?.interruptible ?? null,
        fallbackMode: interrupt?.fallbackMode || null,
        executionLock: executionLocked(),
        currentTaskState: taskSm.getState().state,
      })
      return null
    }

    // Resolve reflex action (damage fallback if none provided)
    let resolvedReflex = reflexAction
    const damageLike = String(interrupt?.source || '') === 'damage'
      || String(interrupt?.interruptReason || '').includes('damage')
    if (!resolvedReflex && damageLike && typeof reflexLayer?.getDamageFallbackAction === 'function') {
      resolvedReflex = reflexLayer.getDamageFallbackAction(snapshot, ctx)
    }
    if (!resolvedReflex) {
      await logger.log({
        type: 'interrupt_ignored',
        cycle: shared.cycleCount,
        source: interrupt.source || source,
        shouldInterrupt: true,
        priority: interrupt.priority,
        interruptReason: interrupt.interruptReason,
        matchedRuleId: interrupt?.metadata?.ruleId || null,
        reason: 'no_reflex_action_available',
        policyReason: 'no_reflex_action_available',
        currentExecutionSkill: shared.currentExecutionMeta?.skillName || null,
        currentExecutionInterruptible: shared.currentExecutionMeta?.interruptible ?? null,
        fallbackMode: interrupt?.fallbackMode || null,
        executionLock: executionLocked(),
        currentTaskState: taskSm.getState().state,
      })
      return null
    }
    reflexAction = resolvedReflex

    // Cooldown: in-flight guard
    const ruleId = interrupt?.metadata?.ruleId || reflexAction?.id || reflexAction?.name || 'unknown'
    const cooldownKey = `${ruleId}:${reflexAction?.name || 'action'}`
    const nowCooldown = Date.now()
    if (shared.reflexTakeoverInFlight) {
      await logger.log({
        type: 'interrupt_ignored',
        cycle: shared.cycleCount,
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

    // Cooldown: time-based dedup
    if (cooldownKey === shared.lastReflexCooldownKey
      && Number.isFinite(reflexCooldownMs) && reflexCooldownMs > 0
      && nowCooldown - shared.lastReflexCooldownAt < reflexCooldownMs) {
      await logger.log({
        type: 'interrupt_ignored',
        cycle: shared.cycleCount,
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

    // Abort current chain if running
    if (shared.currentChainRunControl && !shared.currentChainRunControl.signal.aborted) {
      const ar = interrupt.interruptReason || `${source}_takeover`
      shared.currentChainRunControl.abort(String(ar))
      await logger.log({
        type: 'chain_abort_requested',
        cycle: shared.cycleCount,
        takeoverSource: source,
        reason: String(ar),
        interruptPriority: interrupt.priority,
        matchedRuleId: interrupt?.metadata?.ruleId || null,
      })
    }

    // Mark in-flight, record cooldown
    shared.reflexTakeoverInFlight = true
    shared.lastReflexCooldownKey = cooldownKey
    shared.lastReflexCooldownAt = nowCooldown

    await logger.log({
      type: 'daemon_reflex',
      cycle: shared.cycleCount,
      action: reflexAction.name,
      reason: reflexAction.reason,
      interruptPriority: interrupt.priority,
      interruptReason: interrupt.interruptReason,
      interruptMetadata: interrupt.metadata || {},
      source,
    })
    await logger.log({
      type: 'interrupt_applied',
      cycle: shared.cycleCount,
      source: interrupt.source || source,
      shouldInterrupt: true,
      priority: interrupt.priority,
      interruptReason: interrupt.interruptReason,
      matchedRuleId: interrupt?.metadata?.ruleId || null,
      accepted: true,
      policyReason: policyReason || 'accepted_by_policy',
      currentExecutionSkill: shared.currentExecutionMeta?.skillName || null,
      currentExecutionInterruptible: shared.currentExecutionMeta?.interruptible ?? null,
      fallbackMode: interrupt?.fallbackMode || null,
      executionLock: executionLocked(),
      taskState: taskSm.getState().state,
      goal: shared.activeTask?.goal || null,
      skillName: shared.activeTask?.skillName || null,
    })

    // Execute reflex action
    try {
      taskSm.setExecutionLock(true, `${source}_reflex_action`)
      await setTaskState('interrupted', {
        reason: `${source}_reflex_takeover`,
        cycle: shared.cycleCount,
        skillName: reflexAction.name,
      })
      try { bot.pathfinder?.setGoal?.(null) } catch { /* */ }
      try { api.clearControlStates?.() } catch { /* */ }

      const reflexResult = typeof reflexLayer.execute === 'function'
        ? await reflexLayer.execute(reflexAction, { api, bot, ctx: ctx || { snapshot } })
        : await reflexAction.execute({ api, bot, ctx: ctx || { snapshot } })

      shared.metrics.reflexCount += 1
      await logger.log({
        type: 'daemon_reflex_result',
        cycle: shared.cycleCount,
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
        cycle: shared.cycleCount,
        goal: shared.activeTask?.goal || null,
        skillName: reflexAction.name,
      })

      return {
        type: 'reflex',
        action: reflexAction.name,
        interruptPriority: interrupt.priority,
        interruptReason: interrupt.interruptReason,
      }
    } catch (err) {
      shared.metrics.errorCount += 1
      taskSm.setExecutionLock(false, `${source}_reflex_error`)
      await setTaskState('failed', {
        reason: `${source}_reflex_failed`,
        error: err.message || String(err),
        cycle: shared.cycleCount,
        skillName: reflexAction.name,
      })
      const errStack = err?.stack?.split('\n').slice(0, 5).join('\n') || null
      await logger.log({
        type: 'daemon_reflex_error',
        cycle: shared.cycleCount,
        action: reflexAction.name,
        error: err.message || String(err),
        stack: errStack,
        source,
      })
      return { type: 'error', error: err.message || String(err) }
    } finally {
      shared.reflexTakeoverInFlight = false
      taskSm.setExecutionLock(false, `${source}_reflex_exit`)
    }
  }

  return Object.freeze({ executeTakeover })
}

module.exports = { createInterruptExecutor }
