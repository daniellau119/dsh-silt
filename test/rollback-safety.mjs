/**
 * 第五輪 review 的致命 / 高優先修復 —— 2026-11-25。
 *
 * 這批的共同點：**一個資料結構被另一個用途拿去用，而形狀對不上**。
 *   · snapshot 的 before 有兩種形狀（記憶 vs 旋鈕數字），rollback 卻只有一套處理
 *   · 設定走 config.json 不落帳，於是「誰訂的」這條鏈斷了
 *   · dedup 的一本帳同時管兩件不同的事（被翻到 vs 給了多重）
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'silt-r6-'))
const { Store } = await import('file:///E:/deepseek-harness/智能管家/silt/lib/store.js')

let pass = 0
let fail = 0
const ok = (c, l) => (c ? (pass++, console.log(`  ok   ${l}`)) : (fail++, console.log(`  FAIL ${l}`)))

const fresh = () => {
  const s = new Store(mkdtempSync(join(tmpdir(), 'silt-r6s-'))).load()
  s.cfg = { ...s.cfg, enabled: true }
  return s
}
const ctx = { sessionId: 'sess-r6', callId: 'c-r6' }
const seed = (s, n = 3) => {
  const ids = []
  for (let i = 0; i < n; i += 1) {
    ids.push(s.writeMemory({ tier: 3, title: `第 ${i} 條`, body: `內容 ${i}`, domain: 'other', dims: ['personality'] }, ctx).memory.id)
  }
  return ids
}

console.log('致命 1) 回滾「調注入量」不准清空記憶')
{
  const s = fresh()
  seed(s, 3)
  const before = s.memories.size
  const r = s.tuneInjection({ injectBudget: 2200 }, { reason: 'test', actor: 'model' })
  ok(r.ok === true, 'tune 成功')
  const rb = s.rollback(r.snapshotId)
  ok(rb.ok === true, `回滾成功（${rb.scope}）`)
  ok(s.memories.size === before, `記憶還在：${s.memories.size} / ${before}（舊版會被清空）`)
  ok(rb.scope === 'inject', `scope 是 inject（實際 ${rb.scope}）`)
}

console.log('\n致命 1b) 回滾「調節律」也一樣')
{
  const s = fresh()
  seed(s, 2)
  const before = s.memories.size
  // ⚠️ 2026-11-25：`biliEveryHours` 已隨 B站 拆掉，改用還在的節律旋鈕。
  const r = s.tuneRhythm({ reflectionEveryHours: 30 }, { reason: 'test', actor: 'model' })
  const rb = s.rollback(r.snapshotId)
  ok(rb.ok === true, '回滾成功')
  ok(s.memories.size === before, `記憶還在（${s.memories.size} / ${before}）`)
}

console.log('\n致命 1c) 護欄：replaceAll 不帶 memories 就沒有清空的權力')
{
  const s = fresh()
  seed(s, 2)
  const before = s.memories.size
  // 直接偽造一筆壞的 rollback 記錄，看 apply 會不會清空
  s.append('rollback', 'user', { restore: { replaceAll: { injectCount: 12 } }, scope: 'store' })
  ok(s.memories.size === before, `壞的 replaceAll 沒有清空記憶（${s.memories.size} / ${before}）`)
}

console.log('\n高 2) saveConfig 要落帳，setBy 才看得見本人')
{
  const s = fresh()
  const before = s.records.length
  s.saveConfig({ injectBudget: 3200 })
  ok(s.records.length > before, 'saveConfig 寫了一筆帳本記錄')
  const last = s.records[s.records.length - 1]
  ok(last.kind === 'config.profile', `記錄類型是 config.profile（實際 ${last.kind}）`)
  ok(last.actor === 'user', `actor 是 user（實際 ${last.actor}）`)
  const prov = s.knobProvenance(['injectBudget'])
  ok(prov.injectBudget.setBy === 'user', `setBy 認到 user（實際 ${prov.injectBudget.setBy}）`)
}

console.log('\n高 2b) 重啟之後設定不會被舊帳本蓋掉')
{
  const dir = mkdtempSync(join(tmpdir(), 'silt-r6cfg-'))
  const s1 = new Store(dir).load()
  s1.cfg = { ...s1.cfg, enabled: true }
  // 先由模型調到 2200，再由本人在頁面改成 3200
  s1.tuneInjection({ injectBudget: 2200 }, { reason: 'model', actor: 'model' })
  s1.saveConfig({ injectBudget: 3200 })
  // 重啟
  const s2 = new Store(dir).load()
  ok(s2.cfg.injectBudget === 3200, `重啟後仍是本人訂的 3200（實際 ${s2.cfg.injectBudget}）`)
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n高 3) 掃描之後再認真翻，weight 要算得到')
{
  const s = fresh()
  const id = s.writeMemory({ tier: 4, title: '先掃再翻', body: '反思第 3 節的流程', domain: 'other', dims: ['personality'] }, ctx).memory.id
  // 反思第 3 節：同一個會話，先 weight:0 掃，再 deliberate + weight:2 翻
  s.recall({ tier: 4, limit: 30, weight: 0, sessionId: 'reflect-1' })
  ok(Number(s.runtime.recalls?.[id]?.count || 0) === 0, '掃描不給份量')
  s.recall({ tier: 4, limit: 30, weight: 2, deliberate: true, sessionId: 'reflect-1' })
  ok(Number(s.runtime.recalls?.[id]?.count || 0) === 2, `翻一次 weight 2 算得到（${s.runtime.recalls?.[id]?.count}）—— 舊版被 dedup 吃掉`)

  // 同一會話反覆給，封頂 WEIGHT.max
  for (let i = 0; i < 5; i += 1) s.recall({ tier: 4, limit: 30, weight: 2, deliberate: true, sessionId: 'reflect-1' })
  ok(Number(s.runtime.recalls?.[id]?.count || 0) <= 2, `同會話封頂（${s.runtime.recalls?.[id]?.count}）`)
}

console.log('\n高 3b) n 仍然只算一次（dedup 沒被一起拆掉）')
{
  const s = fresh()
  const id = s.writeMemory({ tier: 3, title: 'T3 去重', body: '這條確認 n 只算一次', domain: 'other', dims: ['personality'] }, ctx).memory.id
  for (let i = 0; i < 5; i += 1) s.recall({ query: 'T3 去重', limit: 5, sessionId: 'same' })
  ok(Number(s.runtime.recalls?.[id]?.n || 0) === 1, `同會話只算一次 n（${s.runtime.recalls?.[id]?.n}）`)
}

console.log('\n高 4) recastCount 不會被正常壓縮洗掉')
{
  const s = fresh()
  let id = s.writeMemory({ tier: 3, title: '會被重述又壓縮的', body: '這件事我改過看法'.repeat(10), domain: 'feeling', dims: ['personality'] }, ctx).memory.id
  const r1 = s.condense({ id, title: '重述一', body: '第一次換角度', mode: 'recast' }, ctx)
  id = r1.memory.id
  const r2 = s.condense({ id, title: '重述二', body: '第二次換角度', mode: 'recast' }, ctx)
  id = r2.memory.id
  ok(r2.memory.recastCount === 2, `recast 兩次，count = 2（${r2.memory.recastCount}）`)
  // 中間插一次正常壓縮 —— 舊版這裡會把 recastCount 洗掉
  const c = s.condense({ id, title: '壓縮一下', body: '正常的壓縮，不是重述', targetLen: 20 }, ctx)
  ok(c.ok === true, '正常壓縮成功')
  const after = s.memories.get(c.memory.id) || c.memory
  ok(Number(after.recastCount || 0) === 2, `壓縮後 recastCount 仍然是 2（${after.recastCount}）—— 舊版會消失，上限可繞`)
}

console.log('\n高 5) compress 的 bornAt 沿用原條（不是沉澱那一刻）')
{
  const s = fresh()
  const id = s.writeMemory({ tier: 3, title: '兩百天前的事', body: '這件事兩百天了'.repeat(20), domain: 'feeling', dims: ['personality'] }, ctx).memory.id
  const old = new Date(Date.now() - 200 * 86400000).toISOString()
  s.memories.set(id, { ...s.memories.get(id), bornAt: old, firstSeen: old })
  const r = s.compress({ gist: { title: '一句概', body: '一句話講完', domain: 'feeling', dims: ['personality'], tier: 2 }, ids: [id] }, { actor: 'model', sessionId: 'x' })
  ok(r.ok === true, 'compress 成功')
  const g = s.memories.get(r.memory.id)
  ok(String(g.bornAt).startsWith(old.slice(0, 10)), `bornAt 沿用原條（${g.bornAt?.slice(0, 10)}）—— 不然三年前的事會突然變最亮`)
}

console.log('\n高 6) injectionParams 是唯一來源（夾值一致）')
{
  const s = fresh()
  s.cfg = { ...s.cfg, injectBudget: 5000 }
  const p = s.injectionParams()
  ok(p.budget <= 3200, `預算被夾到上限（${p.budget}）`)
  s.cfg = { ...s.cfg, injectBudget: 300 }
  const p2 = s.injectionParams()
  ok(p2.budget >= 600, `預算被夾到下限（${p2.budget}）`)
}

console.log('\n中 10) saveConfig 不再靜默丟掉 reflectionAt')
{
  const s = fresh()
  s.saveConfig({ reflectionAt: ['19:00', '07:00'] })
  ok(Array.isArray(s.cfg.reflectionAt) && s.cfg.reflectionAt.length === 2, `reflectionAt 生效了（${JSON.stringify(s.cfg.reflectionAt)}）`)
  s.saveConfig({ reflectionAt: null })
  ok(s.cfg.reflectionAt === null || (Array.isArray(s.cfg.reflectionAt) && s.cfg.reflectionAt.length === 0), 'null 可以取消')
}

console.log('\n中 8) condense 回滾要把新條也拿掉')
{
  const s = fresh()
  const id = s.writeMemory({ tier: 3, title: '會被壓縮的', body: '這條要被壓縮'.repeat(30), domain: 'feeling', dims: ['personality'] }, ctx).memory.id
  const r = s.condense({ id, title: '壓短後', body: '壓短了', targetLen: 10 }, ctx)
  ok(r.ok === true, 'condense 成功')
  const newId = r.memory.id
  const snap = s.snapshots.get(r.snapshotId)
  ok(snap?.after?.gistId === newId, `快照記了新條 id（${snap?.after?.gistId}）`)

  const before = s.memories.size
  const rb = s.rollback(r.snapshotId)
  ok(rb.ok === true, '回滾成功')
  ok(!s.memories.has(newId) || s.memories.get(newId)?.archived, `回滾後新條不再活著（${newId}）`)
  ok(s.memories.size < before, `條數變少（${s.memories.size} < ${before} = 新條被拿走）`)
  ok(s.activeMemories().some((m) => m.id === id), '原條回到 activeMemories')
}

console.log('\n中 11) compress 回滾：原條要真的回到 active，不能只是「不在了」')
{
  const s = fresh()
  const id = s.writeMemory({ tier: 3, title: '會被吸走的', body: '這條要被吸走'.repeat(40), domain: 'feeling', dims: ['personality'] }, ctx).memory.id
  const r = s.compress({ gist: { tier: 2, title: '一句概', body: '一句話講完', domain: 'feeling', dims: ['personality'] }, ids: [id] }, ctx)
  ok(r.ok === true, 'compress 成功')
  ok(s.memories.get(id)?.archived === true, '壓縮後原條歸檔')

  const rb = s.rollback(r.snapshotId)
  ok(rb.ok === true, `回滾成功（${rb.scope}）`)
  ok(!s.memories.has(r.memory.id), '生出來的概被拿走')
  const back = s.memories.get(id)
  ok(back && !back.archived, `原條不再是 archived（實際 ${back?.archived}）`)
  ok(!back?.supersededBy && !back?.archivedAt, 'supersededBy / archivedAt 清掉了')
  ok(s.activeMemories().some((m) => m.id === id), '原條回到 activeMemories（會再進提示詞）')
}

console.log('\n中 11b) condense 沉 T2 的回滾也走 compress 這條路')
{
  const s = fresh()
  const id = s.writeMemory({ tier: 3, title: '會沉下去的', body: '內容很長'.repeat(60), domain: 'feeling', dims: ['personality'] }, ctx).memory.id
  // 2026-11-27：沉 T2 要「夠短而且夠老」，先把它變老才走得到 compress 那條路
  const old = new Date(Date.now() - 200 * 86400000).toISOString()
  s.memories.set(id, { ...s.memories.get(id), bornAt: old, firstSeen: old.slice(0, 10), lastCondensedAt: old })
  const c = s.condense({ id, title: '壓到很短', body: '很短', targetLen: 10 }, ctx)
  ok(c.ok === true, 'condense 成功')
  ok(c.tier === 2, `沉成 T2（${c.tier}）`)

  const rb = s.rollback(c.snapshotId)
  ok(rb.ok === true, `回滾成功（${rb.scope}）`)
  ok(!s.memories.has(c.memory.id), '沉出來的概被拿走')
  ok(s.memories.get(id)?.archived !== true, '原條不再是 archived')
  ok(s.activeMemories().some((m) => m.id === id), '原條回到 activeMemories')
}

rmSync(home, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
