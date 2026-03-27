const {
  noInterrupt,
  systemInterrupt,
} = require('../contracts/interruptDecision')

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

function buildWorldChangeInterrupt({ changed, cycle, snapshot }) {
  if (!changed) {
    return noInterrupt({
      source: 'world_change',
      reason: 'world_change_not_significant',
      metadata: { cycle },
    })
  }
  return systemInterrupt({
    source: 'world_change',
    priority: 'medium',
    interruptReason: 'significant_world_state_change',
    metadata: {
      cycle,
      threat: snapshot?.threat_level || null,
      health: snapshot?.status?.health ?? null,
    },
  })
}

module.exports = { significantWorldStateChange, buildWorldChangeInterrupt }
