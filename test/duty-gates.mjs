/**
 * 值守闸门 —— 2026-11-25 本人提的第 3 点：
 *   「反思在總開關時仍有在跑，還要在峰時，浪費我token」
 *
 * 这条测试就是钉住那两件事：
 *   A. 总开关关了，任何路都不能起一轮（包括 force / 手动触发 / 显式 kinds）。
 *   B. valleyOnly 开着时，峰时不起轮 —— 而且跑到 tick 里也一样。
 *
 * 为什么需要它：arm() 里的 `if (!store.cfg.enabled)` 早就在了，但从来没人测过。
 * 没有测试钉住，下一次改 force 的语义时很容易又把它挪到后面去。
 */
import assert from 'node:assert/strict'

const results = []
const t = async (name, fn) => {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  ok   ${name}`)
  } catch (err) {
    results.push({ name, ok: false, err })
    console.log(`  FAIL ${name}\n       ${err?.message || err}`)
  }
}

const { makeDuty } = await import('../lib/duty.js')

/** 一个够用的假 store：只有 arm/tick 会碰到的字段。 */
function fakeStore({ enabled = true, valleyOnly = true, valley = false } = {}) {
  const created = []
  return {
    created,
    cfg: {
      enabled,
      bili: false,
      reflection: true,
      valleyOnly,
      reflectionEveryHours: 6,
      reflectionAt: null,
      biliEveryHours: 20,
      dutyMaxPerDay: 4,
    },
    memories: new Map([['m-1', { id: 'm-1', tier: 3 }]]),
    persona: { traits: [], taste: [] },
    pending: new Map(),
    runtime: { dutyLog: [], lastReflectionAt: null, lastBiliAt: null, armed: null },
    activeMemories: () => [],
    append: () => ({ ok: true }),
    persistRuntime: () => {},
    valley: () => valley,
  }
}

/** ctx 只提供 arm() 需要的 schedule 服务。 */
function fakeCtx(created) {
  return {
    get: (name) =>
      name === 'schedule'
        ? {
            create: async (req) => {
              created.push(req)
              return { id: 'sch-1', target: { sessionId: 's-1' } }
            },
            view: async () => ({ status: 'ended' }),
            edit: async () => ({ ok: true }),
          }
        : undefined,
  }
}

// ── A. 总开关关着 ────────────────────────────────────────────
await t('A1 总开关关着：arm() 被拦住，不建任何排程', async () => {
  const store = fakeStore({ enabled: false })
  const duty = makeDuty({ ctx: fakeCtx(store.created), store, log: () => {} })
  const res = await duty.arm({})
  assert.equal(res.ok, false)
  assert.equal(res.blockedBy, 'disabled')
  assert.equal(store.created.length, 0)
})

await t('A2 总开关关着：force=true 也拦得住（这是这次的重点）', async () => {
  const store = fakeStore({ enabled: false })
  const duty = makeDuty({ ctx: fakeCtx(store.created), store, log: () => {} })
  const res = await duty.arm({ force: true })
  assert.equal(res.ok, false)
  assert.equal(res.blockedBy, 'disabled')
  assert.equal(store.created.length, 0, '总开关关着还是建了排程 —— 就是靠 force 钻过去了')
})

await t('A3 总开关关着：显式指定 kinds 也拦得住', async () => {
  const store = fakeStore({ enabled: false })
  const duty = makeDuty({ ctx: fakeCtx(store.created), store, log: () => {} })
  const res = await duty.arm({ force: true, kinds: ['reflect', 'bili'] })
  assert.equal(res.ok, false)
  assert.equal(res.blockedBy, 'disabled')
  assert.equal(store.created.length, 0)
})

await t('A4 总开关关着：tick() 什么都不起', async () => {
  const store = fakeStore({ enabled: false })
  const duty = makeDuty({ ctx: fakeCtx(store.created), store, log: () => {} })
  await duty.tick()
  assert.equal(store.created.length, 0)
  assert.equal(store.runtime.armed, null)
})

// ── B. 峰时不跑 ─────────────────────────────────────────────
//
// ⚠️ 这两条只能在「真实时钟正好是峰时」的时候才有意义：arm() / tick() 里
//    用的是真实的 inValley(Date.now())，假 store 骗不到它。
//    所以实测时先自己算一次；现在是谷时就跳过，并明确说「没测到」，
//    不要让它静悄悄地 pass —— 那样这条闸就没被钉住过。
const { inValley } = await import('../lib/duty.js')
const nowIsPeak = !inValley().ok

await t('B1 valleyOnly 开着 + 峰时：arm() 连 force 也拦得住', async () => {
  if (!nowIsPeak) {
    console.log(`       (跳过：现在实际是「${inValley().label}」，不是峰时，这条闸测不到)`)
    return
  }
  const store = fakeStore({ enabled: true, valleyOnly: true })
  const duty = makeDuty({ ctx: fakeCtx(store.created), store, log: () => {} })
  const res = await duty.arm({ force: true })
  assert.equal(res.ok, false)
  assert.equal(store.created.length, 0, '峰时 force 起了轮 —— 就是「还要在峰时浪费 token」')
})

await t('B2 valleyOnly 开着 + 峰时：tick() 不起轮', async () => {
  if (!nowIsPeak) {
    console.log(`       (跳过：现在实际是「${inValley().label}」，不是峰时，这条闸测不到)`)
    return
  }
  const store = fakeStore({ enabled: true, valleyOnly: true })
  const duty = makeDuty({ ctx: fakeCtx(store.created), store, log: () => {} })
  await duty.tick()
  assert.equal(store.created.length, 0, '峰时起了轮 —— 这就是「还要在峰时浪费 token」')
})

// 上面两条靠真实时钟，测不到的时候用纯函数钉住窗口判断本身。
await t('B2b inValley 的窗口判断正确（峰时/谷时各取一个点）', async () => {
  const peak = new Date('2026-11-25T04:00:00Z').getTime() // 周三 12:00 東八區 → 中午谷时
  assert.equal(inValley(peak).ok, true, '中午 12:00 应该是谷时')
  const realPeak = new Date('2026-11-25T07:00:00Z').getTime() // 周三 15:00 東八區 → 峰时
  assert.equal(inValley(realPeak).ok, false, '下午 15:00 应该是峰时')
})

await t('B3 全新 Store 的 valleyOnly 默认是 true（不是靠用户自己去开）', async () => {
  // 不导出 DEFAULT_CONFIG（那会多开一个对外面），所以直接建一个空的 Store 问它。
  // home 给临时目录：不碰真实账本。config.json 不存在时就是纯默认值。
  const { Store } = await import('../lib/store.js')
  const os = await import('node:os')
  const fs = await import('node:fs')
  const path = await import('node:path')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'silt-gate-'))
  try {
    const store = new Store(home)
    assert.equal(store.cfg.valleyOnly, true, 'valleyOnly 的默认值不是 true —— 新用户一装上就会在峰时烧 token')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
if (failed.length) process.exitCode = 1
