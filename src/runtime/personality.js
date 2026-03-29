const fs = require('node:fs')
const path = require('node:path')
const URGENCY_TAGS = new Set(['urgent', 'flee', 'danger', 'panic', 'retreat', 'run'])

const EVENT_TEMPLATES = {
  task_failed: (ev, ctx) => {
    const hp = ctx?.snapshot?.status?.health ?? '?'
    const skill = ev.skillName || '未知技能'
    const errMsg = ev.error?.message || '未知错误'
    return `尝试执行"${skill}"时失败了。错误：${errMsg}。当前血量${hp}。`
  },
  task_succeeded: (ev) => {
    const skill = ev.skillName || '任务'
    return `成功完成了"${skill}"。`
  },
  threat_detected: (ev, ctx) => {
    const entities = ctx?.snapshot?.nearby?.entities || []
    const threats = entities.filter((e) => e.distance <= 5).map((e) => e.name || e.kind).filter(Boolean)
    const hp = ctx?.snapshot?.status?.health ?? '?'
    if (threats.length === 0) return `检测到威胁信号。当前血量${hp}。`
    return `${threats.join('、')}在附近逼近。当前血量${hp}。`
  },
  threat_cleared: () => '威胁已消除，周围暂时安全了。',
  health_low: (ev, ctx) => {
    const hp = ctx?.snapshot?.status?.health ?? '?'
    return `血量很低了（${hp}），需要小心。`
  },
  stuck_detected: (ev) => {
    const skill = ev.skillName || '移动'
    return `尝试"${skill}"时似乎卡住了，位置没有变化。`
  },
}

function tagEvent(executionResult, ctx, extraInfo = {}) {
  const type = extraInfo.type || deriveEventType(executionResult, ctx)
  const template = EVENT_TEMPLATES[type]
  const summary = template
    ? template({ ...executionResult, ...extraInfo }, ctx)
    : `发生了事件：${type}`
  const severity = deriveSeverity(type, ctx)
  return { type, summary, severity }
}

function deriveEventType(exec, ctx) {
  if (exec && !exec.ok) return 'task_failed'
  if (exec?.result?.done === true || exec?.result?.done === undefined) return 'task_succeeded'
  const threat = ctx?.snapshot?.threat_level
  if (threat === 'high') return 'threat_detected'
  const hp = ctx?.snapshot?.status?.health
  if (typeof hp === 'number' && hp <= 6) return 'health_low'
  return 'task_succeeded'
}

function deriveSeverity(type, ctx) {
  if (type === 'task_failed') return 2
  if (type === 'threat_detected') {
    return ctx?.snapshot?.threat_level === 'high' ? 3 : 1
  }
  if (type === 'health_low') return 2
  if (type === 'stuck_detected') return 1
  return 0
}

function shouldTrigger(taggedEvent, currentState, {
  cooldownSteps = 3,
  severityThreshold = 1,
  stepsSinceLastTrigger = Infinity,
} = {}) {
  if (taggedEvent.severity >= severityThreshold) return true
  const forceTriggerTypes = new Set(['task_failed', 'threat_detected', 'task_succeeded'])
  if (forceTriggerTypes.has(taggedEvent.type)) return true
  if (stepsSinceLastTrigger >= cooldownSteps) return true
  return false
}

function createPersonality({
  enabled = false,
  personalityLlm = null,
  personaDir,
  cooldownSteps = 3,
  severityThreshold = 1,
} = {}) {
  const isEnabled = !!enabled && !!personalityLlm
  const baseDir = personaDir || path.resolve(process.cwd(), 'personality')
  const statePath = path.join(baseDir, 'state.json')
  const personaPath = path.join(baseDir, 'persona.md')
  let stepsSinceLastTrigger = Infinity
  let triggerCount = 0
  let skipCount = 0

  function mergePersonaState(stored) {
    const incoming = stored && typeof stored === 'object' ? stored : {}
    const recentTendencyHints = Array.isArray(incoming.recentTendencyHints)
      ? incoming.recentTendencyHints.slice(-8).map((x) => String(x)).filter(Boolean)
      : []
    return {
      lastReinforcedAt: incoming.lastReinforcedAt || null,
      recentTendencyHints,
    }
  }

  async function readState() {
    try {
      const raw = await fs.promises.readFile(statePath, 'utf8')
      const parsed = JSON.parse(raw)
      return {
        voice: parsed?.voice || '',
        emotionalTags: Array.isArray(parsed?.emotionalTags) ? parsed.emotionalTags : [],
        recentEvents: Array.isArray(parsed?.recentEvents) ? parsed.recentEvents : [],
        lastUpdated: parsed?.lastUpdated || null,
        personaState: mergePersonaState(parsed?.personaState || parsed?.personaProfile),
      }
    } catch {
      return {
        voice: '',
        emotionalTags: [],
        recentEvents: [],
        lastUpdated: null,
        personaState: mergePersonaState(null),
      }
    }
  }

  async function writeState(state) {
    try {
      await fs.promises.mkdir(baseDir, { recursive: true })
      await fs.promises.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8')
    } catch {
      // State writing must never break the agent loop.
    }
  }

  async function readPersona() {
    try {
      return await fs.promises.readFile(personaPath, 'utf8')
    } catch {
      return '你是一个友好的冒险者。'
    }
  }

  async function callPersonalityLLM(taggedEvent, currentState, personaText) {
    const { buildSystemPrompt, buildPersonalityUserPayload } = require('./llm/prompt')
    const systemPrompt = buildSystemPrompt({ mode: 'personality', personaText })
    const userPayload = buildPersonalityUserPayload({
      event: taggedEvent.summary,
      currentMood: currentState.emotionalTags || [],
      recentHistory: (currentState.recentEvents || []).slice(-5),
    })

    const response = await personalityLlm.plan({
      ctx: { _personalityPayload: userPayload },
      history: [],
      _systemPromptOverride: systemPrompt,
      _userPayloadOverride: userPayload,
    })

    const voice = response?.voice || response?.thought || ''
    const emotionalTags = Array.isArray(response?.emotionalTags)
      ? response.emotionalTags
      : []
    const tendencyHints = Array.isArray(response?.tendencyHints)
      ? response.tendencyHints.slice(0, 2).map((x) => String(x)).filter(Boolean)
      : []
    return { voice, emotionalTags, tendencyHints }
  }

  async function processEvent(executionResult, ctx) {
    if (!isEnabled) return null
    stepsSinceLastTrigger += 1

    const tagged = tagEvent(executionResult, ctx)
    const state = await readState()

    if (!shouldTrigger(tagged, state, { cooldownSteps, severityThreshold, stepsSinceLastTrigger })) {
      skipCount += 1
      return { triggered: false, taggedEvent: tagged }
    }

    stepsSinceLastTrigger = 0
    triggerCount += 1

    try {
      const personaText = await readPersona()
      const result = await callPersonalityLLM(tagged, state, personaText)

      const newRecentEvents = [
        ...(state.recentEvents || []).slice(-9),
        { type: tagged.type, summary: tagged.summary, voice: result.voice, ts: new Date().toISOString() },
      ]

      const newState = {
        voice: result.voice,
        emotionalTags: result.emotionalTags,
        recentEvents: newRecentEvents,
        lastUpdated: new Date().toISOString(),
        personaState: {
          ...mergePersonaState(state.personaState),
          recentTendencyHints: result.tendencyHints || [],
        },
      }
      await writeState(newState)

      return {
        triggered: true,
        taggedEvent: tagged,
        voice: result.voice,
        emotionalTags: result.emotionalTags,
        tendencyHints: result.tendencyHints || [],
        urgencyOverride: result.emotionalTags.some((t) => URGENCY_TAGS.has(t.toLowerCase())),
      }
    } catch (err) {
      // Graceful degradation: keep last state, don't block main loop.
      return {
        triggered: true,
        taggedEvent: tagged,
        error: err.message || String(err),
        voice: state.voice,
        emotionalTags: state.emotionalTags,
        tendencyHints: state?.personaState?.recentTendencyHints || [],
        urgencyOverride: false,
      }
    }
  }

  function getState() {
    try {
      const raw = fs.readFileSync(statePath, 'utf8')
      const parsed = JSON.parse(raw)
      return {
        voice: parsed?.voice || '',
        emotionalTags: Array.isArray(parsed?.emotionalTags) ? parsed.emotionalTags : [],
        recentEvents: Array.isArray(parsed?.recentEvents) ? parsed.recentEvents : [],
        lastUpdated: parsed?.lastUpdated || null,
        personaState: mergePersonaState(parsed?.personaState || parsed?.personaProfile),
      }
    } catch {
      return {
        voice: '',
        emotionalTags: [],
        recentEvents: [],
        lastUpdated: null,
        personaState: mergePersonaState(null),
      }
    }
  }

  async function consultSync(brief, state) {
    if (!isEnabled) return null
    try {
      const personaText = await readPersona()
      const { buildSystemPrompt, buildPersonalityUserPayload } = require('./llm/prompt')
      const systemPrompt = buildSystemPrompt({ mode: 'personality', personaText })
      const currentState = state || await readState()
      const userPayload = buildPersonalityUserPayload({
        event: brief,
        currentMood: currentState.emotionalTags || [],
        recentHistory: (currentState.recentEvents || []).slice(-5),
      })

      const response = await personalityLlm.plan({
        ctx: {},
        history: [],
        _systemPromptOverride: systemPrompt,
        _userPayloadOverride: userPayload,
        _skipValidation: true,
      })

      const voice = response?.voice || response?.thought || ''
      const emotionalTags = Array.isArray(response?.emotionalTags)
        ? response.emotionalTags
        : []
      const suggestion = response?.suggestion || null
      const tendencyHints = Array.isArray(response?.tendencyHints)
        ? response.tendencyHints.slice(0, 2).map((x) => String(x)).filter(Boolean)
        : []

      const newRecentEvents = [
        ...(currentState.recentEvents || []).slice(-9),
        { type: 'consult', summary: brief, voice, ts: new Date().toISOString() },
      ]
      const newState = {
        voice,
        emotionalTags,
        recentEvents: newRecentEvents,
        lastUpdated: new Date().toISOString(),
        personaState: {
          ...mergePersonaState(currentState.personaState),
          recentTendencyHints: tendencyHints,
        },
      }
      await writeState(newState)

      triggerCount += 1
      return { voice, emotionalTags, suggestion, tendencyHints }
    } catch (err) {
      const fallbackState = getState()
      return {
        voice: fallbackState.voice || '',
        emotionalTags: fallbackState.emotionalTags || [],
        suggestion: null,
        tendencyHints: fallbackState?.personaState?.recentTendencyHints || [],
        error: err.message || String(err),
      }
    }
  }

  async function consultExpectation({ brief, selfGoal, actionChain }, state) {
    if (!isEnabled) return null
    try {
      const personaText = await readPersona()
      const {
        buildSystemPrompt,
        buildPersonalityExpectationPayload,
      } = require('./llm/prompt')
      const systemPrompt = buildSystemPrompt({ mode: 'personality_expectation', personaText })
      const currentState = state || await readState()
      const userPayload = buildPersonalityExpectationPayload({
        brief,
        selfGoal,
        actionChain: Array.isArray(actionChain) ? actionChain.slice(0, 6) : [],
        currentMood: currentState.emotionalTags || [],
        recentHistory: (currentState.recentEvents || []).slice(-5),
      })

      const response = await personalityLlm.plan({
        ctx: {},
        history: [],
        _systemPromptOverride: systemPrompt,
        _userPayloadOverride: userPayload,
        _skipValidation: true,
      })

      const confidenceRaw = Number(response?.confidence)
      const confidence = Number.isFinite(confidenceRaw)
        ? Math.max(0, Math.min(1, confidenceRaw))
        : 0.5
      const risk = Array.isArray(response?.risk)
        ? response.risk.slice(0, 3).map((x) => String(x)).filter(Boolean)
        : []
      return {
        expectedOutcome: response?.expectedOutcome || '完成当前动作链并接近目标',
        confidence,
        risk,
        emotionIfFail: response?.emotionIfFail || 'confused',
        fallbackHint: response?.fallbackHint || '',
      }
    } catch {
      return {
        expectedOutcome: '完成当前动作链并接近目标',
        confidence: 0.5,
        risk: [],
        emotionIfFail: 'confused',
        fallbackHint: '',
      }
    }
  }

  function getSummary() {
    return { triggered: triggerCount, skipped: skipCount }
  }

  async function reinforceTendencyHints({
    usedHints = [],
    success = false,
  } = {}) {
    if (!isEnabled) return null
    const state = await readState()
    const ps = mergePersonaState(state.personaState)
    const hints = Array.isArray(usedHints) ? usedHints.map((x) => String(x)).filter(Boolean) : []
    // Simply track which hints were used recently — kernel method doesn't use numeric bias
    ps.recentTendencyHints = hints.slice(-8)
    ps.lastReinforcedAt = new Date().toISOString()
    await writeState({
      ...state,
      personaState: ps,
      lastUpdated: new Date().toISOString(),
    })
    return ps
  }

  return Object.freeze({
    isEnabled: () => isEnabled,
    processEvent,
    consultSync,
    consultExpectation,
    getState,
    getSummary,
    reinforceTendencyHints,
    tagEvent,
  })
}

module.exports = { createPersonality, tagEvent, shouldTrigger, URGENCY_TAGS }
