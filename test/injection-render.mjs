/**
 * 注入渲染與測量的缺陷 —— 2026-11-25 第四輪 review 的 A、C、D 組。
 *
 * 這批的共同點：**量到的東西跟真正送出去的不是同一串**，
 * 或者**宣稱的閘其實沒接上**。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'silt-inject-'))
const M = await import('file:///E:/deepseek-harness/智能管家/silt/lib/model.js')
const { Store } = await import('file:///E:/deepseek-harness/智能管家/silt/lib/store.js')
const { injectionBreakdown } = await import('file:///E:/deepseek-harness/智能管家/silt/lib/injection-breakdown.js')

let pass = 0
let fail = 0
const ok = (c, l) => (c ? (pass++, console.log(`  ok   ${l}`)) : (fail++, console.log(`  FAIL ${l}`)))

const mkMem = (i, tier = 3) => ({
  id: `m-${i}`,
  tier,
  title: `第 ${i} 條記憶標題`,
  body: '正文'.repeat(20),
  firstSeen: '2026-11-20',
  salience: 1 - i * 0.01,
  importance: 0.5,
})

console.log('A1) renderInjection 的條數由預算算，不讀 cfg.injectCount')
{
  const memories = Array.from({ length: 40 }, (_, i) => mkMem(i))
  // cfg.injectCount 刻意設成 5 —— 如果渲染還讀它，就只會出現 5 條
  const txt = M.renderInjection({
    cfg: { enabled: true, injectCount: 5 },
    foundation: '',
    persona: null,
    selfView: null,
    memories,
    budget: 3000,
    titlesOnly: true,
  })
  const shown = (txt.match(/^- T\d/gm) || []).length
  ok(shown > 5, `cfg.injectCount=5 但預算 3000 ⇒ 顯示 ${shown} 條（應該 > 5）`)
  ok(shown <= M.slotsForBudget(3000), `不超過 slotsForBudget(3000) = ${M.slotsForBudget(3000)}`)
}

console.log('\nA1b) slotsForBudget 非法輸入回預設小值，不是最大值')
{
  ok(M.slotsForBudget(NaN) === M.INJECT_TUNABLES.injectCount.min, `NaN ⇒ min（實際 ${M.slotsForBudget(NaN)}）`)
  ok(M.slotsForBudget(0) === M.INJECT_TUNABLES.injectCount.min, `0 ⇒ min（實際 ${M.slotsForBudget(0)}）`)
  ok(M.slotsForBudget(-100) === M.INJECT_TUNABLES.injectCount.min, `負數 ⇒ min（實際 ${M.slotsForBudget(-100)}）`)
  ok(M.slotsForBudget(3200) === 64, `3200 ⇒ 64（實際 ${M.slotsForBudget(3200)}）`)
}

console.log('\nA2) breakdown 的 titlesOnly 從 cfg 推，不從參數')
{
  const memories = [mkMem(1)]
  const common = { cfg: { enabled: true, titlesOnly: true }, foundation: '', persona: null, selfView: null, memories, budget: 1800 }
  const b = injectionBreakdown(common)
  // 標題模式：記憶行不該帶長正文
  const memLine = (b.rows || [])[0]
  ok(Boolean(memLine), '拆出一條記憶')
  // 傳「錯誤的」titlesOnly 參數也不該影響 —— 簽名已不再收它
  const b2 = injectionBreakdown({ ...common, titlesOnly: false })
  ok(b.used === b2.used, `就算外面傳 titlesOnly:false 也不受影響（${b.used} vs ${b2.used}）`)
}

console.log('\nA3) T5 到期邊界：當天仍有效，隔天才過期')
{
  const exp = M.resolveForecastExpiry('2026-11-25')
  ok(String(exp).includes('+08:00'), `解析成 +08:00（實際 ${exp}）`)
  const mem = { tier: 5, expiresAt: exp }
  // 2026-11-25 東八區 23:59 = 2026-11-25T15:59Z → 還沒過期
  ok(!M.isDue(mem, Date.parse('2026-11-25T15:59:00Z')), '當天 23:59（東八區）仍然有效')
  // 2026-11-26 東八區 00:01 = 2026-11-25T16:01Z → 過期
  ok(M.isDue(mem, Date.parse('2026-11-25T16:01:00Z')), '隔天 00:01（東八區）才過期')
  // 舊行為會在當天早上 08:00 就判過期
  ok(!M.isDue(mem, Date.parse('2026-11-25T00:30:00Z')), '當天 08:30（東八區）不再被誤判過期')
}

console.log('\nA3b) 「今天面試」可以寫成 T5（舊版被拒）')
{
  const s = new Store(home).load()
  s.cfg = { ...s.cfg, enabled: true }
  // 今天是 2026-11-25（測試環境用當天），寫今天到期
  const today = M.toLocal(new Date().toISOString(), { dateOnly: true })
  const r = s.writeMemory(
    { tier: 5, title: '今天面試', body: '他說今天面試', domain: 'person', dims: ['background'], expiresAt: today },
    { sessionId: 's', callId: 'c' },
  )
  ok(r.ok === true, `寫「今天」到期不再被拒（${r.ok ? 'ok' : r.error}）`)
}

console.log('\nA4) 註腳數字要反映讓位之後的真實結果')
{
  // 造一個剛好超一點的預算：讓位迴圈會丟掉一兩條
  const memories = Array.from({ length: 30 }, (_, i) => mkMem(i))
  const txt = M.renderInjection({
    cfg: { enabled: true },
    foundation: '',
    persona: null,
    selfView: null,
    memories,
    budget: 900,
    titlesOnly: true,
  })
  const m = txt.match(/另有 (\d+) 條沒顯示/)
  ok(Boolean(m), '有註腳')
  const claimed = Number(m?.[1] || 0)
  const shown = (txt.match(/^- T\d/gm) || []).length
  const total = memories.length
  ok(claimed + shown === total || claimed <= total, `顯示 ${shown} + 另有 ${claimed} = ${shown + claimed}，總數 ${total}（不能少報）`)
  ok(claimed >= total - shown, `另有 ${claimed} 不能少於實際沒顯示的 ${total - shown} 條`)
}

console.log('\nA5) persona 塊：不硬切、<700 字、加總對得上')
{
  const bonds = Array.from({ length: 24 }, (_, i) => ({ key: `特質${i}`, value: '這是一個關於我的描述'.repeat(2), weight: 50 }))
  const persona = { identity: '我叫汐', voice: '說話短', traits: bonds, taste: [] }
  const txt = M.renderInjection({ cfg: { enabled: true }, foundation: '', persona, selfView: { text: '我是誰的說明'.repeat(20) }, memories: [], budget: 1800, titlesOnly: true })
  // 2026-11-26：取 persona 塊時從標題後面開始，避免把前面的系統命令算進來。
  const who = (txt.split('【自我認知】')[1] || '').split('【仍記得的】')[0].trim()
  ok(who.length <= M.INJECT_PERSONA_MAX, `persona 塊 ${who.length} 字 ≤ ${M.INJECT_PERSONA_MAX}`)
  // 每一行都是完整的：內容只可能是那幾個**原文**之一（含它的重複），
  // 不會出現「描述被切一半」的殘句。
  const lines = who.split('\n').filter((l) => l.startsWith('- '))
  ok(lines.length > 0, `有 ${lines.length} 行`)
  const unit = '這是一個關於我的描述'
  const broken = lines.filter((l) => {
    const t = l.slice(2)
    if (t === '我叫汐' || t === '說話短') return false
    if (t.startsWith('特質') && /^特質\d+：/.test(t)) {
      const body = t.replace(/^特質\d+：/, '')
      // 必須是 unit 的整數次重複
      return body.length === 0 || body.length % unit.length !== 0 || body !== unit.repeat(body.length / unit.length)
    }
    return true // 認不出來的行，也算可疑
  })
  ok(broken.length === 0, `沒有被切半句的行${broken.length ? `（壞行：${broken.slice(0, 2).join(' | ')}）` : ''}`)
}

console.log('\nA5b) breakdown 的量跟真實字串對得上')
{
  const memories = [mkMem(1), mkMem(2)]
  const persona = { identity: '我叫汐', voice: '說話短', traits: [{ key: 'A', value: '甲的描述', weight: 1 }], taste: [] }
  const b = injectionBreakdown({ cfg: { enabled: true, titlesOnly: true }, foundation: '', persona, selfView: { text: '自我認知內容' }, memories, budget: 1800 })
  ok(b.residual !== undefined, `有 residual 欄位（${b.residual}）`)
  ok(Math.abs(b.residual) < 30, `沒掃乾淨的字數很小（${b.residual}字，允許少量換行誤差）`)
}

console.log('\nC11) quote 只過憑據閘，不過技術閘')
{
  const base = { tier: 3, title: '他加班到很晚', body: '他說那天改東西改到凌晨三點', domain: 'other', dims: ['personality'] }
  const sess = { sessionId: 's', callId: 'c' }
  const a = M.normalizeMemory({ ...base, quote: '我改 config.json 改到三點' }, sess)
  ok(a.ok === true, 'quote 提到 config.json 不再被整條拒掉')
  const b = M.normalizeMemory({ ...base, quote: '我的卡號是 4111111111111111' }, sess)
  ok(b.ok === false, 'quote 裡的憑據仍然被擋')
}

console.log('\nB7) importance 低於該層門檻要被拒')
{
  const sess = { sessionId: 's', callId: 'c' }
  const bad = M.normalizeMemory({ tier: 1, title: '測試事實', body: '一條重要性很低的事實', domain: 'person', dims: ['background'], importance: 0.1 }, sess)
  ok(bad.ok === false, 'importance 0.1 的 T1 被拒（門檻 0.9）')
  const good = M.normalizeMemory({ tier: 1, title: '測試事實', body: '一條重要性很高的事實', domain: 'person', dims: ['background'], importance: 0.95 }, sess)
  ok(good.ok === true, 'importance 0.95 的 T1 可以寫')
}

console.log('\nB8) tier 非法時報錯，不靜默當 3')
{
  const sess = { sessionId: 's', callId: 'c' }
  const r = M.normalizeMemory({ title: '沒有 tier', body: '這條沒有給 tier', domain: 'other', dims: ['personality'] }, sess)
  ok(r.ok === false, '沒給 tier 被拒（舊版會靜默當 3）')
  const r2 = M.normalizeMemory({ tier: 9, title: '錯的 tier', body: 'tier 是 9', domain: 'other', dims: ['personality'] }, sess)
  ok(r2.ok === false, 'tier 9 被拒')
}

rmSync(home, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
