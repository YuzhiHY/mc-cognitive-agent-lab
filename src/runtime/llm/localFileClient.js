const fs = require('node:fs')
const path = require('node:path')
const { validateLLMResponse } = require('./types')

function createLocalFileLLMClient({ inputPath }) {
  const resolved = path.resolve(process.cwd(), inputPath)
  return Object.freeze({
    name: 'localFileClient',
    async plan({ ctx, history, _skipValidation }) {
      void ctx
      void history
      const raw = await fs.promises.readFile(resolved, 'utf8')
      const json = JSON.parse(raw)
      if (_skipValidation) return json
      return validateLLMResponse(json)
    },
  })
}

module.exports = { createLocalFileLLMClient }

