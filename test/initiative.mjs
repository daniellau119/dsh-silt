/**
 * 2026-11-26 主動發起對話（autonomous check-in）的回歸測試。
 *
 * 本人要求的是：「不用任何對話、隔幾小時就自己來找我」——
 * 利用反思時間，而不是在對話裡加一段「有判斷就說」的站姿。
 *
 * 這幾條釘住：
 *   ① 反思任務書第 9 節要求它用 silt_speak 來說一句（或 defer），不是靜靜結束；
 *   ② 主動訊息送進 homeSession（本人最後說話的會話），不是沒人看的新房間；
 *   ③ 沒有 homeSession 時才退回上次開口的會話／新會話；
 *   ④ 提示詞裡沒有【我的立場】這種對話內的主動性段落。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { Store } = await import('../lib/store.js')
const { makeDuty } = await import('../lib/duty.js')

let pass = 0
let fail = 0
const ok = (c, l) => (c ? (pass++, console.log(`  ok   ${l}`)) : (fail++, console.log(`  FAIL ${l}`)))
const mkHome = () => mkdtempSync(join(tmpdir(), 'silt-init-'))

/** 只給 arm()/speak() 用的假 store；不碰真帳本。 */
function fakeStore({ homeAgeMs = 60_000, lastSpoke = '', noHome = false } = {}) {
  const s = {
    cfg: {
      enabled: true,
      reflection: true,
      valleyOnly: false,
      reflectionEveryHours: 6,
      reflectionAt: null,
      dutyMaxPerDay: 4,
      tier4TtlHours: 48,
      speak: true,
    },
    memories: new Map([['m-1', { id: 'm-1', tier: 3 }]]),
    persona: { traits: [], taste: [] },
    runtime: {
      dutyLog: [],
      lastReflectionAt: null,
      armed: null,
      homeSession: noHome ? null : { sessionId: 'session-home', at: Date.now() - homeAgeMs },
      lastSpokeSession: lastSpoke,
      speakLog: [],
    },
    activeMemories: () => [],
    append: () => ({}),
    persistRuntime: () => {},
    valleyOf: () => ({ ok: true, window: 'test', label: '測試谷時' }),
    speakGate: () => ({ ok: true, reasons: [], valley: { ok: true, label: '測試谷時' }, spokenToday: 1 }),
    recordSpeak(entry) {
      const at = new Date().toISOString()
      s.runtime.lastSpokeAt = at
      s.runtime.speakLog.push({ ...entry, at })
      return { ...entry, at }
    },
    spokenToday: () => 1,
  }
  return s
}

function fakeSchedule(created) {
  return {
    create: async (request) => {
      created.push(request)
      return { id: `sch-${created.length}`, target: { kind: 'session', sessionId: request.target.sessionId || 'session-new' }, status: 'active' }
    },
  }
}

console.log('1) 反思任務書第 9 節：一定要用 silt_speak 來說一句')
{
  const s = fakeStore()
  const created = []
  const duty = makeDuty({ ctx: { get: () => fakeSchedule(created) }, store: s, log: () => {} })
  const r = await duty.arm({ force: true })
  ok(r.ok === true, `arm 成功（${r.ok ? '' : r.error}）`)
  const prompt = created[0]?.prompt || ''
  ok(prompt.includes('9. 收尾與來找他'), '有「收尾與來找他」這一節')
  ok(prompt.includes('用 silt_speak 跟他說一句'), '明說要用 silt_speak 說一句')
  ok(prompt.includes('不必是大事'), '說明不必是大事，降低開口的門檻')
  ok(prompt.includes('不要用 defer 當默認'), 'defer 不是默認')
  ok(prompt.includes('op:"defer"'), '沒有話也要 defer 寫理由，不能靜靜結束')
}

console.log('\n2) 主動訊息送進 homeSession，而不是新房間')
{
  const s = fakeStore()
  const created = []
  const duty = makeDuty({ ctx: { get: () => fakeSchedule(created) }, store: s, log: () => {} })
  const r = await duty.speak({ text: '我想跟你說一件事。', kind: 'share' })
  ok(r.ok === true, `speak 成功（${r.ok ? '' : r.error}）`)
  ok(created[0]?.target?.kind === 'session', 'target 是既有會話')
  ok(created[0]?.target?.sessionId === 'session-home', `目標是 homeSession（${created[0]?.target?.sessionId}）`)
}

console.log('\n3) 就算很久沒說話（30 天），也回最後那個會話 —— 不另開新房間')
{
  const s = fakeStore({ homeAgeMs: 30 * 24 * 3600 * 1000 })
  const created = []
  const duty = makeDuty({ ctx: { get: () => fakeSchedule(created) }, store: s, log: () => {} })
  const r = await duty.speak({ text: '還有人嗎？', kind: 'share' })
  ok(r.ok === true, 'speak 仍然成功')
  ok(created[0]?.target?.sessionId === 'session-home', `還是回 homeSession（${created[0]?.target?.sessionId}）`)
}

console.log('\n3b) homeSession 已歸檔：退回 new_once')
{
  const s = fakeStore()
  const created = []
  const schedule = {
    create: async (req) => {
      created.push(req)
      if (req.target.kind === 'session') throw new Error('schedule/target-archived')
      return { id: 'sch-new', target: { kind: 'new_once', sessionId: 'session-new' }, status: 'active' }
    },
  }
  const duty = makeDuty({ ctx: { get: () => schedule }, store: s, log: () => {} })
  const r = await duty.speak({ text: '換個地方說。', kind: 'share' })
  ok(r.ok === true, `歸檔時仍然送得出去（${r.ok ? '' : r.error}）`)
  ok(created[1]?.target?.kind === 'new_once', '退回 new_once')
}

console.log('\n4) 沒有 homeSession 但有 lastSpokeSession：優先用上次開口的會話')
{
  const s = fakeStore({ noHome: true, lastSpoke: 'session-last' })
  const created = []
  const duty = makeDuty({ ctx: { get: () => fakeSchedule(created) }, store: s, log: () => {} })
  const r = await duty.speak({ text: '再說一句。', kind: 'share' })
  ok(r.ok === true, 'speak 成功')
  ok(created[0]?.target?.sessionId === 'session-last', `目標是 lastSpokeSession（${created[0]?.target?.sessionId}）`)
}

console.log('\n5) 提示詞不再有【我的立場】這種對話內的主動性段落')
{
  const s = new Store(mkHome()).load()
  s.cfg = { ...s.cfg, enabled: true }
  const text = s.injectionText()
  ok(!text.includes('【我的立場】'), '沒有【我的立場】')
  ok(!text.includes('不是只等他問'), '沒有「不是只等他問」')
  ok(text.includes('【仍記得的】'), '記憶塊仍然在')
  rmSync(s.home, { recursive: true, force: true })
}

console.log('\n6) silt_speak 的 kind 維持原本四種（不加入對話內語義）')
{
  const tools = (await import('../lib/tools.js')).buildTools(fakeStore(), { speak: async () => ({ ok: true }) })
  const speak = tools.find((x) => x.name === 'silt_speak')
  const kinds = speak?.parameters?.properties?.kind?.enum || []
  ok(kinds.length === 4 && kinds.includes('share') && kinds.includes('ask'), `只有 share/ask/remind/greet（${kinds.join(',')}）`)
  ok(!kinds.includes('opinion') && !kinds.includes('request'), '沒有 opinion / request')
}

console.log('\n7) 兩者都填時：固定反思鐘點為準，間隔不生效')
{
  const s = fakeStore()
  s.cfg.reflectionAt = ['08:00', '19:00']
  s.cfg.reflectionEveryHours = 6
  s.runtime.lastReflectionAt = new Date('2026-11-25T21:00:00+08:00').toISOString()
  const duty = makeDuty({ ctx: { get: () => undefined }, store: s, log: () => {} })

  // 06 小時早就過了，但固定鐘點的下一個 08:00 還沒到
  const before = duty.computeDue(Date.parse('2026-11-26T07:00:00+08:00'))
  ok(before.fixedSlot !== undefined, '固定鐘點有被解析')
  ok(before.reflection === false, '間隔已過但固定鐘點未到 ⇒ 不跑（固定鐘點為準）')

  const after = duty.computeDue(Date.parse('2026-11-26T08:30:00+08:00'))
  ok(after.reflection === true, '08:00 過了 ⇒ 跑')

  // 清掉固定鐘點，間隔才生效
  s.cfg.reflectionAt = null
  s.cfg.reflectionEveryHours = 6
  s.runtime.lastReflectionAt = new Date('2026-11-26T02:00:00+08:00').toISOString()
  const five = duty.computeDue(Date.parse('2026-11-26T07:00:00+08:00'))
  ok(five.reflection === false, '沒有固定鐘點、只過 5 小時 ⇒ 不跑')
  const seven = duty.computeDue(Date.parse('2026-11-26T09:00:00+08:00'))
  ok(seven.reflection === true, '沒有固定鐘點、過了 7 小時 ⇒ 跑')
}

console.log('\n8) 每天上限是「最多幾輪」，不是「幾點跑」')
{
  const s = fakeStore()
  s.cfg.dutyMaxPerDay = 1
  s.runtime.dutyLog = [{ at: new Date().toISOString(), kinds: ['reflect'] }]
  const created = []
  const duty = makeDuty({ ctx: { get: () => fakeSchedule(created) }, store: s, log: () => {} })
  const blocked = await duty.arm({ force: false })
  ok(blocked.ok === false && String(blocked.error).includes('今天'), `今天已用完時擋住（${blocked.error}）`)
  ok(created.length === 0, '沒有建排程')
  const forced = await duty.arm({ force: true })
  ok(forced.ok === true, `手動 force 可以超過每日上限（${forced.ok ? '' : forced.error}）`)
  ok(created.length === 1, '只多了手動那一輪')
}

console.log('\n9) 心跳對齊下一個固定鐘點（不是 60 分鐘盲拍）')
{
  const s = fakeStore()
  s.cfg.reflectionAt = ['19:00', '07:00']
  const duty = makeDuty({ ctx: { get: () => undefined }, store: s, log: () => {} })
  const before = duty.nextWakeAt(Date.parse('2026-11-26T18:30:00+08:00'))
  ok(before === Date.parse('2026-11-26T19:00:01+08:00'), `18:30 → 19:00:01（${new Date(before).toISOString()}）`)
  const after = duty.nextWakeAt(Date.parse('2026-11-26T19:30:00+08:00'))
  ok(after === Date.parse('2026-11-26T20:30:00+08:00'), `19:30 → 下一個整點家務 tick（${new Date(after).toISOString()}）`)

  s.cfg.reflectionAt = null
  s.cfg.reflectionEveryHours = 6
  s.runtime.lastReflectionAt = '2026-11-26T02:00:00+08:00'
  const interval = duty.nextWakeAt(Date.parse('2026-11-26T07:30:00+08:00'))
  ok(interval === Date.parse('2026-11-26T08:00:00+08:00'), `間隔模式：02:00 + 6h → 08:00（${new Date(interval).toISOString()}）`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
