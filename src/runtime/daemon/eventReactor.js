/**
 * Event Reactor (Phase 9.5).
 *
 * Sets up and tears down all event-driven listeners and interval tickers:
 * - Health/damage listener → interrupt queue
 * - Chat listener → personality + voice
 * - Reflex fast ticker (120ms) → emergency arbitration + takeover
 * - Stuck watch ticker (1150ms) → displacement check + chain abort
 */

const { sense, nearestHostileDistance } = require('../sense')
const { systemInterrupt } = require('../contracts/interruptDecision')

function createEventReactor({
  bot,
  reflexLayer,
  taskSm,
  interruptQueue,
  logger,
  shared,
  interruptExecutor,
  voiceController,
  personality,
}) {
  let healthListener = null
  let chatListener = null
  let endListener = null
  let kickedListener = null
  let reflexTicker = null
  let stuckWatchTicker = null

  function executionLocked() {
    return taskSm.isExecutionLocked()
  }

  function setup() {
    // Health/damage listener
    healthListener = () => {
      try {
        if (bot.health < (bot._lastDaemonHealth ?? 20)) {
          shared.lastDamageAt = Date.now()
          if (typeof reflexLayer?.noteDamage === 'function') reflexLayer.noteDamage()
          interruptQueue.enqueue(systemInterrupt({
            source: 'damage',
            priority: 'high',
            interruptReason: 'recent_damage_event',
            metadata: {
              cycle: shared.cycleCount,
              health: bot.health,
            },
          }))
        }
        bot._lastDaemonHealth = bot.health
      } catch (err) {
        void Promise.resolve(logger.log({
          type: 'daemon_health_listener_error',
          cycle: shared.cycleCount,
          error: err?.message || String(err),
        })).catch(() => {})
      }
    }
    bot.on('health', healthListener)

    // Chat listener
    chatListener = async (username, message) => {
      if (username === bot.username) return
      shared.playerMessageQueue.push({ from: username, text: message, ts: Date.now() })
      if (!personality.isEnabled()) return
      try {
        const brief = `玩家${username}对你说了："${message}"`
        const result = await personality.consultSync(brief)
        const live = sense(bot, { radius: 5, farScan: false })
        if (voiceController && result?.voice) {
          const spoke = voiceController.trySpeakVoice(result.voice, live)
          if (spoke) {
            await logger.log({
              type: 'daemon_chat_reaction',
              cycle: shared.cycleCount,
              from: username,
              message,
              voice: result.voice,
              emotionalTags: result.emotionalTags || [],
            })
          }
        }
      } catch (err) {
        void Promise.resolve(logger.log({
          type: 'daemon_chat_reaction_error',
          cycle: shared.cycleCount,
          from: username,
          error: err?.message || String(err),
          stack: err?.stack?.split('\n').slice(0, 4).join('\n') || null,
        })).catch(() => {})
      }
    }
    bot.on('chat', chatListener)

    // Bot disconnect listener — stops daemon loop so it doesn't spin after disconnect
    endListener = (reason) => {
      const msg = typeof reason === 'string' ? reason : (reason?.message || String(reason || 'unknown'))
      shared.botDisconnected = true
      shared.stopped = true
      void Promise.resolve(logger.log({
        type: 'bot_disconnected',
        cycle: shared.cycleCount,
        reason: msg,
        event: 'end',
      })).catch(() => {})
      // eslint-disable-next-line no-console
      console.error(`[daemon] Bot disconnected (end): ${msg}`)
    }
    bot.on('end', endListener)

    kickedListener = (reason) => {
      const msg = typeof reason === 'string' ? reason : (reason?.message || JSON.stringify(reason || 'unknown'))
      shared.botDisconnected = true
      shared.stopped = true
      void Promise.resolve(logger.log({
        type: 'bot_kicked',
        cycle: shared.cycleCount,
        reason: msg,
        event: 'kicked',
      })).catch(() => {})
      // eslint-disable-next-line no-console
      console.error(`[daemon] Bot kicked: ${msg}`)
    }
    bot.on('kicked', kickedListener)

    // High-frequency reflex ticker (120ms)
    reflexTicker = setInterval(async () => {
      if (!reflexLayer || shared.reflexTakeoverInFlight) return
      const snapshot = sense(bot, { radius: 5, farScan: false })
      const nearest = nearestHostileDistance(bot)
      const snapshotHealth = snapshot?.status?.health ?? snapshot?.reflexContext?.health ?? 20
      const emergency = snapshot?.close_threat === true || nearest <= 3.2 || snapshotHealth <= 6
      if (!emergency) return
      try {
        const arbitrated = typeof reflexLayer.arbitrate === 'function'
          ? reflexLayer.arbitrate(snapshot, { snapshot, cycle: shared.cycleCount })
          : null
        const interrupt = arbitrated?.decision ?? null
        const reflexAction = arbitrated?.matchedRule ?? null
        if (!interrupt?.shouldInterrupt || !reflexAction) return

        const urgent = ['flee_burst', 'fight_back', 'emergency_jump', 'flee']
        if (!urgent.includes(reflexAction.name)) return

        await logger.log({
          type: 'daemon_fast_reflex',
          cycle: shared.cycleCount,
          action: reflexAction.name,
          reason: reflexAction.reason,
          nearestHostile: nearest,
          health: snapshotHealth,
          interruptPriority: interrupt.priority,
        })

        const fastPolicy = taskSm.evaluateInterruptPolicy({
          decision: interrupt,
          currentSkillMeta: shared.currentSkillMeta,
          currentExecutionMeta: shared.currentExecutionMeta,
          currentState: taskSm.getState().state,
          runtimeMode: 'reflex_safe',
        })

        if (!executionLocked() || fastPolicy.accept) {
          await interruptExecutor.executeTakeover({
            source: 'fast_ticker',
            interrupt,
            reflexAction,
            snapshot,
            ctx: { snapshot, cycle: shared.cycleCount },
            policyReason: fastPolicy.policyReason,
          })
        } else {
          await logger.log({
            type: 'interrupt_ignored',
            cycle: shared.cycleCount,
            source: interrupt.source || 'reflex',
            shouldInterrupt: interrupt.shouldInterrupt,
            priority: interrupt.priority,
            interruptReason: interrupt.interruptReason,
            matchedRuleId: interrupt?.metadata?.ruleId || null,
            reason: 'fast_ticker_policy_reject',
            policyReason: fastPolicy.policyReason,
            currentExecutionSkill: shared.currentExecutionMeta?.skillName || null,
            currentExecutionInterruptible: shared.currentExecutionMeta?.interruptible ?? null,
            currentTaskState: taskSm.getState().state,
            fallbackMode: interrupt?.fallbackMode || null,
          })
        }
      } catch (err) {
        taskSm.setExecutionLock(false, 'fast_reflex_error')
        void Promise.resolve(logger.log({
          type: 'daemon_fast_reflex_error',
          cycle: shared.cycleCount,
          error: err?.message || String(err),
          stack: err?.stack?.split('\n').slice(0, 4).join('\n') || null,
        })).catch(() => {})
      }
    }, 120)

    // Stuck watch ticker (1150ms)
    stuckWatchTicker = setInterval(() => {
      try {
        const rc = shared.currentChainRunControl
        if (!rc || rc.signal.aborted) return
        if (taskSm.getState().state !== 'executing') return
        if (!taskSm.isExecutionLocked()) return
        // Skip stuck detection while bot is actively digging — zero displacement is normal
        if (bot.targetDigBlock) return
        const pos = bot.entity?.position
        if (!pos) return
        const now = Date.now()
        if (!shared.stuckWatchLastPos) {
          shared.stuckWatchLastPos = pos.clone()
          shared.stuckWatchLastAt = now
          return
        }
        // Require longer window (8s) and two consecutive zero-movement samples
        if (now - shared.stuckWatchLastAt < 8000) return
        const moved = pos.distanceTo(shared.stuckWatchLastPos)
        if (moved < 0.095) {
          shared.stuckWatchZeroCount = (shared.stuckWatchZeroCount || 0) + 1
          if (shared.stuckWatchZeroCount < 2) {
            // First zero sample — record but don't abort yet
            shared.stuckWatchLastPos = pos.clone()
            shared.stuckWatchLastAt = now
            return
          }
          reflexLayer?.noteStuck?.()
          void Promise.resolve(logger.log({
            type: 'daemon_stuck_evidence',
            cycle: shared.cycleCount,
            moved,
            sampleAgeMs: now - shared.stuckWatchLastAt,
            consecutiveZero: shared.stuckWatchZeroCount,
            note: 'low_displacement_during_chain',
          })).catch(() => {})
          rc.abort('movement_stuck_timeout')
          shared.stuckWatchZeroCount = 0
          void Promise.resolve(logger.log({
            type: 'daemon_stuck_abort_chain',
            cycle: shared.cycleCount,
            moved,
            msSinceSample: now - shared.stuckWatchLastAt,
          })).catch(() => {})
        } else {
          shared.stuckWatchZeroCount = 0
        }
        shared.stuckWatchLastPos = pos.clone()
        shared.stuckWatchLastAt = now
      } catch (err) {
        void Promise.resolve(logger.log({
          type: 'daemon_stuck_watch_error',
          cycle: shared.cycleCount,
          error: err?.message || String(err),
        })).catch(() => {})
      }
    }, 1150)
  }

  function teardown() {
    if (reflexTicker) { clearInterval(reflexTicker); reflexTicker = null }
    if (stuckWatchTicker) { clearInterval(stuckWatchTicker); stuckWatchTicker = null }
    if (healthListener) { bot.off('health', healthListener); healthListener = null }
    if (chatListener) { bot.off('chat', chatListener); chatListener = null }
    if (endListener) { bot.off('end', endListener); endListener = null }
    if (kickedListener) { bot.off('kicked', kickedListener); kickedListener = null }
  }

  return Object.freeze({ setup, teardown })
}

module.exports = { createEventReactor }
