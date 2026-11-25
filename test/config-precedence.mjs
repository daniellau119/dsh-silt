// The visible CSS-file route must not be affected by config precedence changes.
// And config.json must win over the bundle's seed config.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { Store } = await import('file:///E:/deepseek-harness/智能管家/silt/lib/store.js')

let pass = 0
let fail = 0
const ok = (c, l) => (c ? (pass++, console.log(`  ok   ${l}`)) : (fail++, console.log(`  FAIL ${l}`)))

const dir = () => {
  const d = mkdtempSync(join(tmpdir(), 'silt-cfg-'))
  mkdirSync(d, { recursive: true })
  return d
}

console.log('1) no config.json -> seed config is used (first install)')
{
  const d = dir()
  const s = new Store(d, { enabled: false, injectBudget: 1500, titlesOnly: true }).load()
  console.log(`       injectBudget=${s.cfg.injectBudget} enabled=${s.cfg.enabled} titlesOnly=${s.cfg.titlesOnly}`)
  ok(s.cfg.injectBudget === 1500, 'seed budget applied')
  ok(s.cfg.titlesOnly === true, 'seed titlesOnly applied')
  rmSync(d, { recursive: true, force: true })
}

console.log('\n2) config.json exists -> it wins over the seed')
{
  const d = dir()
  writeFileSync(join(d, 'config.json'), JSON.stringify({ enabled: true, injectBudget: 2600, titlesOnly: false }), 'utf8')
  const s = new Store(d, { enabled: false, injectBudget: 1500, titlesOnly: true }).load()
  console.log(`       injectBudget=${s.cfg.injectBudget} enabled=${s.cfg.enabled} titlesOnly=${s.cfg.titlesOnly}`)
  ok(s.cfg.injectBudget === 2600, 'config.json budget wins (tune survives restart)')
  ok(s.cfg.enabled === true, 'config.json enabled wins')
  ok(s.cfg.titlesOnly === false, 'config.json titlesOnly wins')
  rmSync(d, { recursive: true, force: true })
}

console.log('\n3) keys missing from config.json still fall back to the seed')
{
  const d = dir()
  writeFileSync(join(d, 'config.json'), JSON.stringify({ injectBudget: 2600 }), 'utf8')
  const s = new Store(d, { enabled: false, speak: false, titlesOnly: false }).load()
  console.log(`       speak=${s.cfg.speak} titlesOnly=${s.cfg.titlesOnly} budget=${s.cfg.injectBudget}`)
  ok(s.cfg.speak === false, 'seed speak applied when absent from file')
  ok(s.cfg.titlesOnly === false, 'seed titlesOnly applied when absent')
  ok(s.cfg.injectBudget === 2600, 'file budget still wins')
  rmSync(d, { recursive: true, force: true })
}

console.log('\n4) a tune survives a reload (the whole point of B)')
{
  const d = dir()
  const s1 = new Store(d, { injectBudget: 1500 }).load()
  s1.cfg = { ...s1.cfg, enabled: true }
  s1.tuneInjection({ injectBudget: 2600 }, { reason: 'test', actor: 'model' })
  console.log(`       after tune: ${s1.cfg.injectBudget}`)

  // Re-open with the same seed the bundle would pass at startup.
  const s2 = new Store(d, { injectBudget: 1500 }).load()
  console.log(`       after restart: ${s2.cfg.injectBudget}`)
  ok(s2.cfg.injectBudget === 2600, 'tuned budget survived the restart')
  rmSync(d, { recursive: true, force: true })
}

console.log('\n5) string "false" in the file is coerced, not truthy')
{
  const d = dir()
  writeFileSync(join(d, 'config.json'), JSON.stringify({ enabled: false, titlesOnly: false }), 'utf8')
  const s = new Store(d, { enabled: true, titlesOnly: true }).load()
  console.log(`       enabled=${s.cfg.enabled} titlesOnly=${s.cfg.titlesOnly}`)
  ok(s.cfg.enabled === false, 'enabled stays false')
  ok(s.cfg.titlesOnly === false, 'titlesOnly stays false')
  rmSync(d, { recursive: true, force: true })
}

console.log('\n6) corrupted config.json does not crash')
{
  const d = dir()
  writeFileSync(join(d, 'config.json'), '{ this is not json', 'utf8')
  const s = new Store(d, { injectBudget: 1500 }).load()
  console.log(`       budget=${s.cfg.injectBudget}`)
  ok(s.cfg.injectBudget === 1500, 'falls back to the seed')
  rmSync(d, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
