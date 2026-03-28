/**
 * Chain Orchestrator (Phase 9.5).
 *
 * Manages the full planning decision → chain execution → post-processing lifecycle.
 * Owns: currentExecutionMeta, currentSkillMeta, currentChainRunControl,
 *       stuckWatchLastPos, stuckWatchLastAt on the shared state bag.
 */

const { sense } = require('../sense')
const { createChainRunControl } = require('../chainRunControl')
const { compactChainSignature, chainSucceeded, promoteSkillIfStable } = require('./skillPromotion')
const { evaluateExpectation } = require('./expectationEvaluator')
const { inferExecutionMetaFromChain } = require('./executionMetadata')

function nowIso() {
  return new Date().toISOString()
}

function createChainOrchestrator({
  centralReasoning,
  chainExecutor,
  reflexLayer,
  taskSm,
  api,
  bot,
  memory,
  personality,
  logger,
  shared,
  setTaskState,
  stableSkills,
  voiceController,
}) {
  /**
   * Run the full plan-execute-postprocess pipeline for one cycle.
   * Returns the cycle result object.
   */
  async function orchestrate(ctx) {
    const cycleCount = shared.cycleCount

    await setTaskState('planning', {
      reason: 'central_reasoning',
      cycle: cycleCount,
      goal: shared.activeTask?.goal || null,
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
      type: 'daemon_decision',
      cycle: cycleCount,
      thought: decision?.thought || null,
      actionChainLength: decision?.actionChain?.length || 0,
      goalHint: decision?.nextGoalHint || null,
    })

    const chainSignature = compactChainSignature(decision?.actionChain || [])
    shared.currentExecutionMeta = inferExecutionMetaFromChain(decision?.actionChain || [], stableSkills)
    shared.currentSkillMeta = shared.currentExecutionMeta?.skillName
      ? stableSkills.get(shared.currentExecutionMeta.skillName) || null
      : null

    // Voice alignment: speak personality voice if plan is committed and appropriate
    if (voiceController
      && personality.isEnabled()
      && Array.isArray(decision?.actionChain)
      && decision.actionChain.length > 0) {
      const thought = String(decision?.thought || '')
      const skipVoice = thought.includes('fast_fallback: gather nearby oak')
        || thought.includes('defer auto wood')
        || thought.includes('fast_fallback: no clear target')
        || thought.includes('intent_recovery_probe')
      if (!skipVoice) {
        voiceController.trySpeakPersonalityVoice(ctx.snapshot)
      }
    }

    // Apply memory updates from LLM
    if (memory && Array.isArray(decision?.memoryUpdates)) {
      for (const update of decision.memoryUpdates) {
        if (update.action === 'remember' && update.key) {
          await memory.set(update.key, update.value)
        } else if (update.action === 'forget' && update.key) {
          await memory.delete(update.key)
        }
      }
    }

    // Execute action chain
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

      shared.currentChainRunControl = createChainRunControl()
      shared.stuckWatchLastPos = bot.entity?.position ? bot.entity.position.clone() : null
      shared.stuckWatchLastAt = Date.now()

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
          runControl: shared.currentChainRunControl,
        })
      } catch (err) {
        chainResult = {
          completed: 0,
          total: decision.actionChain.length,
          interrupted: false,
          failedStep: { index: 0, type: 'chain', error: { message: err?.message || String(err) } },
          results: [],
        }
        shared.metrics.errorCount += 1
      } finally {
        shared.currentChainRunControl = null
        shared.stuckWatchLastPos = null
      }

      await logger.log({
        type: 'daemon_chain_result',
        cycle: cycleCount,
        completed: chainResult.completed,
        total: chainResult.total,
        interrupted: chainResult.interrupted || false,
        failedStep: chainResult.failedStep || null,
      })

      if (centralReasoning && typeof centralReasoning.setLastChainResult === 'function') {
        centralReasoning.setLastChainResult(chainResult)
      }

      // Expectation evaluation
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

      // Skill promotion
      await promoteSkillIfStable({
        memory,
        decision,
        chainResult,
        bot,
        logger,
        cycle: cycleCount,
      })

      // Learn progress
      if (typeof centralReasoning?.evaluateLearnProgress === 'function') {
        await centralReasoning.evaluateLearnProgress({
          memory,
          chainResult,
          decision,
          logger,
          cycle: cycleCount,
        })
      }

      // Personality preference feedback
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

      // Post-execution state transitions
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
      shared.currentExecutionMeta = null
      shared.currentSkillMeta = null
    } else {
      // No chain to execute
      taskSm.setExecutionLock(false, 'no_chain')
      await setTaskState('completed', {
        reason: 'no_chain',
        cycle: cycleCount,
        goal: decision?.nextGoalHint || null,
      })
      shared.currentExecutionMeta = null
      shared.currentSkillMeta = null
    }
  }

  return Object.freeze({ orchestrate })
}

module.exports = { createChainOrchestrator }
