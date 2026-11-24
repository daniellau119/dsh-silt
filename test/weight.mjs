/**
 * T4 權重升級 —— 2026-11-25 本人定的設計。
 *
 *   weight: 1 = 順帶想起 · 2 = 真的把它跟別的事連起來、或證實了它
 *   門檻 3 ⇒ 兩次認真（2+2=4），或三次順帶（1+1+1=3）
 *
 * 這組測試釘住四件事：
 *   A. 算術真的是「兩次認真或三次順帶」—— 不是別的組合
 *   B. 舊的 float `conf` 讀成 0，不換算（本人第 3 點的決定性理由：舊 conf 混著掃描噪音）
 *   C. n / linger 不被動到（那是 T3 在用的，清它會改到 T3 的行為）
 *   D. weight 只認 1 / 2，亂給的值被夾住
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'silt-weight-'))
const { Store } = await import('file:///E:/deepseek-harness/智能管家/silt/lib/store.js')
const { WEIGHT, UPGRADE_THRESHOLD, scratchWeight } = await import('file:///E:/deepseek-harness/智能管家/silt/lib/model.js')

let pass = 0
let fail = 0
const ok = (c, l) => (c ? (pass++, console.log(`  ok   ${l}`)) : (fail++, console.log(`  FAIL ${l}`)))

const store = () => {
  const s = new Store(home).load()
  s.cfg = { ...s.cfg, enabled: true }
  return s
}

console.log('0) 常量')
ok(UPGRADE_THRESHOLD === 3, `門檻 = 3（實際 ${UPGRADE_THRESHOLD}）`)
// ⚠️ 2026-11-25：0 是合法值（掃描不計份量），所以範圍是 0–2，不是 1–2。
ok(WEIGHT.min === 0 && WEIGHT.max === 2, `WEIGHT 範圍 0–2（實際 ${WEIGHT.min}–${WEIGHT.max}）`)
ok(WEIGHT.values.includes(0), '0 在 values 裡（掃描不計份量是有語義的值）')
ok(WEIGHT.default === 1, `WEIGHT 預設 1（實際 ${WEIGHT.default}）`)

console.log('\n0b) schema 的 enum 必須包含 0')
{
  // ⚠️ 2026-11-25 本人抓到的真 bug：schema 寫 enum:[1,2]，但反思提示詞第一句就是
  //    「帶 weight: 0 去掃」—— 0 不在 enum ⇒ 整支 recall 被 schema 拒絕 ⇒ 第 3 節根本掃不動。
  //    而且 WEIGHT.min 原本是 1，就算 schema 放行，0 也會被夾成 1（掃描反而算份量）。
  //    這條直接讀原始碼確認兩邊一致。
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/tools.js', import.meta.url), 'utf8')
  const i = src.indexOf('name: \'silt_recall\'')
  const j = src.indexOf('name: \'silt_remember\'')
  const block = src.slice(i, j)
  const m = block.match(/enum:\s*\[([^\]]+)\]/)
  ok(Boolean(m), '找得到 weight 的 enum')
  const values = String(m?.[1] || '').split(',').map((x) => Number(x.trim()))
  ok(values.includes(0), `enum 包含 0（實際 [${values.join(', ')}]）`)
  ok(values.includes(1) && values.includes(2), 'enum 也含 1 和 2')
  ok(!/confidence/.test(block), 'recall 的 schema 裡沒有殘留舊名 confidence')
}

console.log('\n1) 算術：兩次認真，或三次順帶')
{
  const s = store()
  const mk = (title) => {
    const r = s.writeMemory(
      { tier: 4, title, body: '還沒決定值不值得記的雜事', domain: 'other', dims: ['personality'] },
      { sessionId: 'sess-w', callId: 'c1' },
    )
    return r.memory.id
  }
  const id = mk('權重測試條')

  // 1 + 1 = 2 ❌
  s.recall({ tier: 4, limit: 30, weight: 1 })
  ok(scratchWeight(s.runtime.recalls[id]) === 1, '第一次順帶：count = 1')
  ok(scratchWeight(s.runtime.recalls[id]) < UPGRADE_THRESHOLD, '1 < 3，還沒升')

  // 1 + 1 + 1 = 3 ✅
  s.recall({ tier: 4, limit: 30, weight: 1 })
  ok(scratchWeight(s.runtime.recalls[id]) === 2, '第二次順帶：count = 2')
  s.recall({ tier: 4, limit: 30, weight: 1 })
  ok(scratchWeight(s.runtime.recalls[id]) >= 3, '第三次順帶：count ≥ 3 → 應升 T3')
  const after = s.memories.get(id)
  ok(after?.tier === 3 || after?.archived, '三次順帶之後，原條已升 T3（或已歸檔）')
}

{
  const s = store()
  const r = s.writeMemory(
    { tier: 4, title: '兩次認真就升', body: '這條會被認真想起兩次', domain: 'other', dims: ['personality'] },
    { sessionId: 'sess-w2', callId: 'c2' },
  )
  const id = r.memory.id
  s.recall({ tier: 4, limit: 30, weight: 2 })
  ok(scratchWeight(s.runtime.recalls[id]) === 2, '一次認真：count = 2')
  s.recall({ tier: 4, limit: 30, weight: 2 })
  ok(scratchWeight(s.runtime.recalls[id]) >= 3, '兩次認真：count ≥ 3 → 應升 T3')
}

{
  const s = store()
  const r = s.writeMemory(
    { tier: 4, title: '一次順帶一次認真', body: '1 + 2 = 3 應該升', domain: 'other', dims: ['personality'] },
    { sessionId: 'sess-w3', callId: 'c3' },
  )
  const id = r.memory.id
  s.recall({ tier: 4, limit: 30, weight: 1 })
  s.recall({ tier: 4, limit: 30, weight: 2 })
  ok(scratchWeight(s.runtime.recalls[id]) >= 3, '1 + 2 = 3 → 應升 T3')
}

console.log('\n2) 舊 conf 讀成 0，不換算')
{
  const s = store()
  const r = s.writeMemory(
    { tier: 4, title: '舊帳殘留', body: '這條的 runtime 裡有舊的 conf', domain: 'other', dims: ['personality'] },
    { sessionId: 'sess-w4', callId: 'c4' },
  )
  const id = r.memory.id
  // 模擬舊版留下的資料：conf 很高（舊制下早該升級了）
  s.runtime.recalls[id] = { n: 0, last: null, linger: 0, conf: 0.9 }
  ok(scratchWeight(s.runtime.recalls[id]) === 0, 'conf = 0.9 不被讀成 count（讀成 0）')
  ok(scratchWeight(s.runtime.recalls[id]) < UPGRADE_THRESHOLD, '所以不會因為舊 conf 就升級')
}

console.log('\n3) n / linger 不被動到')
{
  const s = store()
  const r = s.writeMemory(
    { tier: 4, title: '計數器分離', body: 'n 和 linger 是 T3 在用的', domain: 'other', dims: ['personality'] },
    { sessionId: 'sess-w5', callId: 'c5' },
  )
  const id = r.memory.id
  s.runtime.recalls[id] = { n: 7, linger: 3, count: 0 }
  s.recall({ tier: 4, limit: 30, weight: 2 })
  const rec = s.runtime.recalls[id]
  ok(Number(rec.n) >= 7, `n 沒有被清掉（${rec.n}）`)
  ok(Number(rec.linger) >= 3, `linger 沒有被清掉（${rec.linger}）`)
  ok(Number(rec.count) >= 2, `count 正常累加（${rec.count}）`)
}

console.log('\n4) weight 只認 1 / 2')
{
  const s = store()
  const mk = (title) => {
    const r = s.writeMemory({ tier: 4, title, body: '夾值測試', domain: 'other', dims: ['personality'] }, { sessionId: 'sess-w6', callId: 'c6' })
    return r.memory.id
  }
  const a = mk('超出上限 9')
  s.recall({ tier: 4, limit: 30, weight: 9 })
  ok(scratchWeight(s.runtime.recalls[a]) === WEIGHT.max, `weight 9 被夾到 ${WEIGHT.max}（實際 ${scratchWeight(s.runtime.recalls[a])}）`)

  // ⭐ 2026-11-25：0 不再是「低於下限」，它是**掃描**的語義 —— 完全不累加。
  const b = mk('掃描給 0')
  for (let i = 0; i < 5; i += 1) s.recall({ tier: 4, limit: 30, weight: 0 })
  ok(scratchWeight(s.runtime.recalls[b]) === 0, `weight 0 掃五次，count 仍然是 0（實際 ${scratchWeight(s.runtime.recalls[b])}）`)

  const b2 = mk('掃描之後真的想起')
  s.recall({ tier: 4, limit: 30, weight: 0 })
  s.recall({ tier: 4, limit: 30, weight: 2 })
  ok(scratchWeight(s.runtime.recalls[b2]) === 2, `掃描不計 + 一次認真 = 2（實際 ${scratchWeight(s.runtime.recalls[b2])}）`)

  const neg = mk('負數 -3')
  s.recall({ tier: 4, limit: 30, weight: -3 })
  ok(scratchWeight(s.runtime.recalls[neg]) === WEIGHT.min, `負數被夾到 ${WEIGHT.min}（實際 ${scratchWeight(s.runtime.recalls[neg])}）`)

  const c = mk('小數 1.5')
  s.recall({ tier: 4, limit: 30, weight: 1.5 })
  const cv = scratchWeight(s.runtime.recalls[c])
  ok(cv >= 1 && cv <= WEIGHT.max, `weight 1.5 被四捨五入並夾住（實際 ${cv}）`)

  const d = mk('沒給 weight')
  s.recall({ tier: 4, limit: 30 })
  ok(scratchWeight(s.runtime.recalls[d]) === WEIGHT.default, `沒給 weight → 預設 ${WEIGHT.default}（實際 ${scratchWeight(s.runtime.recalls[d])}）`)
}

rmSync(home, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
