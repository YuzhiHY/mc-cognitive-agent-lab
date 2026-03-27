const { validateLLMResponse } = require('./types')
const { parseJsonLoose } = require('./json')
const { buildSystemPrompt, buildUserPayload } = require('./prompt')

function createAnthropicLLMClient({
  apiKey,
  model = 'claude-3-7-sonnet-latest',
  baseUrl = 'https://api.anthropic.com/v1',
  timeoutMs = 15_000,
}) {
  if (!apiKey) throw new Error('Anthropic apiKey is required')

  return Object.freeze({
    name: 'anthropic',
    async plan({ ctx, history, _systemPromptOverride, _userPayloadOverride, _skipValidation }) {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const systemContent = _systemPromptOverride
          || buildSystemPrompt({ mode: process.env.LLM_PROMPT_MODE || 'default' })
        const userContent = _userPayloadOverride
          || buildUserPayload({ ctx, history })

        const res = await fetch(`${baseUrl}/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            max_tokens: 1200,
            temperature: 0.2,
            system: systemContent,
            messages: [
              { role: 'user', content: userContent },
            ],
          }),
          signal: controller.signal,
        })

        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(`Anthropic error: HTTP ${res.status} ${text}`)
        }

        const json = await res.json()
        const text = json?.content?.find?.((c) => c?.type === 'text')?.text
        const parsed = parseJsonLoose(text)
        if (_skipValidation) return parsed
        return validateLLMResponse(parsed)
      } finally {
        clearTimeout(t)
      }
    },
  })
}

module.exports = { createAnthropicLLMClient }

