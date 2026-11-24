// One memory, one "recall" per session — no matter how many times it is fetched.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_SILT_HOME = mkdtempSync(join(tmpdir(), 'silt-dedupe-'))
const { Store } = await import('file:///E:/deepseek-harness/智能管家/silt/lib/store.js')
const { salienceOf } = await import('file:///E:/deepseek-harness/智能管家/silt/lib/model.js')

let pass = 0
let fail = 0
const ok = (c, l) => (c ? (pass++, console.log(`  ok   ${l}`)) : (fail++, console.log(`  FAIL ${l}`)))

const s = new Store(process.env.DSH_SILT_HOME).load()
s.cfg = { ...s.cfg, enabled: true }

const mk = (title) =>
  s.writeMemory(
    { tier: 3, title, body: '內容'.repeat(80), domain: 'other', dims: ['personality'] },
    { actor: 'model', sessionId: 'creator', callId: 'c' },
  ).memory.id

const id = mk('測試記憶')
const rec = () => s.runtime.recalls[id] || {}

console.log('1) same session, five recalls -> scored once')
{
  for (let i = 0; i < 5; i++) s.recall({ query: '測試', limit: 5, sessionId: 'S1' })
  console.log(`       n=${rec().n} linger=${rec().linger} count=${rec().count}`)
  ok(rec().n === 1, `n stayed at 1 (got ${rec().n})`)
}

console.log('\n2) a different session scores again')
{
  s.recall({ query: '測試', limit: 5, sessionId: 'S2' })
  console.log(`       n=${rec().n}`)
  ok(rec().n === 2, `n is now 2 (got ${rec().n})`)
}

console.log('\n3) no sessionId -> old behaviour (counts every time)')
{
  const before = rec().n
  s.recall({ query: '測試', limit: 5 })
  s.recall({ query: '測試', limit: 5 })
  console.log(`       n ${before} -> ${rec().n}`)
  ok(rec().n === before + 2, 'two calls counted twice when no session')
}

console.log('\n4) deliberate still counts separately-but-once')
{
  const id2 = mk('第二條')
  const r2 = () => s.runtime.recalls[id2] || {}
  s.recall({ query: '第二條', limit: 5, sessionId: 'S3', deliberate: true })
  s.recall({ query: '第二條', limit: 5, sessionId: 'S3', deliberate: true })
  console.log(`       linger=${r2().linger} conf=${r2().conf}`)
  ok(r2().linger === 1, `linger counted once (got ${r2().linger})`)
}

console.log('\n5) a T4 cannot be promoted by repeat-fetching in one session')
{
  const id4 = s.writeMemory(
    { tier: 4, title: '碎屑', body: '也許有用', domain: 'other', dims: ['personality'] },
    { actor: 'model', sessionId: 'creator', callId: 'c' },
  ).memory.id
  for (let i = 0; i < 8; i++) s.recall({ query: '碎屑', limit: 5, sessionId: 'S9' })
  const stillT4 = s.memories.get(id4)
  console.log(`       tier after 8 fetches = ${stillT4?.tier}`)
  ok(stillT4?.tier === 4, 'T4 stayed T4 after 8 fetches in one session')
}

rmSync(process.env.DSH_SILT_HOME, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
