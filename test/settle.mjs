/**
 * test/settle.mjs — T2 的條件：≤200 字 **而且夠老**
 *
 * 2026-11-27 本人定：沉成 T2 不再只看長度。年齡門檻 = 最長一條 T3 走到 200 字的時間
 * （(1000/200)^2 − 1）/ 0.14 ≈ 171 天，再乘 1.2^R。
 *
 * 為什麼：T2 是 720 天半衰期的終態。舊版只要 ≤200 就沉 —— 一條 10 天大的 T3 只要
 * 模型寫短一點，就當場變成「沉澱下來的概」，跟 README 自己寫的「約 175 天落 T2」相反。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/store.js'
import { makeDuty } from '../lib/duty.js'
import { buildTools } from '../lib/tools.js'
import { settleAgeDays } from '../lib/model.js'

let pass = 0
let fail = 0
const ok = (c, l) => {
  if (c) pass += 1
  else {
    fail += 1
    console.log(`  x ${l}`)
  }
}
const eq = (a, b, l) => ok(a === b, `${l} → got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`)
const section = (t) => console.log(`\n${t}`)

const dirs = []
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'silt-settle-'))
  dirs.push(dir)
  const s = new Store(dir).load()
  s.cfg = { ...s.cfg, enabled: true }
  return s
}
const ctx = { sessionId: 'sess-settle', callId: 'c-settle' }
const day = (n) => new Date(Date.now() - n * 86400000).toISOString()
const mk = (s, title, body, bornDays) => {
  const id = s.writeMemory({ tier: 3, title, body, domain: 'work', dims: ['work'], importance: 0.6 }, ctx).memory.id
  s.memories.set(id, { ...s.memories.get(id), bornAt: day(bornDays), firstSeen: day(bornDays).slice(0, 10), lastCondensedAt: day(bornDays) })
  return id
}

try {
  section('1 · 150 字 / 30 天 → 短但不老，留在 T3')
  {
    const s = fresh()
    const id = mk(s, '短條', '字'.repeat(148), 30)
    const r = s.condense({ id, title: '短條', body: '字'.repeat(148), targetLen: 150 }, ctx)
    ok(r.ok, `condense 成功（${r.error || ''}）`)
    eq(r.tier, 3, '留在 T3')
    eq(r.settled, false, '回報 settled: false')
    ok(String(r.settleNote).includes('171'), `說得出還差多久（${r.settleNote}）`)
  }

  section('2 · 400 天 / R=3 → 定稿 T2，而且 R 跟著走')
  {
    const s = fresh()
    const id = mk(s, '短條', '字'.repeat(148), 400)
    s.bumpRecall([id])
    s.bumpRecall([id])
    s.bumpRecall([id])
    const r = s.condense({ id, title: '短條', body: '字'.repeat(148), targetLen: 150 }, ctx)
    ok(r.ok, 'condense 成功')
    eq(r.tier, 2, '沉成 T2（R=3 的門檻 296 天 < 400）')
    eq(s.runtime.recalls[r.memory.id]?.n, 3, 'T2 繼承來源的 R=3')
  }

  section('3 · 600 字 / 200 天：寫 500 字還是不沉，寫 190 字才沉')
  {
    const s = fresh()
    const a = mk(s, '六百甲', '內容'.repeat(300), 200)
    const r1 = s.condense({ id: a, title: '五百', body: '內容'.repeat(250), targetLen: 500 }, ctx)
    eq(r1.tier, 3, '500 字 > 200 → 留在 T3')

    const b = mk(s, '六百乙', '內容'.repeat(300), 200)
    const r2 = s.condense({ id: b, title: '短概', body: '內容'.repeat(94), targetLen: 190 }, ctx)
    eq(r2.tier, 2, '190 字 ≤ 200 且夠老 → T2')
  }

  section('4 · 200 天、R=5 → 門檻 427 天，150 字還是不沉')
  {
    const s = fresh()
    const id = mk(s, '短條', '字'.repeat(148), 200)
    for (let i = 0; i < 5; i += 1) s.bumpRecall([id])
    const r = s.condense({ id, title: '短條', body: '字'.repeat(148), targetLen: 150 }, ctx)
    eq(r.tier, 3, 'R=5 讓門檻變 427 天，200 天還不夠')
    eq(Math.round(settleAgeDays(s.memories.get(id), s.runtime)), 427, 'settleAgeDays = 171 × 1.2^5')
    ok(String(r.settleNote).includes('427'), `回報 427 天（${r.settleNote}）`)
  }

  section('5 · recast 寫 150 字 → 永遠 T3')
  {
    const s = fresh()
    const id = mk(s, '短條', '字'.repeat(148), 200)
    const r = s.condense({ id, title: '換個看法', body: '字'.repeat(148), mode: 'recast', targetLen: 1 }, ctx)
    ok(r.ok, 'recast 成功')
    eq(r.tier, 3, '重述不沉')
    eq(r.settled, undefined, '沒有 settle 回報（它本來就不參與）')
  }

  section('6 · condensePlan：老的短條要進清單，年輕又只差幾字的不列')
  {
    const s = fresh()
    const oldId = mk(s, '舊短條', '字'.repeat(148), 200)
    const youngId = mk(s, '新短條', '字'.repeat(120), 30)
    const duty = makeDuty({ ctx: {}, store: s })
    const plan = duty.condensePlan()
    const item = plan.find((x) => x.id === oldId)
    ok(Boolean(item), '老的短條出現在清單裡')
    eq(item?.settleReady, true, '標了 settleReady')
    eq(item?.targetLen, 151, 'targetLen 就是它現在的長度（寫進 200 內即可）')
    ok(!plan.some((x) => x.id === youngId), '年輕、只差 2 字 → 不列（不值得白改一次）')
  }

  section('7 · 工具回傳：settleNote 與 overTargetBy 都要交到模型手上')
  {
    const s = fresh()
    const id = mk(s, '短條', '字'.repeat(148), 30)
    const tools = Object.fromEntries(buildTools(s).map((t) => [t.name, t]))
    const exec = { agent: { id: 'sess-settle' }, callId: 'c1' }

    const r = tools.silt_condense.execute({ id, title: '短條', body: '字'.repeat(148), targetLen: 150 }, exec)
    eq(r.tier, 3, '工具回傳 tier 3')
    eq(r.settled, false, '工具回傳 settled: false')
    ok(String(r.settleNote).includes('171'), `工具回傳 settleNote（${r.settleNote}）`)

    const id2 = mk(s, '長條', '字'.repeat(148), 30)
    const r2 = tools.silt_condense.execute({ id: id2, title: '長條', body: '字'.repeat(148), targetLen: 100 }, exec)
    ok(Number(r2.overTargetBy) >= 49, `工具回傳 overTargetBy（${r2.overTargetBy}）`)
  }
} finally {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* 收尾失敗不影響結果 */
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)