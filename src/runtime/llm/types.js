function validateLLMResponse(x) {
  if (!x || typeof x !== 'object') throw new Error('LLM response must be an object')
  if (typeof x.thought !== 'string') throw new Error('LLM response must include string field: thought')
  if (typeof x.skillName !== 'string' || !x.skillName.trim())
    throw new Error('LLM response must include string field: skillName')
  if (typeof x.code !== 'string' || !x.code.trim())
    throw new Error('LLM response must include string field: code')
  return {
    thought: x.thought,
    skillName: x.skillName,
    code: x.code,
  }
}

module.exports = { validateLLMResponse }

