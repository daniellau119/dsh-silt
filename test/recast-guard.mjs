/**
 * recast 的围栏 —— 2026-11-25 本人指出的漏洞。
 *
 * recast（重述）原本可以无限次做：每次都写 1000 字、永远留在 T3、永不沉 T2，
 * 等於繞過整條「插件決定壓到多短、模型決定留甚麼」的壓縮階梯。
 *
 * 三道圍欄（測試逐條釘住）：
 *   ① 只作用於 T3
 *   ② 同一條最多 3 次（recastCount 跨版本累加）
 *   ③ 不重置壓縮時鐘（lastCondensedAt 沿用原條）
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'silt-recast-guard-'))
const { Store } = await import('file:///E:/deepseek-harness/智能管家/silt/lib/store.js')

let pass = 0
let fail = 0
const ok = (c, l) => (c ? (pass++, console.log(`  ok   ${l}`)) : (fail++, console.log(`  FAIL ${l}`)))

const fresh = () => {
  const s = new Store(mkdtempSync(join(tmpdir(), 'silt-rg-'))).load()
  s.cfg = { ...s.cfg, enabled: true }
  return s
}
const ctx = { sessionId: 'sess-r', callId: 'c-r' }

console.log('1) 圍欄 ①：recast 只作用於 T3')
{
  const s = fresh()
  const t1 = s.writeMemory({ tier: 1, title: '事實', body: '他上晚班白天睡覺', domain: 'person', dims: ['background'] }, ctx).memory.id
  const r1 = s.condense({ id: t1, title: '事實重述', body: '他白天睡覺是因為上晚班', mode: 'recast' }, ctx)
  ok(r1.ok === false, 'T1 不准 recast')

  const t5 = s.writeMemory({ tier: 5, title: '預測', body: '他要換機器', domain: 'world', dims: ['background'], expiresAt: '2027' }, ctx).memory.id
  const r5 = s.condense({ id: t5, title: '預測重述', body: '他大概要換機器了', mode: 'recast' }, ctx)
  ok(r5.ok === false, 'T5 不准 recast')

  const t3 = s.writeMemory({ tier: 3, title: '經歷', body: '那天他說了很多話，我們聊到很晚才結束'.repeat(3), domain: 'feeling', dims: ['personality'] }, ctx).memory.id
  const r3 = s.condense({ id: t3, title: '經歷重述', body: '那天他其實是在試探我會不會走', mode: 'recast' }, ctx)
  ok(r3.ok === true, 'T3 可以 recast')
}

console.log('\n2) 圍欄 ②：同一條最多 3 次')
{
  const s = fresh()
  let id = s.writeMemory(
    { tier: 3, title: '會被一直重述的那條', body: '這件事我一直在改看法，每次都想得不一樣'.repeat(3), domain: 'feeling', dims: ['personality'] },
    ctx,
  ).memory.id

  const results = []
  for (let i = 1; i <= 4; i += 1) {
    const r = s.condense({ id, title: `第 ${i} 次重述`, body: `這是第 ${i} 次的理解，跟之前那次完全不一樣`, mode: 'recast' }, ctx)
    results.push(r)
    if (r.ok) id = r.memory.id
  }
  ok(results[0].ok === true, '第 1 次 recast 成功')
  ok(results[1].ok === true, '第 2 次 recast 成功')
  ok(results[2].ok === true, '第 3 次 recast 成功')
  ok(results[3].ok === false, '第 4 次被退回（上限 3）')
  ok(String(results[3].error || '').includes('重述'), '退回原因說得出是重述次數')
  // recastCount 要跨版本累加，不能每次歸 1
  ok(results[2].memory.recastCount === 3, `recastCount 跨版本累加到 3（實際 ${results[2].memory.recastCount}）`)
}

console.log('\n3) 圍欄 ③：recast 不重置壓縮時鐘')
{
  const s = fresh()
  const oldDate = new Date(Date.now() - 90 * 86400000).toISOString()
  const id = s.writeMemory(
    { tier: 3, title: '很久以前的事', body: '這件事已經九十天沒壓過了，早該收短'.repeat(3), domain: 'feeling', dims: ['personality'] },
    ctx,
  ).memory.id
  // 模擬「九十天沒壓過」
  s.memories.set(id, { ...s.memories.get(id), bornAt: oldDate, lastCondensedAt: oldDate })

  const before = s.memories.get(id)
  const r = s.condense({ id, title: '換個看法', body: '換個角度講同一件事，長度跟原本差不多', mode: 'recast' }, ctx)
  ok(r.ok === true, 'recast 本身成功')
  ok(r.memory.lastCondensedAt === oldDate, 'lastCondensedAt 沒有被更新成「現在」（這是關鍵）')
  ok(r.memory.condenseCount === (before.condenseCount || 0), 'recast 不增加 condenseCount（它沒把東西收短）')
}

console.log('\n4) 正常 condense 仍然重置時鐘（對照組）')
{
  const s = fresh()
  const id = s.writeMemory({ tier: 3, title: '正常壓縮', body: '這條會被正常壓短'.repeat(20), domain: 'feeling', dims: ['personality'] }, ctx).memory.id
  // 2026-11-27：沉 T2 要「夠短而且夠老」，所以先把時鐘撥到 30 天前 ——
  // 不然「lastCondensedAt 有更新」會被「寫入與壓縮落在同一毫秒」搞成假失敗。
  const oldDate = new Date(Date.now() - 30 * 86400000).toISOString()
  s.memories.set(id, { ...s.memories.get(id), bornAt: oldDate, lastCondensedAt: oldDate })
  const before = s.memories.get(id)
  const r = s.condense({ id, title: '壓短後', body: '壓短了', targetLen: 20 }, ctx)
  ok(r.ok === true, 'condense 成功')
  ok(r.memory?.lastCondensedAt !== (before.lastCondensedAt || before.bornAt) || r.tier === 2, 'condense 會更新壓縮時間（或已沉 T2）')
}

console.log('\n5) recast 不能無限撐住長度（組合驗證）')
{
  // 極端情況：每 7 天 recast 一次，每次都寫滿 1000 字。
  // 時間在跑，但 lastCondensedAt 不動 ⇒ condensePlan 照樣會把它列進壓縮清單。
  const s = fresh()
  const oldDate = new Date(Date.now() - 30 * 86400000).toISOString()
  let id = s.writeMemory({ tier: 3, title: '被 recast 續命', body: '這條本來該被壓了'.repeat(50), domain: 'feeling', dims: ['personality'] }, ctx).memory.id
  s.memories.set(id, { ...s.memories.get(id), bornAt: oldDate, lastCondensedAt: oldDate })
  const r = s.condense({ id, title: '重述一次', body: '重述之後還是很長'.repeat(40), mode: 'recast' }, ctx)
  ok(r.ok === true, 'recast 成功')
  const sinceDays = (Date.now() - Date.parse(r.memory.lastCondensedAt)) / 86400000
  ok(sinceDays > 7, `壓縮週期仍算作已過 ${Math.round(sinceDays)} 天 ⇒ 下一輪會被列入壓縮清單`)
}

rmSync(home, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
