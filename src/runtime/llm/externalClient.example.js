const { validateLLMResponse } = require('./types')

/**
 * Example adapter interface for external LLM APIs (OpenAI/Anthropic/etc).
 * Replace request part with your provider SDK call.
 */
function createExternalLLMClient({ request }) {
  if (typeof request !== 'function') {
    throw new Error('createExternalLLMClient: request must be a function')
  }

  return Object.freeze({
    name: 'externalClient',
    async plan({ ctx, history }) {
      const promptPayload = {
        instruction:
          'Return strict JSON with thought, skillName, code. Export module.exports.run = async ({ api, ctx }) => { ... }.',
        ctx,
        history,
      }

      const raw = await request(promptPayload)
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      return validateLLMResponse(parsed)
    },
  })
}

module.exports = { createExternalLLMClient }

