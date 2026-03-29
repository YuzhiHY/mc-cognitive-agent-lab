const assert = require('node:assert')
const { probe, isSolid, isDisposable } = require('../src/runtime/feeler')

// ─── Helpers ─────────────────────────────────────────────────────────

function makeBlock(name, diggable = true) {
  return { name, diggable, position: { x: 0, y: 0, z: 0 } }
}

function air() { return makeBlock('air') }
function stone() { return makeBlock('stone') }
function dirt() { return makeBlock('dirt') }
function leaves() { return makeBlock('oak_leaves') }

function mockBot(overrides = {}) {
  const blocks = overrides.blocks || {}
  return {
    entity: {
      position: {
        x: 10, y: 64, z: 10,
        floored: () => ({ x: 10, y: 64, z: 10, offset: (dx, dy, dz) => ({ x: 10 + dx, y: 64 + dy, z: 10 + dz }) }),
        distanceTo: () => 0,
        clone: () => ({ x: 10, y: 64, z: 10 }),
      },
      yaw: 0, // facing south (-z)
      id: 1,
    },
    blockAt: (pos) => {
      const key = `${pos.x},${pos.y},${pos.z}`
      return blocks[key] || air()
    },
    ...overrides,
  }
}

// ─── Tests ───────────────────────────────────────────────────────────

// isSolid
assert.ok(!isSolid(null), 'null is not solid')
assert.ok(!isSolid(makeBlock('air')), 'air is not solid')
assert.ok(!isSolid(makeBlock('cave_air')), 'cave_air is not solid')
assert.ok(isSolid(makeBlock('stone')), 'stone is solid')
assert.ok(isSolid(makeBlock('dirt')), 'dirt is solid')

// isDisposable
assert.strictEqual(isDisposable(makeBlock('dirt')), true, 'dirt is disposable')
assert.strictEqual(isDisposable(makeBlock('sand')), true, 'sand is disposable')
assert.strictEqual(isDisposable(makeBlock('gravel')), true, 'gravel is disposable')
assert.strictEqual(isDisposable(makeBlock('oak_leaves')), true, 'oak_leaves is disposable')
assert.strictEqual(isDisposable(makeBlock('cobweb')), true, 'cobweb is disposable')
assert.strictEqual(isDisposable(makeBlock('stone')), false, 'stone is NOT disposable')
assert.strictEqual(isDisposable(makeBlock('diamond_ore')), false, 'ore is NOT disposable')
assert.strictEqual(isDisposable(makeBlock('chest')), false, 'chest is NOT disposable')
assert.strictEqual(isDisposable(makeBlock('crafting_table')), false, 'crafting_table is NOT disposable')

// probe — clear surroundings
{
  const bot = mockBot()
  const pr = probe(bot)
  assert.ok(pr, 'probe returns result')
  assert.strictEqual(pr.forward.blocked, false, 'forward not blocked in clear space')
  assert.strictEqual(pr.ground.gapAhead, true, 'gap ahead when no ground forward')
  assert.strictEqual(pr.ceiling.low, false, 'ceiling not low')
}

// probe — forward feet blocked
{
  // Yaw=0 means forward is -z direction: (10, 64, 9)
  const bot = mockBot({
    blocks: {
      '10,64,9': stone(), // feet level, forward
    },
  })
  const pr = probe(bot)
  assert.strictEqual(pr.forward.feetSolid, true, 'forward feet solid')
  assert.strictEqual(pr.forward.headSolid, false, 'forward head clear')
  assert.strictEqual(pr.forward.blocked, true, 'forward blocked (feet)')
}

// probe — forward head blocked
{
  const bot = mockBot({
    blocks: {
      '10,65,9': stone(), // head level, forward
    },
  })
  const pr = probe(bot)
  assert.strictEqual(pr.forward.feetSolid, false, 'forward feet clear')
  assert.strictEqual(pr.forward.headSolid, true, 'forward head solid')
  assert.strictEqual(pr.forward.blocked, true, 'forward blocked (head)')
}

// probe — target yaw calculation
{
  const bot = mockBot()
  // Target to the east (x+5)
  const pr = probe(bot, { x: 15, y: 64, z: 10 })
  assert.ok(pr.target.distance != null, 'has target distance')
  assert.ok(Math.abs(pr.target.distance - 5) < 0.1, 'target distance ~5')
  assert.ok(pr.target.yawDelta != null, 'has yaw delta')
}

// probe — left/right clear detection
{
  const bot = mockBot({
    blocks: {
      // Block left side (yaw=0, left is +x)
      '11,64,10': stone(),
    },
  })
  const pr = probe(bot)
  assert.strictEqual(pr.left.clear, false, 'left not clear when blocked')
  assert.strictEqual(pr.right.clear, true, 'right is clear')
}

// probe — returns null when bot has no position
{
  const bot = { entity: {} }
  const pr = probe(bot)
  assert.strictEqual(pr, null, 'returns null without position')
}

console.log('feeler tests passed')
