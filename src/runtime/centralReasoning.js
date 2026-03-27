const {
  buildSystemPrompt,
  buildCentralAnalyzePayload,
  buildCentralDecidePayload,
  buildCentralLearnEvalPayload,
} = require('./llm/prompt')
const { sense } = require('./sense')
const {
  getQueue,
  saveQueue,
  mergeProposalsFromAnalysis,
  compactChainForEval,
  compactChainResults,
  appendHabit,
} = require('./learnTasks')
const { chooseHardcodedSkill } = require('./planning/skillSelector')
const { compileActionChain } = require('./planning/chainCompiler')
const { buildIntentAwareChain, shouldSuppressAutoWood } = require('./planning/intentFallback')
const { derivePlannerMeta } = require('./contracts/plannerOutput')
const { canSynthesize, filterSynthesisSteps } = require('./synthesisPolicy')

function hasExplicitUserIntent(ctx, analysis) {
  if (Array.isArray(ctx?.playerMessages) && ctx.playerMessages.length > 0) return true
  if (ctx?.runtimeDirectives?.hadPlayerMessageBatch) return true
  const g = String(ctx?.runtimeDirectives?.primaryGoal || analysis?.selfGoal || '').trim()
  if (!g) return false
  if (/maintain progress safely|fast_fallback/i.test(g)) return false
  if (/^demo$/i.test(g) || /^test$/i.test(g)) return false
  return true
}

function createCentralReasoning({ llm, personalityLlm, stableSkills }) {
  if (!llm) throw new Error('centralReasoning requires a core LLM client')

  let lastChainResult = null
  const centralThinkBudgetMs = Number(process.env.CENTRAL_THINK_BUDGET_MS || 9000)
  const analyzeBudgetMs = Number(process.env.CENTRAL_ANALYZE_BUDGET_MS || 3500)
  const decideBudgetMs = Number(process.env.CENTRAL_DECIDE_BUDGET_MS || 3500)
  const personalityBudgetMs = Number(process.env.CENTRAL_PERSONALITY_BUDGET_MS || 1800)

  function withBudget(promise, ms, label = 'phase') {
    if (!Number.isFinite(ms) || ms <= 0) return promise
    let t = null
    const timeout = new Promise((_, reject) => {
      t = setTimeout(() => {
        const err = new Error(`${label}_timeout_${ms}ms`)
        err.code = 'PHASE_TIMEOUT'
        reject(err)
      }, ms)
    })
    return Promise.race([promise, timeout]).finally(() => {
      if (t) clearTimeout(t)
    })
  }

  function quickFallbackDecision(ctx, analysis = {}) {
    if (hasExplicitUserIntent(ctx, analysis)) {
      const texts = (ctx.playerMessages || []).map((m) => String(m.text || ''))
      const g = String(ctx?.runtimeDirectives?.primaryGoal || analysis?.selfGoal || '')
      const intent = buildIntentAwareChain({ goalText: g, playerTexts: texts, snapshot: ctx?.snapshot })
      if (intent.length > 0) {
        return {
          thought: 'fast_fallback: intent-aware actions from user/task context',
          actionChain: intent,
          memoryUpdates: [],
          nextGoalHint: 'intent_fallback',
        }
      }
      const selected = chooseHardcodedSkill({
        goal: `${g} ${texts.join(' ')}`.trim(),
        snapshot: ctx?.snapshot || null,
        options: { suppressWoodGather: shouldSuppressAutoWood(g, texts) },
      })
      if (selected?.name) {
        return {
          thought: `fast_fallback: stable skill matched to user context (${selected.name})`,
          actionChain: [{ type: 'skill_ref', name: selected.name, args: selected.args || {} }],
          memoryUpdates: [],
          nextGoalHint: `intent_skill_${selected.name}`,
        }
      }
      return {
        thought: 'fast_fallback: explicit intent — recovery probe (no idle wait)',
        actionChain: [{ type: 'skill_ref', name: 'recover_from_stuck', args: {} }],
        memoryUpdates: [],
        nextGoalHint: 'intent_recovery_probe',
      }
    }
    const blocks = ctx?.snapshot?.nearby?.blocks || []
    const hasOak = blocks.some((b) => String(b.name || '').toLowerCase() === 'oak_log')
    const hasDirt = blocks.some((b) => String(b.name || '').toLowerCase() === 'dirt' || String(b.name || '').toLowerCase() === 'grass_block')
    const playerMsgs = Array.isArray(ctx?.playerMessages) ? ctx.playerMessages : []
    if (playerMsgs.length > 0) {
      const latest = playerMsgs[playerMsgs.length - 1]
      return {
        thought: 'fast_fallback: acknowledge player and keep moving',
        actionChain: [
          { type: 'chat', message: `收到，${latest.from || '玩家'}。我先执行一个快速动作，随后继续详细规划。` },
          { type: 'wait', timeoutMs: 500 },
        ],
        memoryUpdates: [],
        nextGoalHint: 'fast_fallback_ack',
      }
    }
    if (hasOak) {
      return {
        thought: 'fast_fallback: gather nearby oak log via stable skill',
        actionChain: [
          { type: 'skill_ref', name: 'approach_target', args: { target: 'oak_log', sprint: true } },
          { type: 'skill_ref', name: 'mine_named_block', args: { block: 'oak_log', maxDistance: 20 } },
        ],
        memoryUpdates: [],
        nextGoalHint: 'gather_wood_fast',
      }
    }
    if (hasDirt) {
      return {
        thought: 'fast_fallback: dig nearby dirt',
        actionChain: [
          { type: 'navigate', target: 'nearest_dirt', sprint: false },
          { type: 'dig', target: 'dirt' },
        ],
        memoryUpdates: [],
        nextGoalHint: 'safe_progress_dig',
      }
    }
    return {
      thought: 'fast_fallback: no clear target, short wait',
      actionChain: [{ type: 'wait', timeoutMs: 700 }],
      memoryUpdates: [],
      nextGoalHint: 'await_better_snapshot',
    }
  }

  function hardConstraintActive(snapshot) {
    const hp = snapshot?.status?.health ?? 20
    const threat = snapshot?.threat_level || 'none'
    const closeThreat = snapshot?.close_threat === true
    const recentDamage = snapshot?.status?.recentDamageMs
    if (hp <= 8) return true
    if (threat === 'high') return true
    if (closeThreat) return true
    if (typeof recentDamage === 'number' && recentDamage >= 0 && recentDamage < 5000) return true
    return false
  }

  function applyPersonaPreferenceTieBreak(actionChain, { hints = [], profile = null, snapshot = null } = {}) {
    if (!Array.isArray(actionChain) || actionChain.length < 2) return actionChain
    if (hardConstraintActive(snapshot)) return actionChain
    const normalizedHints = (Array.isArray(hints) ? hints : []).map((x) => String(x).toLowerCase())
    const bias = profile?.strategyBias || {}
    const scoreStep = (s) => {
      const t = String(s?.type || '').toLowerCase()
      let score = 0
      if (normalizedHints.includes('ask_player_first') || normalizedHints.includes('prioritize_coop')) {
        if (t === 'chat') score += 2.1
        if (t === 'navigate' && String(s?.target || '').toLowerCase().includes('player')) score += 1.8
      }
      if (normalizedHints.includes('avoid_night_surface') || normalizedHints.includes('play_safe_at_night')) {
        if (t === 'wait' || (t === 'navigate' && String(s?.target || '').toLowerCase().includes('dirt'))) score += 1.2
      }
      if (normalizedHints.includes('keep_tools_ready') || normalizedHints.includes('keep_weapon_and_food')) {
        if (t === 'equip' || t === 'craft') score += 1.4
      }
      // persistent soft bias from profile
      if (t === 'chat') score += Number(bias.ask_player_first || 0) * 0.6
      if (t === 'navigate') score += Number(bias.avoid_night_surface || 0) * 0.2
      if (t === 'equip' || t === 'craft') score += Number(bias.keep_tools_ready || 0) * 0.45
      return score
    }
    const weighted = actionChain.map((s, idx) => ({ s, idx, score: scoreStep(s) }))
    const stableSorted = weighted
      .slice()
      .sort((a, b) => (b.score - a.score) || (a.idx - b.idx))
      .map((x) => x.s)
    return stableSorted
  }

  function setLastChainResult(result) {
    lastChainResult = result
  }

  async function phaseAnalyze({ ctx, memory, cycle }) {
    const systemPrompt = buildSystemPrompt({ mode: 'central_analyze' })
    const userPayload = buildCentralAnalyzePayload({
      snapshot: ctx.snapshot,
      memory: memory ? memory.getAll() : {},
      lastChainResult,
      cycle,
      playerMessages: ctx.playerMessages || undefined,
    })

    const result = await llm.plan({
      ctx: {},
      history: [],
      _systemPromptOverride: systemPrompt,
      _userPayloadOverride: userPayload,
      _skipValidation: true,
    })

    return {
      situationAnalysis: result?.situationAnalysis || '',
      personalityBrief: result?.personalityBrief || '',
      selfGoal: result?.selfGoal || '',
      severity: result?.severity || 'normal',
      rankedGoals: Array.isArray(result?.rankedGoals) ? result.rankedGoals : [],
      longTermLearnProposals: Array.isArray(result?.longTermLearnProposals)
        ? result.longTermLearnProposals
        : [],
      memoryUpdates: Array.isArray(result?.memoryUpdates) ? result.memoryUpdates : [],
    }
  }

  async function phasePersonality({ personality, brief, logger, cycle }) {
    if (!personality || !personality.isEnabled()) {
      return { voice: '', emotionalTags: [], suggestion: null }
    }

    try {
      const result = await personality.consultSync(brief)
      if (logger) {
        await logger.log({
          type: 'central_personality_consult', cycle,
          voice: result?.voice || '',
          emotionalTags: result?.emotionalTags || [],
          preferenceHints: result?.preferenceHints || [],
          suggestion: result?.suggestion || null,
          error: result?.error || null,
        })
      }
      return result || { voice: '', emotionalTags: [], suggestion: null }
    } catch (err) {
      if (logger) {
        await logger.log({
          type: 'central_personality_error', cycle, error: err.message,
        })
      }
      return { voice: '', emotionalTags: [], suggestion: null }
    }
  }

  async function phaseDecide({ analysis, personalityFeedback, personaStateProfile, ctx, memory }) {
    const systemPrompt = buildSystemPrompt({ mode: 'central_decide' })
    const inventorySummary = Array.isArray(ctx?.snapshot?.inventory?.summary)
      ? ctx.snapshot.inventory.summary
      : []
    const names = inventorySummary.map((i) => i?.name).filter(Boolean)
    const gate = {
      has_pickaxe: names.some((n) => n.includes('pickaxe')),
      has_axe: names.some((n) => n.includes('axe')),
      has_sword: names.some((n) => n.includes('sword')),
      has_food: names.some((n) => [
        'bread', 'apple', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken',
        'cooked_mutton', 'cooked_salmon', 'cooked_cod', 'baked_potato',
      ].includes(n)),
      has_logs: names.some((n) => n.endsWith('_log')),
      has_planks: names.some((n) => n.endsWith('_planks')),
      has_sticks: names.includes('stick'),
      topInventory: inventorySummary.slice(0, 12),
    }

    const learnTaskQueue = getQueue(memory).map((t) => ({
      id: t.id,
      summary: t.summary,
      successCriteria: t.successCriteria,
      successesRequired: t.successesRequired,
      successCount: t.successCount,
      priorityTier: t.priorityTier || 'user_long_term_habit',
    }))

    const personaPreferenceProfile = memory?.get('knowledge:persona:preference_profile')
      || personaStateProfile
      || null
    // Build available skills list for scheduling-first LLM prompt
    const availableSkills = stableSkills
      ? [...stableSkills.entries()].map(([name, s]) => ({
        name,
        category: s.category || '',
        description: s.description || '',
        tags: s.tags || [],
      }))
      : []

    const userPayload = buildCentralDecidePayload({
      analysis: {
        situationAnalysis: analysis.situationAnalysis,
        selfGoal: analysis.selfGoal,
        rankedGoals: analysis.rankedGoals || [],
      },
      personalityFeedback: {
        voice: personalityFeedback.voice,
        emotionalTags: personalityFeedback.emotionalTags,
        suggestion: personalityFeedback.suggestion,
        preferenceHints: personalityFeedback.preferenceHints || [],
      },
      personaPreferenceProfile,
      snapshot: ctx.snapshot,
      memory: memory ? memory.getAll() : {},
      inventoryGate: gate,
      learnTaskQueue,
      rankedGoals: analysis.rankedGoals || [],
      availableSkills,
    })

    const result = await llm.plan({
      ctx: {},
      history: [],
      _systemPromptOverride: systemPrompt,
      _userPayloadOverride: userPayload,
      _skipValidation: true,
    })

    const decision = {
      thought: result?.thought || '',
      actionChain: Array.isArray(result?.actionChain) ? result.actionChain : [],
      memoryUpdates: Array.isArray(result?.memoryUpdates) ? result.memoryUpdates : [],
      nextGoalHint: result?.nextGoalHint || null,
      personaPreferenceHints: Array.isArray(personalityFeedback?.preferenceHints)
        ? personalityFeedback.preferenceHints
        : [],
    }
    // Prefer stable hardcoded skills before low-level ad-hoc chain when possible.
    if (!Array.isArray(decision.actionChain) || decision.actionChain.length === 0) {
      const selected = chooseHardcodedSkill({
        goal: analysis?.selfGoal || analysis?.situationAnalysis || '',
        snapshot: ctx?.snapshot || null,
        options: { suppressWoodGather: hasExplicitUserIntent(ctx, analysis) },
      })
      if (selected?.name) {
        decision.actionChain = [{ type: 'skill_ref', name: selected.name, args: selected.args || {} }]
        decision.thought = decision.thought || `selected stable skill: ${selected.name}`
      }
    }
    decision.actionChain = compileActionChain({
      actionChain: decision.actionChain,
      goal: analysis?.selfGoal || analysis?.situationAnalysis || '',
      snapshot: ctx?.snapshot || null,
      planningContext: {
        explicitUserIntent: hasExplicitUserIntent(ctx, analysis),
        goalText: analysis?.selfGoal || ctx?.runtimeDirectives?.primaryGoal || '',
        playerTexts: (ctx.playerMessages || []).map((m) => String(m.text || '')),
      },
    })
    decision.actionChain = applyPersonaPreferenceTieBreak(
      decision.actionChain,
      {
        hints: personalityFeedback.preferenceHints || [],
        profile: personaPreferenceProfile,
        snapshot: ctx.snapshot,
      },
    )

    // Synthesis policy gate: filter out code generation steps if policy denies
    const plannerMeta = derivePlannerMeta(decision)
    decision._plannerMeta = plannerMeta
    if (plannerMeta.requiresSynthesis) {
      const policy = canSynthesize({
        plannerMeta,
        snapshot: ctx.snapshot,
        stableSkills: stableSkills || new Map(),
      })
      decision._synthesisPolicy = policy
      if (!policy.allowed) {
        decision.actionChain = filterSynthesisSteps(decision.actionChain, false)
      }
    }

    return decision
  }

  async function phaseExpectation({ analysis, decision, personality, cycle, logger }) {
    if (!personality || !personality.isEnabled()) return null
    if (!Array.isArray(decision?.actionChain) || decision.actionChain.length === 0) return null
    try {
      const expectation = await personality.consultExpectation({
        brief: analysis.personalityBrief || analysis.situationAnalysis || '',
        selfGoal: analysis.selfGoal || '',
        actionChain: decision.actionChain,
      })
      if (logger) {
        await logger.log({
          type: 'expectation_created',
          cycle,
          expectedOutcome: expectation?.expectedOutcome || '',
          confidence: expectation?.confidence ?? 0.5,
          risk: expectation?.risk || [],
          emotionIfFail: expectation?.emotionIfFail || 'confused',
          fallbackHint: expectation?.fallbackHint || '',
        })
      }
      return expectation
    } catch {
      return null
    }
  }

  async function evaluateLearnProgress({ memory, chainResult, decision, logger, cycle }) {
    if (!memory || !chainResult || !decision) return
    const overallOk = chainResult.completed >= chainResult.total
      && !chainResult.failedStep
      && !chainResult.interrupted
    if (!overallOk) return

    let queue = getQueue(memory)
    if (queue.length === 0) return

    try {
      const systemPrompt = buildSystemPrompt({ mode: 'central_learn_eval' })
      const userPayload = buildCentralLearnEvalPayload({
        pendingTasks: queue.map((t) => ({
          id: t.id,
          summary: t.summary,
          successCriteria: t.successCriteria,
          successesRequired: t.successesRequired,
          successCount: t.successCount || 0,
        })),
        plannedChain: compactChainForEval(decision.actionChain),
        chainResults: compactChainResults(chainResult.results),
        overallSuccess: true,
        selfGoal: decision.nextGoalHint || decision.thought || '',
      })

      const result = await llm.plan({
        ctx: {},
        history: [],
        _systemPromptOverride: systemPrompt,
        _userPayloadOverride: userPayload,
        _skipValidation: true,
      })

      const increments = Array.isArray(result?.increments) ? result.increments : []
      const completions = Array.isArray(result?.completions) ? result.completions : []
      const completionSummaryById = new Map(
        completions.map((c) => [c.taskId, c.habitSummary || '']).filter(([k]) => k),
      )

      for (const inc of increments) {
        if (!inc || inc.delta !== 1) continue
        const task = queue.find((t) => t.id === inc.taskId)
        if (!task) continue
        task.successCount = Math.min(
          task.successesRequired,
          (task.successCount || 0) + 1,
        )
        if (logger) {
          await logger.log({
            type: 'learn_task_progress',
            cycle,
            taskId: task.id,
            successCount: task.successCount,
            successesRequired: task.successesRequired,
          })
        }
      }

      const done = queue.filter((t) => (t.successCount || 0) >= t.successesRequired)
      queue = queue.filter((t) => (t.successCount || 0) < t.successesRequired)
      await saveQueue(memory, queue)

      for (const t of done) {
        const habitSummary = completionSummaryById.get(t.id)
          || `长期习惯已确立：${t.summary}`
        await appendHabit(memory, {
          id: t.id,
          summary: t.summary,
          habitSummary,
          source: 'learn_task',
          completedAt: new Date().toISOString(),
          successesRequired: t.successesRequired,
        })
        await memory.set(`knowledge:habit_learned:${t.id}`, habitSummary)
        if (logger) {
          await logger.log({
            type: 'learn_task_completed',
            cycle,
            taskId: t.id,
            habitSummary,
          })
        }
      }
    } catch (err) {
      if (logger) {
        await logger.log({
          type: 'learn_task_eval_error',
          cycle,
          error: err.message || String(err),
        })
      }
    }
  }

  async function think({ ctx, bot, memory, personality, logger, cycle }) {
    // Phase 1: Analyze & Translate
    const thinkStart = Date.now()
    let analysis
    try {
      analysis = await withBudget(
        phaseAnalyze({ ctx, memory, cycle }),
        analyzeBudgetMs,
        'analyze',
      )
    } catch {
      analysis = {
        situationAnalysis: 'fast_fallback: analyze timeout',
        personalityBrief: '',
        selfGoal: 'maintain progress safely',
        severity: 'normal',
        rankedGoals: [],
        longTermLearnProposals: [],
        memoryUpdates: [],
      }
    }

    if (logger) {
      await logger.log({
        type: 'central_phase1_analyze', cycle,
        situationAnalysis: analysis.situationAnalysis,
        personalityBrief: analysis.personalityBrief,
        selfGoal: analysis.selfGoal,
        memoryUpdates: analysis.memoryUpdates.length,
        rankedGoalsCount: (analysis.rankedGoals || []).length,
        learnProposalsCount: (analysis.longTermLearnProposals || []).length,
      })
    }

    // Apply phase-1 memory updates immediately
    if (memory && analysis.memoryUpdates.length > 0) {
      for (const update of analysis.memoryUpdates) {
        if (update.action === 'remember' && update.key) {
          await memory.set(update.key, update.value)
        } else if (update.action === 'forget' && update.key) {
          await memory.delete(update.key)
        }
      }
    }

    if (memory && (analysis.longTermLearnProposals || []).length > 0) {
      await mergeProposalsFromAnalysis(
        memory,
        analysis.longTermLearnProposals,
        logger,
        cycle,
      )
    }

    // Phase 2: Personality Consultation (skip on routine/low-severity cycles to save latency)
    const severity = analysis.severity || 'normal'
    const skipPersonality = severity === 'idle' && cycle % 3 !== 0

    let personalityFeedback = { voice: '', emotionalTags: [], suggestion: null }
    if (!skipPersonality) {
      try {
        personalityFeedback = await withBudget(
          phasePersonality({
            personality,
            brief: analysis.personalityBrief,
            logger,
            cycle,
          }),
          personalityBudgetMs,
          'personality',
        )
      } catch {
        personalityFeedback = { voice: '', emotionalTags: [], suggestion: null }
      }
    }

    // Refresh snapshot before decide — LLM calls above may have taken seconds,
    // entities/blocks could have changed (creeper exploded, mob despawned, etc.)
    if (bot) {
      const freshSnapshot = sense(bot, { radius: 5 })
      ctx = { ...ctx, snapshot: freshSnapshot }
    }

    // Phase 3: Final Decision
    let decision
    try {
      decision = await withBudget(
        phaseDecide({
          analysis,
          personalityFeedback,
          personaStateProfile: personality?.getState?.()?.personaProfile || null,
          ctx,
          memory,
        }),
        decideBudgetMs,
        'decide',
      )
    } catch {
      decision = quickFallbackDecision(ctx, analysis)
    }

    try {
      const elapsed = Date.now() - thinkStart
      if (elapsed < centralThinkBudgetMs - 600) {
        const expectation = await phaseExpectation({
          analysis,
          decision,
          personality,
          cycle,
          logger,
        })
        if (expectation) decision.expectation = expectation
      }
    } catch { /* optional phase */ }

    if (logger) {
      await logger.log({
        type: 'central_phase3_decide', cycle,
        thought: decision.thought,
        actionChainLength: decision.actionChain.length,
        nextGoalHint: decision.nextGoalHint,
      })
    }

    lastChainResult = null
    return decision
  }

  return Object.freeze({ think, setLastChainResult, evaluateLearnProgress })
}

module.exports = { createCentralReasoning }
