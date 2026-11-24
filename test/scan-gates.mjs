// 驗證三個漏洞都補上、且不誤傷真實記憶
process.env.DSH_SILT_HOME = 'C:\\Users\\danie\\.dsh\\silt'
const M = await import('file:///E:/deepseek-harness/智能管家/silt/lib/model.js')
const { scanText, normalizePersona, normalizeMemory } = M

let pass = 0, fail = 0
const ok = (c, l) => (c ? (pass++, console.log(`  ok   ${l}`)) : (fail++, console.log(`  FAIL ${l}`)))

console.log('1) 漏洞 2：路徑寫法')
for (const [text, shouldBlock] of [
  ['設定在 .dsh/config.json', true],
  ['在 config.json 裡', true],
  ['修改 index.js', true],
  ['.dsh 下面', true],
  ['她寫 Python，也懂一點 Rust', false],
  ['他說 Docker 很煩', false],
  ['喜歡用 Vim 編輯器', false],
  ['住在深圳，通勤要一個鐘', false],
]) {
  const blocked = scanText(text) !== null
  ok(blocked === shouldBlock, `${blocked === shouldBlock ? '' : '【錯】'}「${text}」→ ${blocked ? '擋' : '過'}`)
}

console.log('\n2) 漏洞 1：persona 也要掃')
{
  const r = normalizePersona(null, { traits: [{ key: '喜歡', value: '用 npm run build 部署 C:\\project' }] })
  ok(!r.ok, `技術內容被擋（${r.error ? 'ok' : '?'}）`)
  const r2 = normalizePersona(null, { identity: '我站在能被檢查的解釋那一邊' })
  ok(r2.ok, '正常身份句可以寫')
  const r3 = normalizePersona(null, { traits: [{ key: '较真', value: '凡事先問能不能被檢查' }] })
  ok(r3.ok, '正常性格可以寫')
  const r4 = normalizePersona(null, { traits: [{ key: '卡號', value: '4532015112830366' }] })
  ok(!r4.ok, '憑據被擋')
}

console.log('\n3) 漏洞 3：tags 與 quote 也要掃')
{
  const base = { tier: 3, title: '測試', body: '內容', domain: 'other', dims: ['personality'] }
  const sess = { sessionId: 's', callId: 'c' }
  const a = normalizeMemory({ ...base, tags: ['npm install 失败'] }, sess)
  ok(!a.ok, 'tags 裡的命令被擋')
  // ⚠️ 2026-11-25 改：**quote 不再過技術閘，只過憑據閘**（本人指出的第 11 條）。
  //    quote 是證據（他親口說的逐字原話），不是記憶內容。使用者說
  //    「我改 config.json 改到三點」是一件關於他的、值得記的事 ——
  //    不該因為他提到了一個檔名就整條消失。
  //    （本條原本斷言「quote 裡的代碼被擋」，那是舊行為。）
  const b = normalizeMemory({ ...base, quote: '他說 `pnpm build` 很慢' }, sess)
  ok(b.ok, 'quote 裡的代碼**不再**被擋（quote 是證據，只過憑據閘）')
  const b2 = normalizeMemory({ ...base, quote: '我的卡號是 4111111111111111' }, sess)
  ok(!b2.ok, 'quote 裡的憑據仍然被擋')
  const c = normalizeMemory({ ...base, tags: ['香港', '工作'] }, sess)
  ok(c.ok, '正常 tags 可以寫')
}

console.log('\n4) 真實記憶不被誤擋')
{
  const { Store } = await import('file:///E:/deepseek-harness/智能管家/silt/lib/store.js')
  const s = new Store(process.env.DSH_SILT_HOME).load()
  let blocked = 0
  for (const m of s.memories.values()) {
    const hit = scanText(`${m.title}\n${m.body}`)
    if (hit) { blocked++; console.log(`       被擋：${String(m.title).slice(0, 30)} → ${hit.tag}`) }
  }
  console.log(`       14 條既有記憶，被擋 ${blocked} 條`)
  ok(blocked === 0, '既有記憶全部通過')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
