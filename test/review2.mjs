/**
 * 2026-11-25 第二輪 review 的修復 —— 逐條釘住。
 *
 * 這批的共同點：它們不是「提示詞寫錯」，是**提示詞承諾了代碼沒做的事**
 * 或**代碼默默做了提示詞沒說的事**。所以每一條都要有可執行證據。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'silt-review2-'))
const { Store } = await import('file:///E:/deepseek-harness/智能管家/silt/lib/store.js')
const { TIERS } = await import('file:///E:/deepseek-harness/智能管家/silt/lib/model.js')

let pass = 0
let fail = 0
const ok = (c, l) => (c ? (pass++, console.log(`  ok   ${l}`)) : (fail++, console.log(`  FAIL ${l}`)))

const fresh = () => {
  const s = new Store(mkdtempSync(join(tmpdir(), 'silt-r2-'))).load()
  s.cfg = { ...s.cfg, enabled: true }
  return s
}
const ctx = { sessionId: 'sess-r2', callId: 'c-r2' }

console.log('⑥ recast / condense 沿用 bornAt 與 originalLen')
{
  const s = fresh()
  const old = new Date(Date.now() - 100 * 86400000).toISOString()
  const id = s.writeMemory(
    { tier: 3, title: '一百天前的事', body: '這件事一百天了'.repeat(20), domain: 'feeling', dims: ['personality'] },
    ctx,
  ).memory.id
  s.memories.set(id, { ...s.memories.get(id), bornAt: old, lastCondensedAt: old })

  const r = s.condense({ id, title: '換個看法', body: '換個角度講同一件事', mode: 'recast' }, ctx)
  ok(r.ok === true, 'recast 成功')
  ok(r.memory.bornAt === old, 'bornAt 沿用原條 —— 不然壓縮目標公式的 T 會歸零，時鐘還是被重置')
  ok(Number(r.memory.originalLen) > 0, 'originalLen 有值（目標從它連乘算起）')

  // condense 也要沿用
  const id2 = s.writeMemory({ tier: 3, title: '另一件事', body: '這條會被正常壓縮'.repeat(30), domain: 'feeling', dims: ['personality'] }, ctx).memory.id
  s.memories.set(id2, { ...s.memories.get(id2), bornAt: old })
  const c = s.condense({ id: id2, title: '壓短', body: '壓短了', targetLen: 10 }, ctx)
  ok(c.ok === true, 'condense 成功')
  if (c.tier === 3) ok(c.memory.bornAt === old, 'condense（留 T3）也沿用 bornAt')
  else ok(c.tier === 2, `condense 沉成 T2（T2 用 bornAt=沉澱時刻是設計，見 compress 的註解）`)
}

console.log('\n⑦ pendingSays 帶 at（模型判得到「超過一天」）')
{
  const s = fresh()
  const r = s.pendingSay({ text: '這句留著下次說', reason: '時機不對', sessionId: 'x' })
  ok(r.ok === true, 'pendingSay 成功')
  ok(typeof r.pending.at === 'string' && r.pending.at.length > 10, `有 at 時間戳（${r.pending.at}）`)
  const st = s.speakState()
  ok(Array.isArray(st.pendingSays) && st.pendingSays.length === 1, 'speakState 回傳得到它')
  ok(typeof st.pendingSays[0].at === 'string', 'speakState 的 pendingSays 也帶 at（東八區）')
  ok(st.pendingSays[0].atUtc !== undefined, '同時保留 atUtc 供對帳')
}

console.log('\n⑧ release 用 id，不是照抄 text')
{
  const s = fresh()
  const a = s.pendingSay({ text: '第一句話，標點：有冒號。' })
  const b = s.pendingSay({ text: '第二句話。' })
  ok(a.ok && b.ok, '留了兩句')
  ok(a.pending.id !== b.pending.id, '兩句各有 id')

  // 用 id 拿掉 —— 這才是正常路徑
  const r1 = s.clearPendingSay({ id: a.pending.id })
  ok(r1.ok === true, '用 id 拿得掉')
  ok(s.pendingSays().length === 1, '只剩一句')
  ok(s.pendingSays()[0].id === b.pending.id, '剩下的是對的那一句')

  // 用 id 拿不存在的
  const r2 = s.clearPendingSay({ id: 's-nope' })
  ok(r2.ok === false, 'id 不存在要回錯誤，不要假裝成功')

  // 舊路徑：text 仍然可用（向後相容），但只認逐字相同
  const r3 = s.clearPendingSay({ text: '第二句話。' })
  ok(r3.ok === true, 'text 仍然可用（向後相容）')
  const r4 = s.clearPendingSay({ text: '第二句話' }) // 少了句號
  ok(r4.ok === false, 'text 差一個標點就對不上 —— 所以 id 才是正常路徑')
}

console.log('\n⑦ 掃描不算想起（沒有 query 的瀏覽不 bump R）')
{
  const s = fresh()
  const id = s.writeMemory(
    { tier: 3, title: '會被反覆瀏覽的那條', body: '反思每輪都會讀到它'.repeat(10), domain: 'person', dims: ['background'] },
    ctx,
  ).memory.id
  const R = () => Number(s.runtime.recalls?.[id]?.n || 0)

  // 模擬 12 小時一輪的反思：每輪都「瀏覽一遍」（無 query）
  for (let i = 0; i < 10; i += 1) {
    s.recall({ limit: 30, sessionId: `browse-${i}` })
  }
  ok(R() === 0, `10 輪瀏覽之後 R 仍然是 0（實際 ${R()}）—— 掃描不該算想起`)

  // 帶 query 的 targeted recall 才算
  s.recall({ query: '反覆瀏覽', limit: 30, sessionId: 'targeted-1' })
  ok(R() === 1, `帶 query 才算一次想起（實際 ${R()}）`)
  s.recall({ query: '反覆瀏覽', limit: 30, sessionId: 'targeted-2' })
  ok(R() === 2, `再查一次 = 2（實際 ${R()}）`)

  // 明確說「這次不算」
  s.recall({ query: '反覆瀏覽', limit: 30, sessionId: 'explicit-1', countAsRecall: false })
  ok(R() === 2, `countAsRecall:false 時不計數（實際 ${R()}）`)
}

console.log('\n⑦ 但 T4 的 weight 在瀏覽時仍然算數')
{
  const s = fresh()
  const id = s.writeMemory(
    { tier: 4, title: 'T4 在瀏覽時給份量', body: '反思掃 T4 時給 weight 2', domain: 'other', dims: ['personality'] },
    ctx,
  ).memory.id
  // 瀏覽（無 query），但給了 weight 2
  s.recall({ tier: 4, limit: 30, weight: 2, sessionId: 'b1' })
  ok(Number(s.runtime.recalls?.[id]?.count || 0) === 2, `瀏覽時給的 weight 仍然累加（實際 ${s.runtime.recalls?.[id]?.count}）`)
  ok(Number(s.runtime.recalls?.[id]?.n || 0) === 0, '但 n 沒有漲（T4 本來就不看 n，這裡只是確認兩個開關是分開的）')
}

console.log('\nrecastCount 要能被模型看到（不然那條上限是裝飾）')
{
  const s = fresh()
  let id = s.writeMemory(
    { tier: 3, title: '會被重述的那條', body: '這件事我一直在改看法'.repeat(10), domain: 'feeling', dims: ['personality'] },
    ctx,
  ).memory.id
  const r1 = s.condense({ id, title: '重述一', body: '第一次換角度', mode: 'recast' }, ctx)
  id = r1.memory.id
  const r2 = s.condense({ id, title: '重述二', body: '第二次換角度', mode: 'recast' }, ctx)
  id = r2.memory.id
  ok(r2.memory.recastCount === 2, `recastCount 跨版本累加到 2（實際 ${r2.memory.recastCount}）`)

  const hit = s.recall({ query: '重述二', limit: 10, sessionId: 'rc' }).find((h) => h.id === id)
  ok(Boolean(hit), 'recall 搜得到')
  ok(Number(hit?.recastCount) === 2, `recall 輸出帶 recastCount（實際 ${hit?.recastCount}）`)
  ok(Number(hit?.recastLeft) === 1, `同時給「還剩幾次」（實際 ${hit?.recastLeft}）`)

  // 第 3 次成功，第 4 次被拒
  const r3 = s.condense({ id, title: '重述三', body: '第三次換角度', mode: 'recast' }, ctx)
  ok(r3.ok === true, '第 3 次成功')
  const r4 = s.condense({ id: r3.memory.id, title: '重述四', body: '第四次換角度', mode: 'recast' }, ctx)
  ok(r4.ok === false, '第 4 次被拒')
}

console.log('\nreflectionAt 設了，tune reflectionEveryHours 要明說不生效')
{
  const s = fresh()
  s.cfg = { ...s.cfg, reflectionAt: [19 * 60, 7 * 60] }
  const r = s.tuneRhythm({ reflectionEveryHours: 6 }, { reason: 'test', actor: 'model' })
  ok(r.ok === true, 'tune 本身成功（值仍然收下）')
  ok(Array.isArray(r.ignored) && r.ignored.some((x) => String(x).includes('reflectionEveryHours')), 'ignored 裡標出了 reflectionEveryHours 不生效')

  // 沒有固定鐘點時不該標
  const s2 = fresh()
  const r2 = s2.tuneRhythm({ reflectionEveryHours: 6 }, { reason: 'test', actor: 'model' })
  ok(!(r2.ignored || []).some((x) => String(x).includes('reflectionEveryHours')), '沒設固定鐘點時不標')
}

console.log('\nknobProvenance：看得出旋鈕是誰訂的')
{
  const s = fresh()
  const prov0 = s.knobProvenance(['injectBudget'])
  ok(prov0.injectBudget.setBy === 'default', '沒動過 ⇒ default')

  s.tuneInjection({ injectBudget: 2000 }, { reason: 'model test', actor: 'model' })
  const prov1 = s.knobProvenance(['injectBudget'])
  ok(prov1.injectBudget.setBy === 'model', `模型調過 ⇒ model（實際 ${prov1.injectBudget.setBy}）`)

  s.saveConfig({ injectBudget: 3200 })
  // saveConfig 沒寫帳本記錄，所以 provenance 仍然看帳本 —— 這裡確認它不會謊報成 user
  const prov2 = s.knobProvenance(['injectBudget'])
  ok(prov2.injectBudget.setBy === 'model', 'saveConfig 不寫帳本 ⇒ 仍然是帳本上最後一筆的 actor')
}

rmSync(home, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
