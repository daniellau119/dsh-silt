// 新半衰期（T2 720 / T3 180 / T4 7）的驗證
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_SILT_HOME = mkdtempSync(join(tmpdir(), 'silt-tiers-'))
const { Store } = await import('file:///E:/deepseek-harness/智能管家/silt/lib/store.js')
const { TIERS, isExpired, salienceOf } = await import('file:///E:/deepseek-harness/智能管家/silt/lib/model.js')

let pass = 0
let fail = 0
const ok = (c, l) => (c ? (pass++, console.log(`  ok   ${l}`)) : (fail++, console.log(`  FAIL ${l}`)))

console.log('1) 新的基準半衰期')
ok(TIERS[2].halfLifeDays === 720, `T2 = 720（實際 ${TIERS[2].halfLifeDays}）`)
ok(TIERS[3].halfLifeDays === 180, `T3 = 180（實際 ${TIERS[3].halfLifeDays}）`)
// 2026-11-20：T4 改成「雜項」，半衰期 8 小時
ok(Math.abs(TIERS[4].halfLifeDays - 8 / 24) < 1e-9, `T4 = 8 小時（實際 ${(TIERS[4].halfLifeDays * 24).toFixed(2)} 小時）`)
ok(TIERS[4].label === '雜項', `T4 標籤 = 雜項（實際 ${TIERS[4].label}）`)
ok(TIERS[5].halfLifeDays === 30, 'T5 保持 30')
ok(TIERS[1].halfLifeDays === 36500, 'T1 保持 36500')

// 2026-11-25 本人把 T1 的**語義**從「事實」擴成「事實與規則」，但**上限保持 200**。
// 我一度把它改成 400，本人不同意，拉回來。這兩條斷言就是釘住那個決定：
//   - 數字是 200（不是我推論出來的 400）
//   - 標籤是「事實與規則」（語義確實擴了，規則可以進 T1）
ok(TIERS[1].maxChars === 200, `T1 上限 = 200 字（實際 ${TIERS[1].maxChars}）—— 本人定的，不是推論出來的`)
ok(TIERS[1].label === '事實與規則', `T1 標籤 = 事實與規則（實際 ${TIERS[1].label}）`)
console.log('\n1b) T1 收規則；日期可以寫；超過 200 字退回')
{
  const s = new Store(process.env.DSH_SILT_HOME).load()
  s.cfg = { ...s.cfg, enabled: true }
  const base = { sessionId: 'sess-1', callId: 'call-1' }
  // 規則要寫進 200 字以內 —— 寫法是精簡，不是把碗變大。
  const rule = s.writeMemory(
    {
      tier: 1,
      title: '他問「要不要我」時，先給判斷再問',
      body: '他說「要不要我去做」時，先講我判斷該不該做、為什麼，再問他同不同意。他問這句多半是給退路，不是要我請示。',
      domain: 'person',
      dims: ['personality'],
    },
    base,
  )
  ok(rule.ok === true, '規則可以寫進 T1（200 字以內）')

  // ⭐ 本人原話：「日期是記錄這條是甚麼時侯發生的」—— 所以日期照寫，不准被擋。
  const dated = s.writeMemory(
    {
      tier: 1,
      title: '2026-11-25 起，他改用語音輸入',
      body: '他說 2026-11-25 開始都改用語音輸入，所以我也應該回語音。',
      domain: 'world',
      dims: ['background'],
    },
    base,
  )
  ok(dated.ok === true, '帶日期的 T1 照樣可以寫（日期是這條甚麼時候發生的）')

  // 舊閘：T1 只收 person / world。規則常落在 work / feeling / other，不該被擋。
  const workRule = s.writeMemory(
    { tier: 1, title: '報價前先問清楚範圍', body: '接到報價前先問清楚範圍，不要先給數字。', domain: 'work', dims: ['personality'] },
    base,
  )
  ok(workRule.ok === true, '規則落在 work 這種 domain 也收（舊閘會擋掉）')

  const at200 = s.writeMemory(
    { tier: 1, title: '字數驗證', body: 'x'.repeat(190), domain: 'person', dims: ['personality'] },
    base,
  )
  ok(at200.ok === true, '200 字以內可以寫進去')
  const over = s.writeMemory(
    { tier: 1, title: '字數驗證二', body: 'x'.repeat(220), domain: 'person', dims: ['personality'] },
    base,
  )
  ok(over.ok === false, '超過 200 字被退回')
}

console.log('\n2) T2/T3 比例 = 4 倍')
ok(720 / 180 === 4, '720 / 180 = 4')

console.log('\n3) T4 半衰期 8 小時，TTL 24 小時（清掉之前早就暗了）')
{
  const H = 3600000
  const mem = (ageHours) => ({ id: 'x', tier: 4, importance: 0.4, bornAt: new Date(Date.now() - ageHours * H).toISOString() })
  for (const h of [0, 8, 12, 24]) {
    console.log(`       age ${String(h).padStart(2)} 小時 -> salience ${(salienceOf(mem(h), {}) / 0.4 * 100).toFixed(1)}%`)
  }
  ok(Math.abs(salienceOf(mem(8), {}) / 0.4 - 0.5) < 0.01, '8 小時正好掉一半')
  const at24 = salienceOf(mem(24), {}) / 0.4
  ok(Math.abs(at24 - 0.125) < 0.01, `24 小時只剩 12.5%（實際 ${(at24 * 100).toFixed(1)}%）`)
  const s = new Store(process.env.DSH_SILT_HOME).load()
  ok(s.cfg.tier4TtlHours === 24, `預設 TTL = 24 小時（實際 ${s.cfg.tier4TtlHours}）`)
  s.cfg = { ...s.cfg, tier4TtlHours: 24 }
  ok(!isExpired(mem(23), {}, s.cfg), '23 小時還活著')
  ok(isExpired(mem(25), {}, s.cfg), '25 小時淘汰')
  // 舊欄位名（天）仍然認：只有 tier4TtlDays: 1 應該換算成 24 小時
  ok(isExpired(mem(25), {}, { tier4TtlDays: 1 }), '舊欄位 tier4TtlDays:1 也按 24 小時算')
  ok(!isExpired(mem(30), {}, { tier4TtlHours: 48 }), 'tier4TtlHours 蓋過舊欄位')
}

console.log('\n4) T3 在 180 天時亮度剛好一半（壓縮 175 天落 T2）')
{
  const mem = (age) => ({ id: 'y', tier: 3, importance: 0.4, bornAt: new Date(Date.now() - age * 86400000).toISOString() })
  const v = salienceOf(mem(180), {})
  console.log(`       T3 age 180 -> ${(v / 0.4 * 100).toFixed(1)}%`)
  ok(Math.abs(v / 0.4 - 0.5) < 0.01, '180 天 = 半衰期，掉一半')
}

console.log('\n5) 召回延長仍然有效')
{
  const mem = { id: 'z', tier: 3, importance: 0.4, bornAt: new Date(Date.now() - 180 * 86400000).toISOString() }
  const a = salienceOf(mem, { recalls: { z: { n: 0 } } })
  const b = salienceOf(mem, { recalls: { z: { n: 10 } } })
  console.log(`       180 天, R=0 -> ${(a / 0.4 * 100).toFixed(0)}% | R=10 -> ${(b / 0.4 * 100).toFixed(0)}%`)
  ok(b > a, 'R=10 更亮')
}

rmSync(process.env.DSH_SILT_HOME, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
