const { createStableSkillRepository } = require('./index')

function getHardcodedSkills() {
  return createStableSkillRepository()
}

module.exports = { getHardcodedSkills }

