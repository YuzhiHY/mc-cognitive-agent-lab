const FOOD_ITEMS = new Set([
  'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
  'cooked_rabbit', 'cooked_salmon', 'cooked_cod', 'baked_potato', 'golden_apple',
  'apple', 'melon_slice', 'sweet_berries', 'carrot', 'beetroot', 'dried_kelp',
  'mushroom_stew', 'rabbit_stew', 'beetroot_soup', 'pumpkin_pie', 'cookie',
  'golden_carrot', 'enchanted_golden_apple',
])

module.exports.run = async ({ api, bot }) => {
  const inventory = bot.inventory.items()
  const foodItem = inventory.find((item) => FOOD_ITEMS.has(item?.name))

  if (!foodItem) {
    return { done: false, reason: 'no food in inventory' }
  }

  await bot.equip(foodItem, 'hand')
  bot.activateItem()
  await api.sleep(1800)
  bot.deactivateItem()

  return {
    done: true,
    reason: `ate ${foodItem.name}`,
    healthBefore: bot.health,
  }
}
