/**
 * 完整性检查（一次性脚本，不进 test/）。
 * 只读真家目录，不改任何东西。临时状态全部在临时目录里跑。
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/store.js'
import * as M from '../lib/model.js'
import { inValley } from '../lib/duty.js'

const HOME = 'C:/Users/danie/.dsh/silt'
const line = (t) => console.log(`\n${'='.repeat(60)}\n${t}\n${'='.repeat(60)}`)
let problems = 0
const check = (ok, label, detail = '') => {
  if (!ok) problems += 1
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

/* ── 1. 真實家目錄 ── */
line('1. 真實家目錄（只讀）')
const real = new Store(HOME, {})
real.load()
console.log(`  家目錄: ${HOME}`)
console.log(`  config: enabled=${real.cfg.enabled} budget=${real.cfg.injectBudget} reflection=${real.cfg.reflection} valleyOnly=${real.cfg.valleyOnly}`)
console.log(`  常數: PERSONA_MAX=${M.PERSONA_MAX} SELF_VIEW_MAX=${M.SELF_VIEW_MAX} INJECT_PERSONA_MAX=${M.INJECT_PERSONA_MAX}`)
console.log(`  slots(${real.cfg.injectBudget}) = ${M.slotsForBudget(real.cfg.injectBudget)}`)
check(real.cfg.injectBudget >= 600 && real.cfg.injectBudget <= 3200, `injectBudget 在硬範圍內（${real.cfg.injectBudget}）`)
check(M.PERSONA_MAX === 350 && M.SELF_VIEW_MAX === 350 && M.INJECT_PERSONA_MAX === 700, '三個上限都是新值')

const fd = String(real.foundation?.text || '')
console.log(`\n  底座 ${fd.length} 字 / 400 硬頂（${fd.length > 400 ? '會被截斷' : '不會截斷'}）`)
console.log('  ┌─────────────────────────────────────────')
for (const l of fd.split('\n')) console.log('  │ ' + l)
console.log('  └─────────────────────────────────────────')
check(fd.length > 0, '底座已寫入')
check(fd.length <= 400, '底座沒超過 400 字')
// 底座內容是本人寫的，不在診斷腳本裡斷言特定名字或句子。

const chain = real.verify({ force: true })
check(chain.ok, '哈希鏈完好', `${chain.count} 筆`)
console.log(`  記憶 ${real.memories.size} 條 / 账本 ${real.records.length} 筆`)

/* ── 2. 注入渲染（假設總開關開著） ── */
line('2. 注入渲染（在臨時副本裡把 enabled 打開）')
const tmp = mkdtempSync(join(tmpdir(), 'silt-intcheck-'))
try {
  const s = new Store(tmp, { enabled: true, injectBudget: 3000 })
  s.load()
  s.cfg = { ...s.cfg, enabled: true, injectBudget: 3000 }
  s.foundation = real.foundation   // 借用真底座，只读

  const inj = s.injectionText()
  console.log(`  總長 ${inj.length} / 3000`)
  console.log('  ┌─────────────────────────────────────────')
  for (const l of inj.split('\n')) console.log('  │ ' + l)
  console.log('  └─────────────────────────────────────────')
  check(inj.length > 0, '注入非空')
  check(fd.length === 0 || inj.includes(fd.slice(0, Math.min(20, fd.length))), '底座有進注入')
  check(inj.includes('【仍記得的】'), '有【仍記得的】區塊')
  check(inj.length < 3000, '注入沒超預算')

  /* ── 3. 四條寫入路徑 ── */
  line('3. 四條路徑：記 / 重述 / 作廢 / 性格')
  const w = s.writeMemory(
    { tier: 3, title: '第一次見面', body: '他問我記得什麼，我說剛開始。'.repeat(3), domain: 'other', dims: ['personality'], importance: 0.6 },
    { sessionId: 's-check', actor: 'model' },
  )
  check(w.ok, 'memory.write', w.ok ? w.memory.id : w.error)

  const rc = s.condense({ id: w.memory.id, title: '他問我記得什麼', body: '那時我還什麼都沒有。'.repeat(2), mode: 'recast' }, { sessionId: 's-check' })
  check(rc.ok, 'memory.recast', rc.ok ? `mode=${rc.mode} tier=${rc.tier}` : rc.error)
  check(rc.ok && rc.tier === 3, '重述留在 T3')

  const rs = s.savePersona({ traits: [{ key: '好奇', value: '想先弄清楚再回答', weight: 0.7 }] }, { mode: 'adjust' })
  check(rs.ok, 'persona.revise', rs.ok ? `v${rs.persona.version}` : rs.error)

  const sv = s.saveSelfView('我剛開始記得一些事。', { actor: 'model' })
  check(sv.ok, 'selfView 寫入', sv.ok ? '' : sv.error)

  /* ── 4. 上限真的會擋 ── */
  line('4. 上限有沒有真的擋住')
  const overPersona = s.savePersona({ identity: 'x'.repeat(400) }, { mode: 'replace' })
  check(!overPersona.ok, `性格卡超過 ${M.PERSONA_MAX} 字被拒`, overPersona.ok ? '沒擋 ⚠️' : (overPersona.error || '').slice(0, 40))
  const overSelf = s.saveSelfView('y'.repeat(400))
  check(!overSelf.ok, `自我認知超過 ${M.SELF_VIEW_MAX} 字被拒`, overSelf.ok ? '沒擋 ⚠️' : (overSelf.error || '').slice(0, 40))

  /* ── 5. 作廢的：不注入、但搜得到 ── */
  line('5. 作廢的記憶：不進注入，但仍然搜得到')
  const w2 = s.writeMemory(
    { tier: 3, title: '他說他要戒菸', body: '他親口說的。', domain: 'other', dims: ['communication'], importance: 0.7 },
    { sessionId: 's-check', actor: 'model' },
  )
  s.voidMemory(w2.memory.id, { reason: '他後來又抽了，這句不成立' })
  const inj2 = s.injectionText()
  check(!inj2.includes('戒菸'), '作廢的不出現在注入')
  const found = s.recall({ query: '戒菸' })
  check(Array.isArray(found) && found.some((h) => h.id === w2.memory.id), '但 recall 搜得到')
  check(found.find((h) => h.id === w2.memory.id)?.voided === true, '而且帶 voided: true')

  /* ── 6. 主動開口的閘 ── */
  line('6. 主動開口：只剩谷時一道')
  s.valleyOf = (n) => inValley(n)
  s.cfg = { ...s.cfg, speak: true }
  const peakTime = (() => {
    const base = Date.parse('2026-11-19T00:00:00+08:00')
    for (let m = 0; m < 7 * 24 * 60; m += 5) {
      const t = base + m * 60000
      const d = new Date(t)
      if (d.getDay() !== 0 && d.getDay() !== 6 && !inValley(t).ok) return t
    }
    return null
  })()
  const gPeak = s.speakGate(peakTime)
  const gValley = s.speakGate(Date.parse('2026-11-19T21:00:00+08:00'))
  check(!gPeak.ok, '尖峰被擋', (gPeak.reasons || []).join('；'))
  check(gValley.ok, '谷時放行', (gValley.reasons || []).join('；') || '無阻擋')
  check(gValley.maxPerDay === undefined && gValley.gapHours === undefined, '沒有每日上限 / 冷卻欄位')

  const c2 = s.verify({ force: true })
  check(c2.ok, '整輪操作後鏈仍完好', `${c2.count} 筆`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

line(problems === 0 ? '全部通過' : `${problems} 項有問題`)
process.exit(problems === 0 ? 0 : 1)
