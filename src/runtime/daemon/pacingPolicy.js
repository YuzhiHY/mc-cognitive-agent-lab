const { nearestHostileDistance } = require('../sense')

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

module.exports = { currentThreat, shouldSpeakVoice, voiceCooldownMs, formatVoiceOutput }
