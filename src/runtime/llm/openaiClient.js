const { validateLLMResponse } = require('./types')
const { parseJsonLoose } = require('./json')
const { buildSystemPrompt, buildUserPayload } = require('./prompt')

function createOpenAILLMClient({
  apiKey,
  model = 'gpt-4.1-mini',
  baseUrl = 'https://api.openai.com/v1',
  timeoutMs = 15_000,
}) {
  if (!apiKey) throw new Error('OpenAI apiKey is required')

  return Object.freeze({
    name: 'openai',
    async plan({ ctx, history, _systemPromptOverride, _userPayloadOverride, _skipValidation }) {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const systemContent = _systemPromptOverride
          || buildSystemPrompt({ mode: process.env.LLM_PROMPT_MODE || 'default' })
        const userContent = _userPayloadOverride
          || buildUserPayload({ ctx, history })

        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            messages: [
              { role: 'system', content: systemContent },
              { role: 'user', content: userContent },
            ],
            response_format: { type: 'json_object' },
          }),
          signal: controller.signal,
        })

        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(`OpenAI error: HTTP ${res.status} ${text}`)
        }

        const json = await res.json()
        const content = json?.choices?.[0]?.message?.content
        const parsed = parseJsonLoose(content)
        if (_skipValidation) return parsed
        return validateLLMResponse(parsed)
      } finally {
        clearTimeout(t)
      }
    },
  })
}

module.exports = { createOpenAILLMClient }

