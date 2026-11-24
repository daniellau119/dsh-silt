/**
 * Silt/lib/routes.js — `/api/silt/*`
 * ---------------------------------------------------------------------------
 * 插件頁面（瀏覽器半端）與宿主半端之間唯一的通道。全部同源、只認本人（owner）。
 * 頁面上按的每一個鍵都在這裡落地：開關、底座、確認、回滾、導出、導入、現在值守一次。
 *
 * ⚠️ 用 Node 的 handler 形態（不是 resource）：資源型路由在 HTTP 上只答 GET / HEAD，
 *    這裡有一堆 POST，所以自己收 body、自己寫 header。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { injectionBreakdown } from './injection-breakdown.js'
import { slotsForBudget } from './model.js'

const json = (res, status, body, extra = {}) => {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v)
  res.end(JSON.stringify(body))
}

const fail = (res, error, status = 400) => json(res, status, { ok: false, error })

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = ''
    let over = false
    req.on('data', (chunk) => {
      if (over) return
      raw += chunk
      if (raw.length > 8 * 1024 * 1024) {
        over = true
        raw = ''
      }
    })
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        const value = JSON.parse(raw)
        resolve(value && typeof value === 'object' ? value : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })

/** 只接受本機同源：Host 必須是回環，Origin / Referer 有值時必須跟 Host 對得上（端口也比）。 */
const loopbackHost = (host) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(host || ''))

const sameOrigin = (req) => {
  const host = String(req.headers?.host || '')
  if (!host) return true // 沒有 Host 就不是瀏覽器發的
  if (!loopbackHost(host)) return false // 擋 DNS rebinding 這類把 Host 換成外面網域的玩法
  const pick = String(req.headers?.origin || req.headers?.referer || '')
  if (!pick) return true // 本機腳本 / 宿主內部
  try {
    const u = new URL(pick)
    const hostAuthority = host.toLowerCase()
    if (String(u.host || '').toLowerCase() === hostAuthority) return true
    const defaultPort = u.protocol === 'https:' ? '443' : '80'
    return `${u.hostname}:${u.port || defaultPort}`.toLowerCase() === hostAuthority
  } catch {
    return false
  }
}

/**
 * 信任柵欄：先問宿主的 `connection.requestRejection`（真正認 cookie / token），
 * 拿不到這個服務就退回「本機同源」這一道 —— 兩道都不成就是拒。
 */
export function makeFence(ctx, log = () => {}) {
  let conn
  let tried = false
  let warned = false
  const connection = () => {
    if (tried) return conn
    tried = true
    const probes = [
      () => (typeof ctx.get === 'function' ? ctx.get('connection') : null),
      () => Reflect.get(ctx, 'connection'),
      () => (ctx.root && typeof ctx.root === 'object' ? ctx.root.connection : null),
    ]
    for (const probe of probes) {
      try {
        const c = probe()
        if (c && typeof c.requestRejection === 'function') {
          conn = c
          return conn
        }
      } catch {
        /* 換下一種取法 */
      }
    }
    conn = null
    return null
  }

  const reject = (res, status) => {
    res.statusCode = status
    try {
      res.end()
    } catch {
      /* 已經結束了 */
    }
    return true
  }

  return (req, res) => {
    const c = connection()
    if (c) {
      try {
        const rejection = c.requestRejection({ headers: req.headers })
        if (rejection !== undefined) return reject(res, typeof rejection === 'number' ? rejection : 403)
      } catch (err) {
        log(`信任柵欄出錯，按不通過處理：${err?.message || err}`)
        return reject(res, 403)
      }
    } else if (!warned) {
      warned = true
      log('⚠️ 拿不到 connection.requestRejection ⇒ 只靠「本機同源」這一道')
    }
    if (!sameOrigin(req)) return reject(res, 403)
    return false
  }
}

/**
 * 頁面樣式：從 lib/style.css 讀，檔案一改就重讀（比對 mtime），不必重啟。
 * 這條路是為了繞開桌面前端打包把 CSS 字串丟掉的問題。
 */
let cssCache = { at: 0, text: '' }
function cssText() {
  const file = fileURLToPath(new URL('./style.css', import.meta.url))
  try {
    const st = statSync(file)
    if (st.mtimeMs !== cssCache.at) cssCache = { at: st.mtimeMs, text: readFileSync(file, 'utf8') }
    return cssCache.text
  } catch {
    return ''
  }
}

/**
 * 提示詞分層的資料源。
 *
 * 用 store 這一輪真正會送出去的那組參數（預算、性格卡、自我認知、活著的記憶、
 * 標題模式），交給 injection-breakdown 去量。
 *
 * 條數上限用 slotsForBudget —— 跟 store.injectionText() 同一條路，
 * 不要另外傳 cfg.injectCount（那邊早就改成由預算推導了）。
 */
function injectionOf(store) {
  const cfg = store.cfg || {}
  const budget = Number(cfg.injectBudget) || 1800
  return injectionBreakdown({
    cfg: { ...cfg, injectCount: slotsForBudget(budget) },
    foundation: store.foundation,
    persona: store.persona,
    selfView: store.selfView,
    memories: store.activeMemories(),
    budget,
    titlesOnly: cfg.titlesOnly !== false,
  })
}

/** 星圖只需要「夠畫出來」的資訊：位置由瀏覽器算，這裡給 id / 層級 / 維度 / 亮度 / 連線。 */function galaxyOf(store) {
  const active = store.activeMemories()
  const ids = new Set(active.map((m) => m.id))
  const nodes = active.map((m) => ({
    i: m.id,
    t: m.tier,
    ds: m.dims || [],
    s: Number((m.salience ?? 0).toFixed(3)),
    l: m.title,
    b: m.body,
    d: m.domain,
    a: m.archived ? 1 : 0,
    // 作廢的星在圖上要看得出來是被推翻過的，不是還在用的
    v: m.voided ? 1 : 0,
    at: m.bornAt,
  }))
  const edges = []
  for (const m of active) for (const from of m.compressedFrom || []) if (ids.has(from)) edges.push([m.id, from])
  for (const bond of [...(store.persona.traits || []), ...(store.persona.taste || [])]) {
    for (const src of bond.bornOf || []) if (ids.has(src)) edges.push([`bond:${bond.key}`, src])
  }
  return { nodes, edges, foundation: Boolean((store.foundation.text || '').trim()) }
}

export function makeRoutes({ store, duty, version = '1.0.0', log = () => {}, fence = () => false }) {
  return async function handler(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers?.host || '127.0.0.1'}`)
    // 前綴是小寫的 /api/silt —— 這裡的大小寫必須跟 index.js 註冊的 path 一致，
    // 否則剝不掉前綴，tail 會變成 'api/silt/state'，下面每個 if 都落空（全部 404）。
    const tail = url.pathname.replace(/^\/api\/silt\/?/, '').replace(/\/$/, '')
    const method = (req.method || 'GET').toUpperCase()

    if (fence(req, res)) return undefined

    try {
      if (method === 'GET' || method === 'HEAD') {
        if (tail === 'style.css') {
          // 桌面版的前端打包會把 CSS 字串整段丟掉，所以樣式由宿主在這裡供檔；
          // 頁面只掛一個 <link>，改 CSS 不必重裝插件。
          const css = cssText()
          res.statusCode = 200
          res.setHeader('content-type', 'text/css; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(method === 'HEAD' ? undefined : css)
          return true
        }
        if (tail === 'portrait') {
          // 她的形象照：本機的圖片檔，由這裡供出去（頁面只要 <img src="/api/silt/portrait">）。
          // 路徑固定放在 silt 家目錄下的 portrait.(jpg|png|webp) —— 換形象就是換那個檔。
          // ⚠️ 只認這三個副檔名，不讓路徑從外面傳進來（會變成任意檔案讀取）。
          const dir = store.home
          let buf = null
          let mime = ''
          for (const [ext, type] of [['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp']]) {
            try {
              const p = join(dir, `portrait.${ext}`)
              if (existsSync(p)) {
                buf = readFileSync(p)
                mime = type
                break
              }
            } catch {
              /* 換下一個 */
            }
          }
          if (!buf) return fail(res, '沒有形象照：放在 silt 家目錄的 portrait.jpg', 404)
          res.statusCode = 200
          res.setHeader('content-type', mime)
          res.setHeader('cache-control', 'no-store')
          res.end(method === 'HEAD' ? undefined : buf)
          return true
        }
        if (tail === 'state') {
          const state = store.state()
          let bili = null
          if (store.bili) {
            try {
              bili = await store.bili.status()
            } catch (err) {
              bili = { installed: false, error: String(err?.message || err), now: null }
            }
          }
          // 提示詞分層：量的是 store 這一輪真正會送出去的那段字。
          let injection = null
          try {
            injection = injectionOf(store)
          } catch (err) {
            injection = { error: String(err?.message || err) }
          }
          return json(res, 200, { ok: true, version, ...state, galaxy: galaxyOf(store), dutyInfo: duty.info(), bili, injection })
        }
        if (tail === 'export') {
          const bundle = store.exportBundle()
          const name = `silt-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`
          res.statusCode = 200
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('content-disposition', `attachment; filename="${name}"`)
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify(bundle, null, 2))
          return undefined
        }
        if (tail === 'ledger.export') {
          // 一鍵導出 = 把 ledger.jsonl 原樣交出去（字串不轉 JSON，一筆不差）
          const result = store.exportLedger()
          if (!result.ok) return fail(res, result.error, 409)
          const name = `ledger-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.jsonl`
          res.statusCode = 200
          res.setHeader('content-type', 'application/x-ndjson; charset=utf-8')
          res.setHeader('content-disposition', `attachment; filename="${name}"`)
          res.setHeader('cache-control', 'no-store')
          res.end(readFileSync(result.file, 'utf8'))
          return undefined
        }
        if (tail === 'ledger') {
          const n = Math.max(1, Math.min(400, Number(url.searchParams.get('tail') || 40)))
          return json(res, 200, { ok: true, chain: store.chain, records: store.records.slice(-n) })
        }
        return fail(res, `unknown endpoint GET ${tail}`, 404)
      }

      if (method !== 'POST') return fail(res, `method ${method} not allowed`, 405)

      const body = await readBody(req)
      if (tail === 'config') {
        const cfg = store.saveConfig(body.patch || body)
        if (!cfg.enabled && store.runtime.armed) await duty.disarm()
        store.duty = duty.info()
        return json(res, 200, { ok: true, cfg, dutyInfo: store.duty })
      }
      if (tail === 'ledger.export') {
        // 按鈕的另一半：不交給瀏覽器，直接寫一份到插件家目錄（ledger.export.jsonl）
        const result = store.exportLedger()
        return json(res, result.ok ? 200 : 409, result)
      }
      if (tail === 'ledger.import') {
        if (typeof body.text !== 'string' || !body.text.trim()) return fail(res, 'text（ledger.jsonl 的內容）是必需的')
        const result = store.importLedger(body.text, { actor: 'user', source: body.source || '' })
        if (result.ok) {
          try {
            await duty.disarm({ deleteRecord: true })
          } catch {
            /* 值守排程收不回來不影響導入 */
          }
          store.duty = duty.info()
        }
        return json(res, result.ok ? 200 : 400, result)
      }
      if (tail === 'foundation') {
        const result = store.setFoundation(typeof body.text === 'string' ? body.text : '')
        return json(res, 200, { ok: true, ...result })
      }
      if (tail === 'resolve') {
        if (!body.id) return fail(res, 'id is required')
        const result = store.resolvePending(body.id, Boolean(body.approve), { actor: 'user' })
        return json(res, result.ok ? 200 : 400, result)
      }
      if (tail === 'rollback') {
        if (!body.snapshotId) return fail(res, 'snapshotId is required')
        const result = store.rollback(body.snapshotId, { actor: 'user' })
        return json(res, result.ok ? 200 : 400, result)
      }
      if (tail === 'verify') {
        const chain = store.verify({ force: true })
        return json(res, 200, { ok: chain.ok, chain, records: store.records.length, bytes: store.ledgerBytes() })
      }
      if (tail === 'seal') {
        const result = store.sealChain(body.note || '', { actor: 'user' })
        return json(res, result.ok ? 200 : 500, result)
      }
      if (tail === 'import') {
        const count = Array.isArray(body.bundle?.memories) ? body.bundle.memories.length : 0
        const result = store.queue('import.bundle', { bundle: body.bundle }, { summary: `導入 ${count} 條記憶`, actor: 'user' })
        return json(res, 200, { ok: true, ...result })
      }
      if (tail === 'duty') {
        const result = await duty.arm({ force: Boolean(body.force), kinds: Array.isArray(body.kinds) ? body.kinds : undefined, wake: Boolean(body.wake) })
        return json(res, result.ok ? 200 : 400, result)
      }
      if (tail === 'reset') {
        if (body.confirm !== true) return fail(res, 'reset needs confirm:true', 400)
        const result = store.resetAll({ actor: 'user' })
        if (result.ok) {
          try {
            await duty.disarm({ deleteRecord: true })
          } catch {
            /* 值守排程收不回來不影響重置 */
          }
          store.duty = duty.info()
        }
        return json(res, result.ok ? 200 : 500, result)
      }
      if (tail === 'bili') {
        if (!store.bili) return fail(res, 'the B站 bridge is not available', 503)
        const result = await store.bili.status()
        return json(res, 200, { ok: true, ...result })
      }
      if (tail === 'disarm') {
        await duty.disarm()
        return json(res, 200, { ok: true })
      }
      return fail(res, `unknown endpoint POST ${tail}`, 404)
    } catch (err) {
      log(`/api/silt/${tail} 失敗：${err?.message || err}`)
      try {
        return fail(res, String(err?.message || err), 500)
      } catch {
        return undefined
      }
    }
  }
}
