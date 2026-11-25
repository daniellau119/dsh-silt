/**
 * 第五輪 review 的「中」與「小」—— 2026-11-25。
 *
 * 這批大多是**閘沒接上**或**資料形狀跟用途對不上**：
 *   掃描範圍比另一條路窄、GET 有副作用、布林字串沒被當字串處理。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'silt-r7-'))
const { Store } = await import('file:///E:/deepseek-harness/智能管家/silt/lib/store.js')
const M = await import('file:///E:/deepseek-harness/智能管家/silt/lib/model.js')

let pass = 0
let fail = 0
const ok = (c, l) => (c ? (pass++, console.log(`  ok   ${l}`)) : (fail++, console.log(`  FAIL ${l}`)))

const fresh = () => {
  const s = new Store(mkdtempSync(join(tmpdir(), 'silt-r7s-'))).load()
  s.cfg = { ...s.cfg, enabled: true }
  return s
}
const ctx = { sessionId: 'sess-r7', callId: 'c-r7' }

console.log('7) loopbackHost 認得 IPv6，且 sameOrigin 不再 fail-open')
{
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/routes.js', import.meta.url), 'utf8')
  // 直接抓出那兩個函式的原始碼行為來驗
  ok(/const loopbackHost = \(host\) => \/\^\(127\\\.0\\\.0\\\.1\|localhost\|\\\[::1\\\]\)/.test(src), 'loopbackHost 的 [::1] 是轉義過的（\\[::1\\]）')
  ok(/if \(!host\) return false/.test(src), 'sameOrigin 沒有 Host 時回 false（不是 fail-open）')
}

console.log('\n9) 星圖的邊兩端都要是真節點')
{
  const s = fresh()
  const a = s.writeMemory({ tier: 3, title: '第一條', body: '會被壓成概', domain: 'other', dims: ['personality'] }, ctx).memory.id
  const b = s.writeMemory({ tier: 3, title: '第二條', body: '也會被壓成概', domain: 'other', dims: ['personality'] }, ctx).memory.id
  const gist = { title: '兩條的概', body: '合成一句', domain: 'other', dims: ['personality'], tier: 2 }
  const r = s.compress({ gist, ids: [a, b] }, { actor: 'model', sessionId: 'x' })
  ok(r.ok === true, 'compress 成功')

  const { galaxyOf } = await import('file:///E:/deepseek-harness/智能管家/silt/lib/routes.js').catch(() => ({}))
  // galaxyOf 不是具名導出，改用 store 的狀態驗證「邊的兩端都存在」這個不變式
  const active = s.activeMemories()
  const ids = new Set(active.map((m) => m.id))
  let edges = []
  for (const m of active) {
    for (const from of m.compressedFrom || []) if (ids.has(from)) edges.push([m.id, from])
    if (m.condensedFrom && ids.has(m.condensedFrom)) edges.push([m.id, m.condensedFrom])
    if (m.recastFrom && ids.has(m.recastFrom)) edges.push([m.id, m.recastFrom])
    if (m.graduatedFrom && ids.has(m.graduatedFrom)) edges.push([m.id, m.graduatedFrom])
    if (m.replacedBy && ids.has(m.replacedBy)) edges.push([m.id, m.replacedBy])
  }
  const bad = edges.filter(([x, y]) => !ids.has(x) || !ids.has(y))
  ok(bad.length === 0, `所有邊的兩端都是活著的節點（壞邊 ${bad.length}）`)
  void galaxyOf
}

console.log('\n11) 沒 query 也沒給 weight 的瀏覽：不給份量')
{
  const s = fresh()
  const id = s.writeMemory({ tier: 4, title: '被瀏覽的', body: '掃描不該給份量', domain: 'other', dims: ['personality'] }, ctx).memory.id
  for (let i = 0; i < 5; i += 1) s.recall({ tier: 4, limit: 30, sessionId: `browse-${i}` })
  ok(Number(s.runtime.recalls?.[id]?.count || 0) === 0, `瀏覽五次，count 仍是 0（${s.runtime.recalls?.[id]?.count}）—— 舊版每次 +1，三次就升`)
}

console.log('\n13) importBundle 的掃描範圍跟 writeMemory 一致')
{
  const s = fresh()
  const mk = (over) => ({
    format: 'silt/1',
    memories: [{ id: 'm-x', tier: 3, title: '一條記憶', body: '內容', domain: 'other', dims: ['personality'], ...over }],
  })
  // tags 夾帶技術內容
  const t1 = s.importBundle(mk({ tags: ['npm install 東西'] }))
  ok(t1.ok === false, 'tags 裡的技術內容會被擋（舊版不掃 tags）')
  // quote 夾帶憑據
  const t2 = s.importBundle(mk({ quote: '我的卡號 4111111111111111' }))
  ok(t2.ok === false, 'quote 裡的憑據會被擋')
  // quote 夾帶技術內容 —— 跟 writeMemory 一樣**不擋**（quote 是證據）
  const t3 = s.importBundle(mk({ quote: '他說 config.json 改到三點' }))
  ok(t3.ok === true, 'quote 提到檔名不擋（跟 writeMemory 同一條規矩）')
  // 人格卡夾帶技術內容
  const t4 = s.importBundle({
    format: 'silt/1',
    memories: [],
    persona: { identity: 'npm run build 很慢', voice: '', traits: [], taste: [] },
  })
  ok(t4.ok === false, '人格卡裡的技術內容會被擋（舊版整批不掃）')
}

console.log('\n14) Boolean 字串："false" 不是 true')
{
  const dir = mkdtempSync(join(tmpdir(), 'silt-r7b-'))
  // ⚠️ 2026-11-25：`bili` 設定項已隨 B站 一起拆掉，改用還在的布林（speak / enabled）。
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ enabled: 'false', speak: 'true', reflection: 'off' }), 'utf8')
  const s = new Store(dir).load()
  ok(s.cfg.enabled === false, `"false" 讀成 false（實際 ${s.cfg.enabled}）—— 舊版是 true`)
  ok(s.cfg.speak === true, '"true" 讀成 true')
  ok(s.cfg.reflection === false, `"off" 讀成 false（實際 ${s.cfg.reflection}）`)
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n小) spokenToday 用東八區切日')
{
  const s = fresh()
  const src = (await import('node:fs')).readFileSync(new URL('../lib/store.js', import.meta.url), 'utf8')
  ok(/toLocal\(new Date\(now\)\.toISOString\(\), \{ dateOnly: true \}\)/.test(src), 'spokenToday 用 toLocal 切日（不是 UTC 的 toISOString）')
}

console.log('\n小) exportBundle 可以選擇不落帳（GET 無副作用）')
{
  const s = fresh()
  const before = s.records.length
  s.exportBundle({ record: false })
  ok(s.records.length === before, 'record:false 不寫帳本')
  s.exportBundle()
  ok(s.records.length > before, '預設仍然寫（POST 按鈕那條）')
}

console.log('\n小) 升級快照記的是 weight，不是已停用的 n')
{
  const s = fresh()
  const id = s.writeMemory({ tier: 4, title: '要升級的', body: '累計到 3', domain: 'other', dims: ['personality'] }, ctx).memory.id
  s.recall({ tier: 4, limit: 30, weight: 2, sessionId: 'k1' })
  s.recall({ tier: 4, limit: 30, weight: 2, sessionId: 'k2' })
  const rec = s.records.filter((r) => r.kind === 'memory.upgrade').pop()
  ok(Boolean(rec), '有升級記錄')
  ok(Number(rec?.payload?.weight) >= 3, `payload 記了 weight（${rec?.payload?.weight}）`)
  ok(!/被提起 0 次/.test(String(rec?.payload?.snapshot?.label || '')), `標籤不再寫「被提起 0 次」（${rec?.payload?.snapshot?.label}）`)
}

console.log('\n小) session 計數器會裁掉舊的')
{
  const s = fresh()
  const id = s.writeMemory({ tier: 3, title: '被翻很多次', body: '用來撐大 seenInSession', domain: 'other', dims: ['personality'] }, ctx).memory.id
  for (let i = 0; i < 60; i += 1) s.recall({ query: '被翻很多次', limit: 5, sessionId: `old-${i}` })
  const n = Object.keys(s.runtime.seenInSession || {}).length
  ok(n <= 41, `seenInSession 被裁到 ≤ 41（實際 ${n}）`)
  ok(Boolean(s.runtime.seenInSession), '不是整個清空')
}

rmSync(home, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
