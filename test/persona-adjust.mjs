/**
 * test/persona-adjust.mjs — adjust 是增量，replace 才是整組換掉
 *
 * 2026-11-27：舊版 `normalizePersona` 對 traits / taste 一律「整組取代」。
 * 於是「只傳一條去調權重」會把另外幾條靜靜刪掉 —— `destructive` 有標，
 * 但已經寫進帳本，只能靠回滾救。這條釘住：adjust 不能吞掉沒提到的那幾條。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/store.js'

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

const dir = mkdtempSync(join(tmpdir(), 'silt-persona-'))
const store = new Store(dir).load()
store.cfg = { ...store.cfg, enabled: true }

const trait = (p, key) => (p.traits || []).find((t) => t.key === key)

console.log('1) adjust 只改一條，其他條要留著')
{
  store.persona = {
    version: 1,
    identity: '我是誰',
    voice: '短句',
    traits: [
      { key: 'A', value: '甲', weight: 0.5, bornOf: [], since: '2026-11-26T00:00:00.000Z' },
      { key: 'B', value: '乙', weight: 0.6, bornOf: [], since: '2026-11-26T00:00:00.000Z' },
    ],
    taste: [],
    revisedAt: null,
    revision: 0,
  }
  const r = store.savePersona({ traits: [{ key: 'A', value: '甲改', weight: 0.9 }] }, { mode: 'adjust', actor: 'model' })
  ok(r.ok, `adjust 成功（${r.error || ''}）`)
  eq(r.persona.traits.length, 2, '兩條都還在')
  eq(trait(r.persona, 'A')?.value, '甲改', 'A 被更新')
  eq(trait(r.persona, 'B')?.value, '乙', 'B 沒被吞掉')
  eq(r.destructive, false, '這不是破壞性修訂')
}

console.log('2) adjust 新增一條，舊的照樣在')
{
  const r = store.savePersona({ traits: [{ key: 'C', value: '丙', weight: 0.4 }] }, { mode: 'adjust', actor: 'model' })
  ok(r.ok, 'adjust 成功')
  eq(r.persona.traits.length, 3, '三條')
  ok(trait(r.persona, 'C'), 'C 加進去了')
  ok(trait(r.persona, 'A') && trait(r.persona, 'B'), 'A / B 還在')
}

console.log('3) replace 才是整組換掉')
{
  const r = store.savePersona({ traits: [{ key: 'Z', value: '最後', weight: 0.7 }] }, { mode: 'replace', actor: 'model' })
  ok(r.ok, 'replace 成功')
  eq(r.persona.traits.length, 1, '只剩一條')
  ok(trait(r.persona, 'Z'), 'Z 在')
  ok(!trait(r.persona, 'A'), 'A 被換掉了')
}

console.log('4) dropTraits 仍然可以明確刪')
{
  const r = store.savePersona({ dropTraits: ['Z'] }, { mode: 'adjust', actor: 'model' })
  ok(r.ok, 'dropTraits 成功')
  eq(r.persona.traits.length, 0, '空了')
}

rmSync(dir, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)