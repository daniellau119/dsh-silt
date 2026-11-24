// 新半衰期（T2 720 / T3 180）的驗證；T4 沒有獨立半衰期，跟著 TTL 走（2026-11-25）
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
// 2026-11-25：T4 不再有獨立的半衰期 —— 它跟著 TTL 走（見下面第 3 節）
ok(TIERS[4].halfLifeDays === undefined, 'T4 沒有獨立 halfLifeDays（半衰期跟著 TTL 走）')
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

console.log('\n3) T4：半衰期跟著 TTL 走（2026-11-25），TTL 預設 48 小時')
{
  const H = 3600000
  const mem = (ageHours) => ({ id: 'x', tier: 4, importance: 0.4, bornAt: new Date(Date.now() - ageHours * H).toISOString() })
  const cfg = { tier4TtlHours: 48 }
  for (const h of [0, 12, 24, 48]) {
    console.log(`       age ${String(h).padStart(2)} 小時 -> salience ${(salienceOf(mem(h), {}, Date.now(), cfg) / 0.4 * 100).toFixed(1)}%`)
  }
  // 半衰期 = TTL ⇒ 走完 48 小時剛好掉一半
  const at48 = salienceOf(mem(48), {}, Date.now(), cfg) / 0.4
  ok(Math.abs(at48 - 0.5) < 0.01, `48 小時正好掉一半（實際 ${(at48 * 100).toFixed(1)}%）`)
  const at24 = salienceOf(mem(24), {}, Date.now(), cfg) / 0.4
  ok(Math.abs(at24 - Math.SQRT1_2) < 0.01, `24 小時掉到 √½（實際 ${(at24 * 100).toFixed(1)}%）`)

  // ⭐ 改 TTL 就改亮度 —— 這正是「不要兩個獨立數字」的意思
  const ttl24 = salienceOf(mem(24), {}, Date.now(), { tier4TtlHours: 24 }) / 0.4
  ok(Math.abs(ttl24 - 0.5) < 0.01, 'TTL 設 24，則 24 小時剛好掉一半（亮度跟著 TTL 走）')

  // TIERS[4] 故意沒有 halfLifeDays：有它就會變成第二個數字
  ok(TIERS[4].halfLifeDays === undefined, 'TIERS[4] 沒有獨立的 halfLifeDays')

  const s = new Store(process.env.DSH_SILT_HOME).load()
  ok(s.cfg.tier4TtlHours === 48, `預設 TTL = 48 小時（實際 ${s.cfg.tier4TtlHours}）`)
  ok(!isExpired(mem(47), {}, { tier4TtlHours: 48 }), '47 小時還活著')
  ok(isExpired(mem(49), {}, { tier4TtlHours: 48 }), '49 小時淘汰')
  ok(!isExpired(mem(9999), {}, { tier4TtlHours: 0 }), 'TTL=0 表示不過期（語義留著）')
  // 舊欄位名（天）的相容在 load() 裡做，不在 isExpired 裡 —— 要測就測 load 那一層。
  // 直接傳給 isExpired 的舊欄位名不會被認，那本來就是對的。
  const legacyHome = mkdtempSync(join(tmpdir(), 'silt-legacy-'))
  writeFileSync(join(legacyHome, 'config.json'), JSON.stringify({ enabled: true, tier4TtlDays: 1 }), 'utf8')
  const legacy = new Store(legacyHome).load()
  ok(legacy.cfg.tier4TtlHours === 24, `舊欄位 tier4TtlDays:1 換算成 24 小時（實際 ${legacy.cfg.tier4TtlHours}）`)
  ok(!('tier4TtlDays' in legacy.cfg), '換算完舊欄位從 cfg 裡刪掉（不會被回寫）')
  rmSync(legacyHome, { recursive: true, force: true })
  ok(!isExpired(mem(30), {}, { tier4TtlHours: 48 }), 'tier4TtlHours 48 時，30 小時還活著')

  // ⭐ 範圍 24–168（2026-11-25 本人定），0 = 不過期 是特例、不該被夾成 24
  const clampHome = mkdtempSync(join(tmpdir(), 'silt-clamp-'))
  const cs = new Store(clampHome).load()
  cs.cfg = { ...cs.cfg, enabled: true }
  const set = (v) => cs.saveConfig({ tier4TtlHours: v }).tier4TtlHours
  ok(set(48) === 48, '48 → 48')
  ok(set(24) === 24, '24（下限）→ 24')
  ok(set(168) === 168, '168（上限）→ 168')
  ok(set(10) === 24, `10 → 夾到下限 24（實際 ${set(10)}）`)
  ok(set(5000) === 168, `5000 → 夾到上限 168（實際 ${set(5000)}）`)
  ok(set(0) === 0, `0 → 0（不過期是特例，不夾成 24；實際 ${set(0)}）`)
  // 讀檔時也洗：手改過的 config.json 寫了超出範圍的值
  //
  // ⚠️ 2026-11-25：要用**全新的目錄**。`saveConfig` 現在會落帳（本人第 2 條），
  //    而 load() = 先讀 config.json、再重放帳本 —— 同一個目錄裡有舊帳本的話，
  //    帳本裡的舊值會蓋掉剛寫進去的 2160，測到的就不是「洗檔」而是「replay」。
  const washHome = mkdtempSync(join(tmpdir(), 'silt-wash-'))
  writeFileSync(join(washHome, 'config.json'), JSON.stringify({ enabled: true, tier4TtlHours: 2160 }), 'utf8')
  ok(new Store(washHome).load().cfg.tier4TtlHours === 168, '檔案裡寫 2160（舊版範圍）讀進來被夾到 168')
  rmSync(washHome, { recursive: true, force: true })
  const zeroHome = mkdtempSync(join(tmpdir(), 'silt-zero-'))
  writeFileSync(join(zeroHome, 'config.json'), JSON.stringify({ enabled: true, tier4TtlHours: 0 }), 'utf8')
  ok(new Store(zeroHome).load().cfg.tier4TtlHours === 0, '檔案裡寫 0 仍然是 0（特例不被洗掉）')
  rmSync(zeroHome, { recursive: true, force: true })
  rmSync(clampHome, { recursive: true, force: true })

  // 用 bornAt 算，不是 firstSeen：firstSeen 截到小時，會讓條目最多早退 59 分鐘
  const justBorn = { id: 'b', tier: 4, importance: 0.4, bornAt: new Date().toISOString(), firstSeen: '2000-01-01' }
  ok(!isExpired(justBorn, {}, { tier4TtlHours: 48 }), '剛出生的 T4 不會因為 firstSeen 很舊就被判過期')
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
