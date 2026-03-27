const dotenv = require('dotenv')
const fs = require('node:fs')
const path = require('node:path')

const primaryEnvPath = path.resolve(process.cwd(), '.env')
const fallbackEnvPath = path.resolve(process.cwd(), '.gitignore', '.env')
if (fs.existsSync(primaryEnvPath)) {
  dotenv.config({ path: primaryEnvPath })
} else if (fs.existsSync(fallbackEnvPath)) {
  dotenv.config({ path: fallbackEnvPath })
} else {
  dotenv.config()
}

const { createBot } = require('./runtime/bot')
const { createEngine } = require('./runtime/engine')
const { createLocalFileLLMClient } = require('./runtime/llm/localFileClient')
const { createOpenAILLMClient } = require('./runtime/llm/openaiClient')
const { createAnthropicLLMClient } = require('./runtime/llm/anthropicClient')
const { createDeepSeekLLMClient } = require('./runtime/llm/deepseekClient')

function getLLMClient() {
  const provider = (process.env.LLM_PROVIDER || 'local').toLowerCase()
  if (provider === 'openai') {
    return createOpenAILLMClient({
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      timeoutMs: process.env.LLM_TIMEOUT_MS ? Number(process.env.LLM_TIMEOUT_MS) : 15_000,
    })
  }
  if (provider === 'anthropic') {
    return createAnthropicLLMClient({
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL || 'claude-3-7-sonnet-latest',
      baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1',
      timeoutMs: process.env.LLM_TIMEOUT_MS ? Number(process.env.LLM_TIMEOUT_MS) : 15_000,
    })
  }

  if (provider === 'deepseek') {
    return createDeepSeekLLMClient({
      apiKey: process.env.DEEPSEEK_API_KEY,
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      timeoutMs: process.env.LLM_TIMEOUT_MS ? Number(process.env.LLM_TIMEOUT_MS) : 15_000,
    })
  }

  const promptMode = (process.env.LLM_PROMPT_MODE || 'default').toLowerCase()
  const defaultLocalInput =
    promptMode === 'decision' ? './skills/_next.decision.json' : './skills/_next.json'
  const localInputPath = process.env.LLM_INPUT_PATH || defaultLocalInput
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        type: 'local_llm_config',
        LLM_PROMPT_MODE: promptMode,
        LLM_INPUT_PATH: localInputPath,
        note: process.env.LLM_INPUT_PATH
          ? 'Using LLM_INPUT_PATH from env'
          : `Using default for mode=${promptMode}`,
      },
      null,
      2
    )
  )

  return createLocalFileLLMClient({
    inputPath: localInputPath,
  })
}

function getPersonalityLLMClient() {
  const enabled = String(process.env.PERSONALITY_ENABLED || 'false').toLowerCase() === 'true'
  if (!enabled) return null

  const provider = (process.env.PERSONALITY_LLM_PROVIDER || '').toLowerCase()
  const apiKey = process.env.PERSONALITY_LLM_API_KEY
  const model = process.env.PERSONALITY_LLM_MODEL
  const timeoutMs = process.env.LLM_TIMEOUT_MS ? Number(process.env.LLM_TIMEOUT_MS) : 15_000
  const personalityTimeoutMs = process.env.PERSONALITY_LLM_TIMEOUT_MS
    ? Number(process.env.PERSONALITY_LLM_TIMEOUT_MS)
    : Math.min(timeoutMs, 8000)

  const baseUrl = process.env.PERSONALITY_LLM_BASE_URL

  if ((provider === 'openai' || provider === 'openrouter') && apiKey) {
    const defaultBase = provider === 'openrouter'
      ? 'https://openrouter.ai/api/v1'
      : 'https://api.openai.com/v1'
    return createOpenAILLMClient({
      apiKey,
      model: model || (provider === 'openrouter' ? 'deepseek/deepseek-chat' : 'gpt-4.1-mini'),
      baseUrl: baseUrl || defaultBase,
      timeoutMs: personalityTimeoutMs,
    })
  }
  if (provider === 'anthropic' && apiKey) {
    return createAnthropicLLMClient({
      apiKey,
      model: model || 'claude-3-7-sonnet-latest',
      baseUrl: baseUrl || 'https://api.anthropic.com/v1',
      timeoutMs: personalityTimeoutMs,
    })
  }
  if (provider === 'deepseek' && apiKey) {
    return createDeepSeekLLMClient({
      apiKey,
      model: model || 'deepseek-chat',
      baseUrl: baseUrl || 'https://api.deepseek.com',
      timeoutMs: personalityTimeoutMs,
    })
  }

  // eslint-disable-next-line no-console
  console.log('PERSONALITY_ENABLED=true but no valid provider/key configured, personality disabled')
  return null
}

const isDaemonMode =
  process.argv.includes('--daemon')
  || String(process.env.DAEMON_MODE || 'false').toLowerCase() === 'true'
const isLiveSelftestMode =
  process.argv.includes('--live-selftest')
  || String(process.env.LIVE_SELFTEST_MODE || 'false').toLowerCase() === 'true'

async function runSingleTask(bot, llm, personalityLlm) {
  const engine = createEngine({
    bot,
    llm,
    personalityLlm,
    hardTimeoutMs: process.env.HARD_TIMEOUT_MS
      ? Number(process.env.HARD_TIMEOUT_MS)
      : 10_000,
  })

  const result = await engine.runTask({
    task: {
      id: process.env.TASK_ID || `task_${Date.now()}`,
      goal: process.env.TASK_GOAL || 'demo',
    },
  })

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2))
  bot.quit('task finished')
}

async function runDaemon(bot, llm, personalityLlm) {
  const { createDaemon } = require('./runtime/daemon')
  const { createReflexLayer } = require('./runtime/reflexLayer')
  const { createMemory } = require('./runtime/memory')
  const { createCentralReasoning } = require('./runtime/centralReasoning')
  const { createChainExecutor } = require('./runtime/chainExecutor')

  const { createStableSkillRepository } = require('./runtime/skills')
  const reflexEnabled = String(process.env.REFLEX_ENABLED || 'true').toLowerCase() === 'true'
  const reflexLayer = reflexEnabled ? createReflexLayer(bot) : null
  const memory = createMemory()
  const stableSkills = createStableSkillRepository()
  const centralReasoning = createCentralReasoning({ llm, personalityLlm, stableSkills })
  const chainExecutor = createChainExecutor()

  const daemon = createDaemon({
    bot,
    llm,
    personalityLlm,
    reflexLayer,
    centralReasoning,
    chainExecutor,
    memory,
    thinkIntervalMs: process.env.THINK_INTERVAL_MS
      ? Number(process.env.THINK_INTERVAL_MS)
      : 2000,
  })

  const shutdown = () => {
    // eslint-disable-next-line no-console
    console.log('\n[daemon] Shutting down gracefully...')
    daemon.stop()
    setTimeout(() => {
      bot.quit('daemon stopped')
      process.exit(0)
    }, 1000)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await daemon.start()
}

async function runLiveSelftestMode(bot) {
  const { runLiveSelftest } = require('./runtime/liveSelftest')
  const rounds = process.env.LIVE_SELFTEST_ROUNDS ? Number(process.env.LIVE_SELFTEST_ROUNDS) : 2
  const result = await runLiveSelftest({ bot, rounds: Number.isFinite(rounds) ? rounds : 2 })
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ type: 'live_selftest_result', ...result }, null, 2))
  bot.quit(result.ok ? 'live selftest passed' : 'live selftest failed')
  if (!result.ok) process.exitCode = 2
}

async function main() {
  const bot = await createBot({
    host: process.env.MC_HOST,
    port: process.env.MC_PORT ? Number(process.env.MC_PORT) : undefined,
    username: process.env.MC_USERNAME,
    version: process.env.MC_VERSION,
  })

  const llm = getLLMClient()
  const personalityLlm = getPersonalityLLMClient()

  if (isLiveSelftestMode) {
    await runLiveSelftestMode(bot)
  } else if (isDaemonMode) {
    await runDaemon(bot, llm, personalityLlm)
  } else {
    await runSingleTask(bot, llm, personalityLlm)
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[fatal]', err)
  process.exitCode = 1
})

