function createBodyActions({ api, bot }) {
  return Object.freeze({
    navigateTo: async (pos, options = {}) => api.executeAction('navigate', { pos, options }),
    digByName: async (name, options = {}) => api.executeAction('digByName', { name, options }),
    craftAny: async (item, count = 1) => api.executeAction('craftAny', { item, count }),
    smeltItem: async (item, options = {}) => api.executeAction('smeltItem', { item, options }),
    placeTorchSmart: async (options = {}) => api.executeAction('placeTorchSmart', { options }),
    attackNearest: async (entityType) => api.executeAction('attackNearest', { entityType }),
    equipByName: async (name, destination = 'hand') => {
      await api.equipByName(name, destination)
      return {
        ok: true,
        status: 'success',
        source: 'api',
        actionType: 'equipByName',
        reason: 'equipped',
      }
    },
    lookAt: async (pos, force = true) => {
      await api.lookAt(pos, force)
      return {
        ok: true,
        status: 'success',
        source: 'api',
        actionType: 'lookAt',
        reason: 'looked_at',
      }
    },
    bot,
  })
}

module.exports = { createBodyActions }

