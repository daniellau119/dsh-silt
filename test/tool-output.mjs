/**
 * 工具輸出的小檢查 —— 2026-11-25 本人 review 時翻到的幾處。
 *
 *   A. silt_inject read：原本有兩個同名 injectCount（一個讀 cfg、一個由預算推導，
 *      前者是死代碼）。JS 不報錯，後者靜默蓋掉前者。這裡直接檢查回傳物件的鍵。
 *   B. 同一隻手的 note 原本寫「<=500 chars」，但性格卡 + 自我認知的硬頂是 700。
 *      模型會同時讀到兩個數。
 *   C. 工具輸出的結構性截斷：超過 6000 字的記憶清單要「整條丟」並回報 truncated，
 *      而不是硬切字串產出壞掉的 JSON。
 *
 * 為什麼用測試而不是 lint：這個倉庫沒有 eslint，而為了一條 no-dupe-keys 拉整套依賴
 * 不划算。而且「重複鍵」這種事，測一次回傳物件的 key 比掃 AST 更直接、也更不會誤報。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'silt-toolshine-'))
const { Store } = await import('file:///E:/deepseek-harness/智能管家/silt/lib/store.js')

let pass = 0
let fail = 0
const ok = (c, l) => (c ? (pass++, console.log(`  ok   ${l}`)) : (fail++, console.log(`  FAIL ${l}`)))

const store = new Store(home).load()
store.cfg = { ...store.cfg, enabled: true }

console.log('A) silt_inject read 的回傳沒有重複鍵')
{
  // 這裡刻意**不靠 Object.keys 去重** —— 重複鍵在 JS 裡根本看不出來（後者直接覆蓋）。
  // 所以要直接看原始碼：**只看 `if (a.op === 'read')` 那個 return 物件**。
  // ⚠️ 不能整段掃：schema 的 `properties` 裡本來就有一個 `injectCount:`（參數定義），
  //    那是合法的、也是唯一的；掃整段會把它算進去，變成假警報。
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/tools.js', import.meta.url), 'utf8')
  const start = src.indexOf("name: 'silt_inject'")
  const end = src.indexOf("name: 'silt_speak'")
  assert.ok(start > 0 && end > start, '找不到 silt_inject 那一段')
  const block = src.slice(start, end)

  const readAt = block.indexOf("a.op === 'read'")
  assert.ok(readAt > 0, "找不到 read 分支")
  // read 分支到 tune 分支之間，就是那個回傳物件
  const tuneAt = block.indexOf("a.op === 'tune'", readAt)
  assert.ok(tuneAt > readAt, '找不到 tune 分支（read 分支的結尾）')
  const readBlock = block.slice(readAt, tuneAt)

  const count = (readBlock.match(/^\s*injectCount\s*:/gm) || []).length
  ok(count === 1, `read 的回傳物件裡 injectCount 只出現 1 次（實際 ${count}）`)
  ok(readBlock.includes('injectCountSetting'), '保留 injectCountSetting（舊存值，看得出差異）')
  ok(readBlock.includes('slotsForBudget'), '生效值是由預算推導的那個')
}

console.log('\nB) 700 字的口徑一致（不再有 500）')
{
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/tools.js', import.meta.url), 'utf8')
  ok(!src.includes('<=500 chars'), '沒有殘留 "<=500 chars"')
  ok(src.includes('<=700 chars'), 'note 寫的是 700')
  const model = readFileSync(new URL('../lib/model.js', import.meta.url), 'utf8')
  ok(model.includes('INJECT_PERSONA_MAX = 700'), '硬頂常數是 700')
}

console.log('\nC) injectCount 的說法一致（不再有「調小才有效」）')
{
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/tools.js', import.meta.url), 'utf8')
  // ⚠️ 只看「活的字串」—— 我加的說明註解裡會引用那句舊話（說明刪掉了什麼），
  //    那種引用不該被判成還在。所以先按行過濾掉以 // 開頭的行。
  const live = src
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n')
  ok(!live.includes('只有在你刻意想少放幾條時才調小'), '刪掉了「調小才有效」那句')
  ok(live.includes('它已由預算推導，調了不會生效'), '改成「調了不會生效」，跟 patch 描述一致')
}

console.log('\nD) 超長記憶清單：結構性截斷，JSON 仍然合法')
{
  // 用假的 render 邏輯測（真正的 renderOutput 不是具名導出，行為等價）
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/tools.js', import.meta.url), 'utf8')
  const start = src.indexOf('const OUTPUT_CAP')
  const end = src.indexOf('const text = (value) => renderOutput(value)')
  assert.ok(start > 0 && end > start, '找不到 renderOutput')
  const renderOutput = new Function(`${src.slice(start, end)}\nreturn renderOutput`)()
  const mems = Array.from({ length: 30 }, (_, i) => ({ id: `m-${i}`, title: `标题${i}`, body: '正文'.repeat(300) }))
  const out = renderOutput({ memories: mems })
  let parsed
  try {
    parsed = JSON.parse(out[0].text)
  } catch (err) {
    ok(false, `輸出不是合法 JSON：${err.message}`)
  }
  if (parsed) {
    ok(true, '輸出是合法 JSON（沒有切在字串中間）')
    ok(parsed.memories.length < 30 && parsed.memories.length > 0, `只保留了一部分（${parsed.memories.length} / 30）`)
    ok(parsed.memories.every((m) => m && typeof m.id === 'string'), '保留的每一條都是完整物件')
    ok(typeof parsed.truncated === 'number' && parsed.truncated > 0, '回報了 truncated 條數')
    ok(String(parsed.note || '').includes('沒列出'), '附了一句話告訴模型怎麼拿剩下來的')
  }

  // 短結果原樣回傳，不加 truncated
  const small = renderOutput({ memories: [mems[0]] })
  const sp = JSON.parse(small[0].text)
  ok(sp.memories.length === 1 && sp.truncated === undefined, '短結果不做任何截斷')
}

console.log('\nE) standing 真的在回傳裡（store 有產出）')
{
  const id = store.writeMemory(
    { tier: 3, title: 'standing 檢查', body: '這條只要確認 recall 有沒有帶 standing', domain: 'other', dims: ['personality'] },
    { sessionId: 'sess-sh', callId: 'c1' },
  ).memory.id
  const hits = store.recall({ query: 'standing', limit: 5, sessionId: 'sess-sh' })
  const hit = hits.find((h) => h.id === id)
  ok(Boolean(hit), '搜得到剛寫的那條')
  ok(Boolean(hit?.standing), '每條帶 standing')
  ok(typeof hit?.standing?.basis === 'string' || typeof hit?.standing?.risk === 'string', 'standing 裡有 basis / risk')
}

rmSync(home, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
