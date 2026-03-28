/**
 * Voice Controller (Phase 9.5).
 *
 * Centralizes voice output state (cooldown, dedup) so both
 * chainOrchestrator and eventReactor share a single voice pipeline.
 */

const { shouldSpeakVoice, voiceCooldownMs, formatVoiceOutput } = require('./pacingPolicy')

function createVoiceController({ bot, personality, logger, shared }) {
  let lastVoiceAt = 0
  const recentVoices = []

  function executionLocked() {
    return !!shared.currentExecutionMeta || !!shared.currentChainRunControl
  }

  /**
   * Attempt to speak. Returns true if voice was emitted.
   */
  function trySpeakVoice(text, snapshot) {
    const sayText = formatVoiceOutput(text, {
      taskBusy: executionLocked() || !!bot.pathfinder?.goal,
    })
    if (Date.now() - lastVoiceAt <= voiceCooldownMs(snapshot)) return false
    if (!shouldSpeakVoice({
      voice: sayText,
      snapshot,
      isExecuting: executionLocked(),
      recentVoices,
    })) return false

    bot.chat(sayText)
    lastVoiceAt = Date.now()
    recentVoices.push(String(sayText).trim())
    if (recentVoices.length > 4) recentVoices.shift()
    return true
  }

  /**
   * Speak voice from personality state if conditions allow.
   */
  function trySpeakPersonalityVoice(snapshot) {
    if (!personality.isEnabled()) return false
    const pState = personality.getState()
    if (!pState?.voice) return false
    return trySpeakVoice(pState.voice, snapshot)
  }

  return Object.freeze({ trySpeakVoice, trySpeakPersonalityVoice })
}

module.exports = { createVoiceController }
