/**
 * 2026-11-26 這輪修復的回歸測試。
 *
 * 每一條都對應一個「測試套件原本沒覆蓋、但實際會咬人」的洞：
 *   · importLedger 洗白被改過的帳
 *   · importBundle 不驗結構 / evidence 原話不掃
 *   · readBody 跨 chunk 切壞中文
 *   · 值守目標歸檔後不退回 new_once / 已排隊又被排第二個
 *   · 掃描吃掉後面的想起 / 同會話 weight 封頂後 n 被吞
 *   · dutiesToday 用 UTC 切日
 *   · load 不夾數值旋鈕
 *   · /state 送快照全文、看不到作廢的
 *   · 注入分層的 truncated / persona 重複計算
 *   · 空 patch 也落帳
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

const { Store } = await import('../lib/store.js')
const M = await import('../lib/model.js')
const { makeDuty } = await import('../lib/duty.js')
const { makeRoutes } = await import('../lib/routes.js')
const { injectionBreakdown } = await import('../lib/injection-breakdown.js')

let pass = 0
let fail = 0
const ok = (c, l) => (c ? (pass++, console.log(`  ok   ${l}`)) : (fail++, console.log(`  FAIL ${l}`)))
const mkHome = () => mkdtempSync(join(tmpdir(), 'silt-r4-'))
const fresh = (seed = {}) => {
  const s = new Store(mkHome(), seed).load()
  s.cfg = { ...s.cfg, enabled: true, valleyOnly: false }
  return s
}
const ctxOf = { sessionId: 's-r4', callId: 'c-r4' }

console.log('1) importLedger：hash 對不上就拒絕，不是收下重算')
{
  const a = fresh()
  a.writeMemory(
    { tier: 3, title: '原本的標題', body: '原本的正文內容。', domain: 'other', dims: ['personality'] },
    ctxOf,
  )
  const raw = readFileSync(join(a.home, 'ledger.jsonl'), 'utf8')
  const recs = raw.trim().split('\n').map((l) => JSON.parse(l))
  const target = recs.find((r) => r.kind === 'memory.write')
  target.payload.memory.title = '被改過的標題'
  const tampered = recs.map((r) => JSON.stringify(r)).join('\n') + '\n'

  const b = new Store(mkHome()).load()
  const bad = b.importLedger(tampered)
  ok(bad.ok === false, '竄改過的帳本被拒')
  ok(Array.isArray(bad.contentBreaks) && bad.contentBreaks.includes(1), `指出第 1 筆內容被改（${JSON.stringify(bad.contentBreaks)}）`)
  ok(![...b.memories.values()].some((m) => m.title === '被改過的標題'), '被改的內容沒有進倉庫')

  const good = b.importLedger(raw)
  ok(good.ok === true, `原始帳本可以導入（${good.ok ? '' : good.error}）`)
  ok([...b.memories.values()].some((m) => m.title === '原本的標題'), '原始標題讀回來了')

  // 已經用 chain.repair 封存的內容斷點：可以導入，而且 hash 原樣保留
  const d = mkHome()
  writeFileSync(join(d, 'ledger.jsonl'), tampered, 'utf8')
  const sealedStore = new Store(d).load()
  ok(sealedStore.chain.reason === 'content', 'tampered ledger 載入時標成 content 斷點')
  const sealed = sealedStore.sealChain('review4 test')
  ok(sealed.ok === true, '封存成功')
  const sealedRaw = readFileSync(join(d, 'ledger.jsonl'), 'utf8')
  const c = new Store(mkHome()).load()
  const sealedImport = c.importLedger(sealedRaw)
  ok(sealedImport.ok === true, `封存過的帳本可以導入（${sealedImport.ok ? '' : sealedImport.error}）`)
  ok(c.chain.sealed === true, '導入後仍然是「封存過」的狀態')
  ok([...c.memories.values()].some((m) => m.title === '被改過的標題'), '封存的內容原樣保留（沒有被重算洗掉）')
  rmSync(d, { recursive: true, force: true })
  rmSync(c.home, { recursive: true, force: true })
  rmSync(a.home, { recursive: true, force: true })
  rmSync(b.home, { recursive: true, force: true })
}

console.log('\n2) importBundle：驗結構、掃 evidence 裡的原話、合法 export 可還原')
{
  const s = fresh()
  const bad = s.importBundle({
    format: 'silt/1',
    memories: [{
      id: 'm-bad', tier: 99, title: '一條', body: '內容', domain: 'other', dims: ['personality'],
      evidence: [{ kind: 'quote', quote: '我的卡號 4111111111111111' }],
    }],
  })
  ok(bad.ok === false, 'tier:99 的 bundle 被拒')
  ok(Array.isArray(bad.rejected) && bad.rejected.length === 1, '有回報是哪一條被拒')

  const quoted = s.importBundle({
    format: 'silt/1',
    memories: [{
      id: 'm-q', tier: 3, title: '乾淨標題', body: '乾淨正文', domain: 'other', dims: ['personality'],
      evidence: [{ kind: 'quote', quote: '我的卡號 4111111111111111' }],
    }],
  })
  ok(quoted.ok === false, 'evidence[].quote 裡的憑據也被擋（舊版只掃 m.quote，export 的 quote 在 evidence）')

  // 合法 export → import 還原
  const a = fresh()
  const w = a.writeMemory(
    { tier: 3, title: '會被導出的記憶', body: '這段正文要原樣回來。', domain: 'person', dims: ['background'], quote: '他親口說的' },
    ctxOf,
  )
  a.savePersona({ traits: [{ key: '安靜', value: '話少但會聽', weight: 0.6 }] }, { actor: 'model' })
  a.saveSelfView('我現在會先把事情做完再說話。', { actor: 'model' })
  const bundle = a.exportBundle({ record: false })
  const b = new Store(mkHome()).load()
  const res = b.importBundle(bundle)
  ok(res.ok === true, `合法 bundle 導入成功（${res.ok ? '' : res.error}）`)
  const got = [...b.memories.values()].find((m) => m.id === w.memory.id)
  ok(Boolean(got) && got.title === '會被導出的記憶', '記憶原樣還原（id / 標題 / 正文）')
  ok((b.persona.traits || []).some((t) => t.key === '安靜'), '性格卡還原')
  ok(b.selfView.text.includes('先把事情做完'), '自我認知還原')
  rmSync(a.home, { recursive: true, force: true })
  rmSync(b.home, { recursive: true, force: true })
  rmSync(s.home, { recursive: true, force: true })
}

console.log('\n3) readBody：跨 chunk 切在中文字中間，不能壞')
{
  const store = fresh()
  const duty = { info: () => ({}), arm: async () => ({ ok: false }), disarm: async () => {} }
  const handler = makeRoutes({ store, duty, version: 'test', log: () => {}, fence: () => false })
  const req = new EventEmitter()
  req.headers = { host: '127.0.0.1:9', 'content-type': 'application/json' }
  req.method = 'POST'
  req.url = '/api/silt/foundation'
  const res = { statusCode: 0, setHeader() {}, end() {} }
  const text = '中文內容'.repeat(3000)
  const payload = Buffer.from(JSON.stringify({ text }), 'utf8')
  let cut = 9001
  while (cut < payload.length && (payload[cut] & 0xc0) !== 0x80) cut += 1
  setTimeout(() => {
    req.emit('data', payload.subarray(0, cut))
    req.emit('data', payload.subarray(cut))
    req.emit('end')
  }, 0)
  await handler(req, res)
  const line = JSON.parse(readFileSync(join(store.home, 'ledger.jsonl'), 'utf8').trim().split('\n').pop())
  const saved = String(line.payload.after.text || '')
  ok(saved === text, '收到的中文一字不差')
  ok(!saved.includes('\uFFFD'), '沒有 U+FFFD')
  rmSync(store.home, { recursive: true, force: true })
}

console.log('\n4) arm：只投最後一輪會話；不退回新會話')
{
  // (a) 正常：投 homeSession，已排隊時擋第二個
  const s = fresh()
  s.runtime.homeSession = { sessionId: 'session-home', at: Date.now() }
  s.runtime.dutyLog = []
  const targets = []
  const schedule = {
    create: async (request) => {
      targets.push(request.target)
      return { id: `sch-${targets.length}`, target: request.target, status: 'active' }
    },
    edit: async () => ({ deleted: true }),
    view: async () => ({ status: 'active' }),
  }
  const duty = makeDuty({ ctx: { get: () => schedule }, store: s, log: () => {} })
  const first = await duty.arm({ force: true })
  ok(first.ok === true, `有 homeSession 時起得來（${first.ok ? '' : first.error}）`)
  ok(targets[0]?.kind === 'session' && targets[0]?.sessionId === 'session-home', `投到最後一輪會話（${targets[0]?.sessionId}）`)
  const again = await duty.arm({ force: true })
  ok(again.ok === false && again.blockedBy === 'armed', '已經有一輪時再 arm 被擋')
  ok(targets.length === 1, `沒有建第二個排程（create 次數 ${targets.length}）`)
  rmSync(s.home, { recursive: true, force: true })

  // (b) 會話歸檔：失敗，不另開 new_once
  const s2 = fresh()
  s2.runtime.homeSession = { sessionId: 'session-archived', at: Date.now() }
  s2.runtime.dutyLog = []
  const calls2 = []
  const archived = {
    create: async (request) => {
      calls2.push(request.target.kind)
      throw new Error('schedule/target-archived')
    },
    edit: async () => ({ deleted: true }),
    view: async () => ({ status: 'active' }),
  }
  const duty2 = makeDuty({ ctx: { get: () => archived }, store: s2, log: () => {} })
  const fail = await duty2.arm({ force: true })
  ok(fail.ok === false, '歸檔會話時這一輪失敗')
  ok(calls2.join(',') === 'session', `沒有退回 new_once（create 的 target：${calls2.join(',')}）`)
  ok(s2.runtime.armed === null, '沒有留下 armed')
  rmSync(s2.home, { recursive: true, force: true })

  // (c) 完全沒有 homeSession：失敗，不新開
  const s3 = fresh()
  s3.runtime.homeSession = null
  s3.runtime.dutyLog = []
  const calls3 = []
  const duty3 = makeDuty({ ctx: { get: () => ({ create: async (req) => { calls3.push(req); return { id: 'x', target: req.target } } }) }, store: s3, log: () => {} })
  const none = await duty3.arm({ force: true })
  ok(none.ok === false && none.blockedBy === 'no-home', '沒有 homeSession 時直接拒絕')
  ok(calls3.length === 0, '一個排程都沒有建')
  rmSync(s3.home, { recursive: true, force: true })
}

console.log('\n5) dutiesToday：用東八區切日')
{
  const s = fresh()
  s.runtime.dutyLog = [{ at: '2026-11-19T11:00:00.000Z', kinds: ['reflect'] }] // 東八區 11-19 19:00
  const duty = makeDuty({ ctx: { get: () => undefined }, store: s, log: () => {} })
  const at = duty.info(Date.parse('2026-11-20T00:30:00+08:00'))
  ok(at.dutiesToday === 0, `東八區 11-20 00:30 不再算到 11-19 的輪次（${at.dutiesToday}）`)
  s.runtime.dutyLog.push({ at: '2026-11-19T16:05:00.000Z', kinds: ['reflect'] }) // 東八區 11-20 00:05
  const at2 = duty.info(Date.parse('2026-11-20T00:30:00+08:00'))
  ok(at2.dutiesToday === 1, `同一本地日才算（${at2.dutiesToday}）`)
  rmSync(s.home, { recursive: true, force: true })
}

console.log('\n6) load：數值旋鈕夾回硬範圍')
{
  const d = mkHome()
  writeFileSync(join(d, 'config.json'), JSON.stringify({
    reflectionEveryHours: 1, dutyMaxPerDay: 100, injectBudget: 99999, tier4TtlHours: 1000,
  }), 'utf8')
  const s = new Store(d).load()
  ok(s.cfg.reflectionEveryHours === 6, `reflectionEveryHours 夾到 6（${s.cfg.reflectionEveryHours}）`)
  ok(s.cfg.dutyMaxPerDay === 4, `dutyMaxPerDay 夾到 4（${s.cfg.dutyMaxPerDay}）`)
  ok(s.cfg.injectBudget === 3200, `injectBudget 夾到 3200（${s.cfg.injectBudget}）`)
  ok(s.cfg.tier4TtlHours === 168, `tier4TtlHours 夾到 168（${s.cfg.tier4TtlHours}）`)
  rmSync(d, { recursive: true, force: true })

  const d2 = mkHome()
  const s2 = new Store(d2, { tier4TtlDays: 30 }).load()
  ok(s2.cfg.tier4TtlHours === 168, `舊 tier4TtlDays:30 換算後被夾成 168，不是 720（${s2.cfg.tier4TtlHours}）`)
  rmSync(d2, { recursive: true, force: true })
}

console.log('\n7) recall：掃描不替後面的想起佔位；weight 封頂不吞 n')
{
  const s = fresh()
  const id = s.writeMemory(
    { tier: 3, title: '先掃後查的記憶', body: '內容內容內容', domain: 'other', dims: ['personality'] },
    ctxOf,
  ).memory.id
  s.recall({ limit: 10, sessionId: 'same' })            // 瀏覽
  s.recall({ query: '先掃後查', limit: 10, sessionId: 'same' }) // 真正想起
  ok(Number(s.runtime.recalls?.[id]?.n || 0) === 1, `先掃後查：n = 1（${s.runtime.recalls?.[id]?.n}）`)

  // T4：同會話先給 weight 2（沒 query），再帶 query —— weight 已封頂，但 n 要算到
  const t4 = s.writeMemory(
    { tier: 4, title: '權重封頂的碎屑', body: '掃描之後才真的想起', domain: 'other', dims: ['personality'] },
    ctxOf,
  ).memory.id
  s.recall({ tier: 4, limit: 10, weight: 2, sessionId: 'w' })
  s.recall({ query: '權重封頂', limit: 10, sessionId: 'w' })
  const rec4 = s.runtime.recalls?.[t4] || {}
  ok(Number(rec4.count || 0) === 2, `weight 仍封頂在 2（${rec4.count}）`)
  ok(Number(rec4.n || 0) === 1, `n 仍然算到 1（${rec4.n}）—— 舊版會因為 weightBump 為空而完全不加`)

  // countAsRecall:false 只擋 R，不擋明給的 weight
  const t4b = s.writeMemory(
    { tier: 4, title: '不算想起但給份量', body: '份量是另一個判斷', domain: 'other', dims: ['personality'] },
    ctxOf,
  ).memory.id
  s.recall({ query: '不算想起', limit: 10, countAsRecall: false, weight: 2, sessionId: 'q' })
  ok(Number(s.runtime.recalls?.[t4b]?.count || 0) === 2, `countAsRecall:false 時 weight 仍算（${s.runtime.recalls?.[t4b]?.count}）`)
  ok(Number(s.runtime.recalls?.[t4b]?.n || 0) === 0, `但 n 不算（${s.runtime.recalls?.[t4b]?.n}）`)
  rmSync(s.home, { recursive: true, force: true })
}

console.log('\n8) tuneRhythm：固定鐘點的 warning 不能是 NaN')
{
  const s = fresh()
  s.cfg = { ...s.cfg, reflectionAt: ['19:00', '07:00'] }
  const r = s.tuneRhythm({ reflectionEveryHours: 6 }, { reason: 'test', actor: 'model' })
  ok(Boolean(r.ignored?.[0]) && !r.ignored[0].includes('NaN'), `字串鐘點顯示正常：${r.ignored?.[0]}`)
  ok(r.ignored[0].includes('19:00') && r.ignored[0].includes('07:00'), '兩個鐘點都在')
  s.cfg = { ...s.cfg, reflectionAt: [19 * 60, 7 * 60] }
  const r2 = s.tuneRhythm({ reflectionEveryHours: 12 }, { reason: 'test', actor: 'model' })
  ok(!String(r2.ignored?.[0] || '').includes('NaN'), '數字鐘點也不顯示 NaN')
  rmSync(s.home, { recursive: true, force: true })
}

console.log('\n9) state：快照只給元資料；作廢的看得到')
{
  const s = fresh()
  const a = s.writeMemory({ tier: 3, title: '活著的', body: '這條還有效', domain: 'other', dims: ['personality'] }, ctxOf).memory.id
  const b = s.writeMemory({ tier: 3, title: '會被作廢的', body: '這條後來不成立', domain: 'other', dims: ['personality'] }, ctxOf).memory.id
  s.voidMemory(b, { reason: '本人說記錯了' })
  const st = s.state()
  ok(st.memories.some((m) => m.id === b && m.voided), '作廢的記憶出現在 state.memories')
  ok(st.counts.active === 1 && st.counts.voided === 1, `counts 分得開（active ${st.counts.active} / voided ${st.counts.voided}）`)
  ok(st.snapshots.length > 0, '有快照')
  ok(st.snapshots.every((x) => !('before' in x) && !('after' in x)), '快照沒有帶 before/after 全文')
  ok(st.all === undefined, 'state 不再送 all（客戶端沒用到）')
  ok(st.memories.some((m) => m.id === a && !m.voided), '活著的仍然在')
  rmSync(s.home, { recursive: true, force: true })
}

console.log('\n10) 注入分層：truncated 回報 / persona 不重複計')
{
  // 正常情況：persona_title + persona_body 加起來 = 整塊，persona_total 只是 summary
  const s = fresh()
  s.cfg = { ...s.cfg, injectBudget: 1800 }
  s.foundation = { text: '系統命令', setAt: null, by: 'user' }
  s.persona = { version: 2, identity: '我叫汐', voice: '說話短', traits: [{ key: '安靜', value: '話少', weight: 0.5 }], taste: [], revisedAt: null, revision: 1 }
  s.selfView = { text: '現在的我是誰。', at: null, revision: 1 }
  s.writeMemory({ tier: 3, title: '一條記憶', body: '內容', domain: 'other', dims: ['personality'] }, ctxOf)
  const b = injectionBreakdown({ cfg: s.cfg, foundation: s.foundation, persona: s.persona, selfView: s.selfView, memories: s.activeMemories(), budget: 1800 })
  ok(b.parts.some((p) => p.key === 'persona_body'), 'persona_body 是獨立頂層塊')
  ok(b.parts.find((p) => p.key === 'persona_total')?.summary === true, 'persona_total 標成 summary（前端不畫）')
  const top = b.parts.filter((p) => !p.summary && !p.key.endsWith('_line')).reduce((n, p) => n + p.chars, 0)
  ok(Math.abs(top - b.used) <= 2, `頂層塊加總 = 實際字數（${top} vs ${b.used}）`)

  // 硬切：固定開銷大於預算，used 會被切在 cap，truncated 要 true
  const s2 = fresh()
  s2.cfg = { ...s2.cfg, injectBudget: 600 }
  s2.foundation = { text: 'F'.repeat(400), setAt: null, by: 'user' }
  s2.persona = { version: 2, identity: 'I'.repeat(280), voice: '', traits: [], taste: [], revisedAt: null, revision: 1 }
  s2.writeMemory({ tier: 3, title: '一條記憶', body: '內容', domain: 'other', dims: ['personality'] }, ctxOf)
  const b2 = injectionBreakdown({ cfg: s2.cfg, foundation: s2.foundation, persona: s2.persona, selfView: s2.selfView, memories: s2.activeMemories(), budget: 600 })
  ok(b2.used === 600, `真的切到 600（${b2.used}）`)
  ok(b2.truncated === true, 'truncated 有回報（舊版永遠 false）')
  rmSync(s.home, { recursive: true, force: true })
  rmSync(s2.home, { recursive: true, force: true })
}

console.log('\n11) 空 patch / 同一段自我認知：不落帳')
{
  const s = fresh()
  const before = s.records.length
  const p = s.savePersona({})
  ok(p.ok === true && p.unchanged === true, '空 persona patch 回 unchanged')
  ok(s.records.length === before, '沒有新增記錄')
  const sv = s.saveSelfView(s.selfView.text || '')
  ok(sv.ok === true && sv.unchanged === true, '同文自我認知回 unchanged')
  const u = s.setUnderstanding({})
  ok(u.ok === true && u.unchanged === true, '空 understanding patch 回 unchanged')
  const f = s.setFoundation(s.foundation.text)
  ok(f.ok === true && f.unchanged === true, '同文底座回 unchanged')
  ok(s.records.length === before, '以上都沒有新增記錄')
  rmSync(s.home, { recursive: true, force: true })
}

console.log('\n12) scanText：網址不再被當成絕對路徑')
{
  ok(M.scanText('https://example.com') === null, 'https:// 可以通過')
  ok(M.scanText('他在 https://example.com 看到一篇文章') === null, '句子裡的網址也可以通過')
  ok(M.scanText('部署 C:\\project') !== null, 'C:\\ 仍然被擋')
  ok(M.scanText('設定在 .dsh/config.json') !== null, '.dsh/config.json 仍然被擋')
}

console.log('\n13) speak：spokenToday 不再多 1')
{
  const s = fresh()
  s.cfg = { ...s.cfg, speak: true }
  s.valleyOf = () => ({ ok: true, window: 'test', label: '測試谷時' })
  const schedule = { create: async () => ({ id: 'sch-s', target: { sessionId: 'session-x' }, status: 'active' }) }
  const duty = makeDuty({ ctx: { get: () => schedule }, store: s, log: () => {} })
  const r = await duty.speak({ text: '這是一句測試的話。', kind: 'share' })
  ok(r.ok === true, `開口成功（${r.ok ? '' : r.error}）`)
  ok(r.spokenToday === s.spokenToday(), `回報的次數跟實際一致（${r.spokenToday} / ${s.spokenToday()}）`)
  ok(r.spokenToday === 1, `第一次就是 1（${r.spokenToday}）`)
  rmSync(s.home, { recursive: true, force: true })
}

console.log('\n14) reset：先收排程，再清帳（否則剛起的那輪會留下）')
{
  const order = []
  const store = {
    duty: null,
    resetAll: () => {
      order.push('reset')
      return { ok: true }
    },
  }
  const duty = {
    disarm: async () => { order.push('disarm') },
    info: () => ({}),
  }
  const handler = makeRoutes({ store, duty, version: 'test', log: () => {}, fence: () => false })
  const req = new EventEmitter()
  req.headers = { host: '127.0.0.1:9', 'content-type': 'application/json' }
  req.method = 'POST'
  req.url = '/api/silt/reset'
  const res = { statusCode: 0, setHeader() {}, end() {} }
  setTimeout(() => {
    req.emit('data', Buffer.from(JSON.stringify({ confirm: true })))
    req.emit('end')
  }, 0)
  await handler(req, res)
  ok(order.join(',') === 'disarm,reset', `順序是 disarm → reset（${order.join(',')}）`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
