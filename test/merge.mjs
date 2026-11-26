/**
 * test/merge.mjs — 合併：同層 2–3 條收成一條
 *
 * 2026-11-27 本人定案：
 *   · **目前只做 T3**（T1 先暫停：先把 intake 的兩道關收緊，再看還剩多少真正的重複）
 *   · 每一條都要在本會話被針對性 recall 過（看過正文）才准併
 *   · 原條 archived + mergedInto（不是 voided —— 它們沒說錯）
 *   · 時鐘不變：bornAt / firstSeen / lastCondensedAt 取最早，
 *     originalLen 取來源 max，recastCount 取 max，R 由 payload 的 recallSeed 播種
 *
 * 這一輪驗的就是這些屬性 —— 特別是「合併不會送壽命、也不會斷崖」。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/store.js'
import { makeDuty } from '../lib/duty.js'
import { standingOf } from '../lib/model.js'

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
  const dir = mkdtempSync(join(tmpdir(), 'silt-merge-'))
  dirs.push(dir)
  const s = new Store(dir).load()
  s.cfg = { ...s.cfg, enabled: true }
  return s
}
const ctx = { sessionId: 'sess-merge', callId: 'c-merge' }
const write = (s, tier, title, body, extra = {}) =>
  s.writeMemory(
    { tier, title, body, domain: 'work', dims: ['work'], importance: tier === 1 ? 0.9 : 0.6, ...extra },
    ctx,
  )
const recallAll = (s) => s.recall({ query: '夜班', limit: 30, sessionId: ctx.sessionId })
const day = (n) => new Date(Date.now() - n * 86400000).toISOString()
const set = (s, id, patch) => s.memories.set(id, { ...s.memories.get(id), ...patch })

try {
  /* ─────────────────────────────────────────────── */
  section('1 · T3：三條 → 一條，時鐘不變')
  {
    const s = fresh()
    const a = write(s, 3, '夜班一', '夜班：六十天前那條，內容 AAA').memory.id
    const b = write(s, 3, '夜班二', '夜班：三十天前那條，內容 BBB').memory.id
    const c = write(s, 3, '夜班三', '夜班：五天前那條，內容 CCC').memory.id
    set(s, a, { bornAt: day(60), firstSeen: '2026-08-01', lastCondensedAt: day(10), originalLen: 972, recastCount: 2 })
    set(s, b, { bornAt: day(30), firstSeen: '2026-09-01', lastCondensedAt: day(3), originalLen: 500 })
    set(s, c, { bornAt: day(5), firstSeen: '2026-10-01', lastCondensedAt: day(1), originalLen: 400 })

    recallAll(s)
    const r = s.merge(
      {
        ids: [a, b, c],
        title: '夜班的真實條件',
        body: '夜班 23:00–08:00，連續 8–9 小時、在自己的環境；留下主因是穩定收入兜底。',
        reason: '三條都在講同一段夜班，只是寫了三次',
      },
      ctx,
    )
    ok(r.ok, `合併成功（${r.error || r.tier}）`)
    const g = r.memory
    eq(g.tier, 3, '結果留在 T3（不過層）')
    eq(g.bornAt, s.memories.get(a).bornAt, 'bornAt 取最早')
    eq(g.firstSeen, '2026-08-01', 'firstSeen 取最早')
    eq(g.lastCondensedAt, s.memories.get(a).lastCondensedAt, 'lastCondensedAt 取最早（不給 7 天寬限）')
    eq(g.originalLen, 972, 'originalLen 取來源 max（不是新條長度、也不是總和）')
    eq(g.recastCount, 2, 'recastCount 取 max（不能歸零）')
    eq(r.recallSeed, 1, 'recallSeed = 來源 n 的 max')
    eq(s.runtime.recalls[g.id]?.n, 1, 'R 由 payload 播種進 runtime')
    eq(JSON.stringify(g.mergedFrom), JSON.stringify([a, b, c]), 'mergedFrom 記了三個來源')

    for (const id of [a, b, c]) {
      ok(s.memories.get(id)?.archived === true, `${id} 已歸檔`)
      eq(s.memories.get(id)?.mergedInto, g.id, `${id} 的 mergedInto 指向新條`)
    }
    ok(s.activeMemories().some((m) => m.id === g.id), '新條在 activeMemories')
    ok(!s.activeMemories().some((m) => [a, b, c].includes(m.id)), '原條不在 activeMemories')

    const def = s.recall({ query: '夜班', limit: 30 })
    ok(!def.some((x) => [a, b, c].includes(x.id)), '預設 recall 看不到原條')
    const all = s.recall({ query: '夜班', includeArchived: true, limit: 30 })
    const rowA = all.find((x) => x.id === a)
    ok(rowA?.archived === true, 'includeArchived 找得到原條')
    eq(rowA?.mergedInto, g.id, '原條帶著 mergedInto，說得出被併去哪')

    // standing 要認得出這是「改寫自原條」，不是「我自己寫的、沒有外部依據」
    const st = standingOf(g, Date.now(), 0)
    ok(String(st.basis).includes('改写自'), `standing 認得合併鏈（${st.basis}）`)
    ok(String(st.checkWith).includes(a), `checkWith 指向原條（${st.checkWith}）`)
  }

  /* ─────────────────────────────────────────────── */
  section('2 · 沒 recall 過不能併')
  {
    const s = fresh()
    const a = write(s, 3, '夜班一', '夜班 Alpha 內容').memory.id
    const b = write(s, 3, '夜班二', '夜班 Beta 內容').memory.id
    const bad = s.merge({ ids: [a, b], title: '夜班合併', body: '夜班：Alpha 與 Beta。', reason: '同一件事' }, ctx)
    ok(!bad.ok, '沒 recall 直接拒絕')
    ok(String(bad.error).includes('recall'), `錯誤訊息叫他先 recall（${bad.error}）`)

    recallAll(s)
    const good = s.merge({ ids: [a, b], title: '夜班合併', body: '夜班：Alpha 與 Beta。', reason: '同一件事' }, ctx)
    ok(good.ok, `recall 過之後可以併（${good.error || ''}）`)
  }

  /* ─────────────────────────────────────────────── */
  section('3 · 層級與來源檢查')
  {
    const s = fresh()
    const t1 = write(s, 1, '他的公司', '他的公司在機場做夜班運維。').memory.id
    const t3 = write(s, 3, '夜班片段', '夜班的一個片段。').memory.id
    recallAll(s)
    const mix = s.merge({ ids: [t1, t3], title: '混層合併', body: '兩件事。', reason: '不該過' }, ctx)
    ok(!mix.ok && String(mix.error).includes('同層'), `混層拒絕（${mix.error}）`)

    const v = write(s, 3, '夜班舊版', '夜班的舊版本。').memory.id
    s.voidMemory(v, { reason: '本人說記錯了' })
    const withVoid = s.merge({ ids: [v, t3], title: '含作廢', body: '兩件事。', reason: '不該過' }, ctx)
    ok(!withVoid.ok && String(withVoid.error).includes('作廢'), `作廢的不參與（${withVoid.error}）`)

    const arch = write(s, 3, '夜班壓縮版', '夜班長內容'.repeat(20)).memory.id
    s.compress(
      { gist: { tier: 2, title: '一句概', body: '夜班的一句話。', domain: 'work', dims: ['work'] }, ids: [arch] },
      ctx,
    )
    const withArch = s.merge({ ids: [arch, t3], title: '含歸檔', body: '兩件事。', reason: '不該過' }, ctx)
    ok(!withArch.ok && String(withArch.error).includes('收起來'), `已歸檔的不參與（${withArch.error}）`)

    const one = s.merge({ ids: [t3], title: '只有一條', body: '一條。', reason: '不該過' }, ctx)
    ok(!one.ok && String(one.error).includes('2–3'), `一條拒絕（${one.error}）`)
  }

  /* ─────────────────────────────────────────────── */
  section('4 · T1 合併暫停（先把 intake 收緊，見 silt_remember 的兩道關）')
  {
    const s = fresh()
    const a = write(s, 1, '公司在機場做保安', '他的公司在機場做保安，他是夜班運維。', { tags: ['公司'] }).memory.id
    const b = write(s, 1, '公司在機場做門禁', '他的公司在機場做門禁，也是夜班運維。', { tags: ['門禁'] }).memory.id
    recallAll(s)
    const r = s.merge(
      {
        ids: [a, b],
        title: '他的公司：機場保安與門禁',
        body: '他的公司在機場做保安、門禁；他是夜班運維。',
        reason: '同一間公司',
      },
      ctx,
    )
    ok(!r.ok && String(r.error).includes('只做 T3'), `T1 暫停（${r.error}）`)
    ok(s.memories.get(a)?.archived !== true && s.memories.get(b)?.archived !== true, '原條沒有被動到')
  }

  /* ─────────────────────────────────────────────── */
  section('5 · 長度：不能超過該層上限，也不能不比原本短')
  {
    const s = fresh()
    // T3 的上限是 1000
    const a = write(s, 3, '夜班甲', '夜班的內容'.repeat(80)).memory.id
    const b = write(s, 3, '夜班乙', '夜班的內容'.repeat(80)).memory.id
    recallAll(s)
    const tooLong = s.merge({ ids: [a, b], title: '很長的新標題'.repeat(2), body: 'x'.repeat(1000), reason: '太長' }, ctx)
    ok(!tooLong.ok && String(tooLong.error).includes('上限'), `超過 1000 拒絕（${tooLong.error}）`)

    const c = write(s, 3, '甲乙', '夜班一').memory.id
    const d = write(s, 3, '丙丁', '夜班二').memory.id
    recallAll(s)
    const notShorter = s.merge({ ids: [c, d], title: '甲乙丙', body: '夜班一二三四五六七', reason: '沒有變短' }, ctx)
    ok(!notShorter.ok && String(notShorter.error).includes('沒有比原本'), `比原本長就拒絕（${notShorter.error}）`)
  }

  /* ─────────────────────────────────────────────── */
  section('6 · 新條也要過掃描閘（不能自己組記錄繞道）')
  {
    const s = fresh()
    const a = write(s, 3, '夜班甲', '夜班的內容'.repeat(30)).memory.id
    const b = write(s, 3, '夜班乙', '夜班的內容'.repeat(30)).memory.id
    recallAll(s)
    const r = s.merge(
      { ids: [a, b], title: '夜班的東西', body: '他把東西放在 C:\\Users\\danie\\app 裡。', reason: '測試掃描' },
      ctx,
    )
    ok(!r.ok && String(r.error).includes('refused'), `路徑被掃描閘拒絕（${r.error}）`)
  }

  /* ─────────────────────────────────────────────── */
  section('7 · 回滾：原條復活、新條消失、runtime 記數一起走')
  {
    const s = fresh()
    const a = write(s, 3, '夜班一', '夜班 Alpha 內容').memory.id
    const b = write(s, 3, '夜班二', '夜班 Beta 內容').memory.id
    recallAll(s)
    const r = s.merge({ ids: [a, b], title: '夜班合併', body: '夜班：Alpha 與 Beta。', reason: '同一件事' }, ctx)
    ok(r.ok, '合併成功')
    const newId = r.memory.id

    const rb = s.rollback(r.snapshotId)
    ok(rb.ok && rb.scope === 'merge', `回滾成功（${rb.scope}）`)
    ok(!s.memories.has(newId), '新條被拿走')
    ok(!s.runtime.recalls[newId], 'runtime 的 recall 記數一起被清掉')
    for (const id of [a, b]) {
      const m = s.memories.get(id)
      ok(m && !m.archived && !m.mergedInto && !m.supersededBy, `${id} 回到未歸檔狀態`)
      ok(s.activeMemories().some((x) => x.id === id), `${id} 回到 activeMemories`)
    }
  }

  /* ─────────────────────────────────────────────── */
  section('8 · 合併後不會被下一輪立刻壓（originalLen 取 max 的效用）')
  {
    const s = fresh()
    const ids = []
    for (const [i, tag] of ['甲', '乙', '丙'].entries()) {
      const id = write(s, 3, `夜班${tag}`, '夜班的內容'.repeat(20) + `${i}`).memory.id
      set(s, id, { bornAt: day(60), firstSeen: '2026-08-01', lastCondensedAt: day(10), originalLen: 972 })
      ids.push(id)
    }
    recallAll(s)
    const r = s.merge(
      {
        ids,
        title: '夜班的真實條件',
        body: '夜班的內容'.repeat(27),
        reason: '三條在講同一段夜班',
      },
      ctx,
    )
    ok(r.ok, `合併成功（${r.error || ''}）`)

    const duty = makeDuty({ ctx: {}, store: s })
    const plan = duty.condensePlan()
    ok(!plan.some((x) => x.id === r.memory.id), 'base 取 972 → 這一輪不列（343 > 143）')

    set(s, r.memory.id, { originalLen: 250 })
    const plan2 = duty.condensePlan()
    ok(plan2.some((x) => x.id === r.memory.id), '若 base 錯取新條長度 → 就會立刻被列（對照）')
  }

  /* ─────────────────────────────────────────────── */
  section('9 · 換機器只帶 ledger：R 由 recallSeed 播種')
  {
    const s = fresh()
    const a = write(s, 3, '夜班一', '夜班 Alpha 內容').memory.id
    const b = write(s, 3, '夜班二', '夜班 Beta 內容').memory.id
    s.bumpRecall([a])
    s.bumpRecall([a])
    s.bumpRecall([b])
    recallAll(s) // +1 → a=3, b=2
    const r = s.merge({ ids: [a, b], title: '夜班合併', body: '夜班：Alpha 與 Beta。', reason: '同一件事' }, ctx)
    ok(r.ok, '合併成功')
    eq(r.recallSeed, 3, 'recallSeed = max(3, 2)')

    const raw = readFileSync(join(s.home, 'ledger.jsonl'), 'utf8')
    const s2 = fresh()
    const imp = s2.importLedger(raw)
    ok(imp.ok, `導入成功（${imp.error || ''}）`)
    ok(s2.memories.has(r.memory.id), '新機器上有這條合併記憶')
    eq(s2.runtime.recalls[r.memory.id]?.n, 3, '新機器上 R = recallSeed（不是 0）')
    ok(s2.verify().ok, '導入後哈希鏈完好')
  }

  /* ─────────────────────────────────────────────── */
  section('10 · standing 認得壓縮鏈')
  {
    const s = fresh()
    const id = write(s, 3, '長長的一條', '這條要被壓縮'.repeat(60)).memory.id
    const c = s.condense({ id, title: '壓短後', body: '這條要被壓縮'.repeat(40), targetLen: 250 }, ctx)
    ok(c.ok && c.tier === 3, `壓縮後仍是 T3（${c.tier}）`)
    const st = standingOf(s.memories.get(c.memory.id), Date.now(), 0)
    ok(String(st.basis).includes('改写自'), `standing 認得壓縮鏈（${st.basis}）`)
    ok(String(st.checkWith).includes(id), `checkWith 指向原條（${st.checkWith}）`)
  }
} finally {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* 測試收尾失敗不影響結果 */
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)