/**
 * dsh-silt · 心相 —— 宿主半端
 * ===========================================================================
 * 跨會話記憶、自進化性格與喜好；3D 星圖頁面在左側欄；谷時自主值守。
 *
 * 它做四件事：
 *   1. **記憶與人格的檔案**（`<DSH_HOME>/silt/ledger.jsonl`）：append-only、每筆帶
 *      sha256 串起的 `prev`/`hash`，記憶 / 人格 / 結構的改寫一律留 before/after 快照，
 *      可按快照 id 回滾。刪除、覆蓋、回滾、導入這一類不可逆動作只可以由本人確認。
 *   2. **注入**：把「現在的自己 + 仍記得的 + 還不明白的」壓成一段系統提示，每個會話都看得到。
 *   3. **七隻手**：silt_recall / remember / revise / shape / persona / archive / duty。
 *   4. **谷時值守**：落在 DeepSeek 優惠時段才排一輪自主任務，交給 Harness 自己開會話去決定
 *      「要不要刷 B站、要不要整理、要不要改自己」—— 決定不做也是有效決策。
 *
 * 硬性界線（本檔與 lib/ 一起釘死）：代碼 / 技術決策 / 環境配置不入記憶；不記身份證與信用卡；
 * 記憶不能捏造（每筆都釘著寫入時的會話作為證據）；任何改寫都不可靜默抹除。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './lib/store.js'
import { buildTools } from './lib/tools.js'
import { makeDuty, inValley } from './lib/duty.js'
import { makeBili } from './lib/bili.js'
import { makeFence, makeRoutes } from './lib/routes.js'

export const name = 'silt'
export const inject = ['tools', 'systemPrompt', 'webServer']

const HERE = dirname(fileURLToPath(import.meta.url))

const versionOf = () => {
  try {
    return JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version || '1.0.0'
  } catch {
    return '1.0.0'
  }
}

/**
 * 插件家目錄：`<DSH_HOME>/silt`。
 *
 * 覆寫順序（越前面越優先）：
 *   1. `DSH_SILT_HOME` —— 測試用。指到臨時目錄，免得跑測試寫壞真帳本。
 *   2. 宿主給的 dshHomePath
 *   3. DSH_HOME 或 ~/.dsh 底下
 *
 * ⚠️ 為什麼要有第 1 項：store 的寫入路徑（tune / remember / void…）是真的會
 *    append 到 ledger.jsonl 的。測試要是只「讀」沒關係，但一旦碰到寫入，
 *   就會污染本人的記憶 —— 而且帳本是哈希鏈，刪記錄要重算，代價很高。
 */
function resolveHome(ctx) {
  const override = String(process.env.DSH_SILT_HOME || '').trim()
  if (override) return override
  try {
    const p = ctx.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p('silt')
      if (v) return String(v)
    } else if (typeof p === 'string' && p) {
      return join(p, 'silt')
    }
  } catch {
    /* 拿不到就走下面的兜底 */
  }
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'silt')
}

/**
 * 這一輪是不是「本人」推的。
 *
 * 排程投遞（值守、主動開口）開的輪次同樣會讓系統提示求值，但那不是他在，
 * 不能拿來當「他正在用」的證據 —— 否則她會把自己發出去的訊息誤當成自己的回話，
 * 冷卻永遠重置不完。認得出就排除，認不出（拿不到 agent）就當作是。
 */
function hasHumanTurn(ctx) {
  try {
    const agent = ctx.get?.('agents')
    const msgs = agent?.currentSession?.()?.messages
    if (!Array.isArray(msgs)) return true
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const m = msgs[i]
      if (m?.role !== 'user') continue
      return m?.source?.kind !== 'schedule'
    }
  } catch {
    /* 拿不到就當作是本人 —— 寧可多算一次，也不要她把自己的訊息當成回話 */
  }
  return true
}

export function apply(ctx, config) {
  const home = resolveHome(ctx)
  const log = (msg) => {
    try {
      if (ctx.logger?.info) ctx.logger.info(`[silt] ${msg}`)
      else console.log(`[silt] ${msg}`)
    } catch {
      /* 日誌不該影響任何東西 */
    }
  }

  const store = new Store(home, config && typeof config === 'object' ? config : {})
  store.load()
  const duty = makeDuty({ ctx, store, log })
  store.duty = duty.info()
  // 谷時判斷只留在 duty 一處（跟值守同一組窗口）——
  // store 要用的時候向這裡拿，兩邊不會各有一套說法。
  store.valleyOf = (now) => inValley(now)
  // 「允許它自己調用刷B站」的橋：這頁只給許可，刷不刷與那些參數由它自己判斷
  store.bili = makeBili({ store, webServer: ctx.get ? ctx.get('webServer') : undefined, log })

  /* ── 七隻手 ── */
  let toolCount = 0
  try {
    for (const definition of buildTools(store, { speak: (req) => duty.speak(req) })) {
      ctx.effect(() => ctx.tools.register(definition, { when: () => Boolean(store.cfg.enabled) }), `silt: ${definition.name}`)
      toolCount += 1
    }
  } catch (err) {
    log(`工具註冊失敗：${err?.message || err}`)
  }

  /* ── 注入（每個會話的系統提示尾巴） ── */
  try {
    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: 'silt',
          order: 850,
          text: () => {
            try {
              // humanTurn: 只有人的訊息在推這一輪時才算「他在」。
              // 排程投遞（值守 / 主動開口）同樣會開一輪，但那不是他 —— 用 source 分辨。
              return store.injectionText({ humanTurn: hasHumanTurn(ctx) })
            } catch (err) {
              return ''
            }
          },
        }),
      'silt: persona & memory injection',
    )
  } catch (err) {
    log(`注入註冊失敗：${err?.message || err}`)
  }

  /* ── 插件頁面用的 HTTP 通道 ── */
  try {
    const fence = makeFence(ctx, log)
    const handler = makeRoutes({ store, duty, version: versionOf(), log, fence })
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/api/silt', handler }), 'silt: /api/silt')
  } catch (err) {
    log(`HTTP 路由掛不上：${err?.message || err}`)
  }

  /* ── 「本人最後親手說話的會話」 ──
   * 日記和反思寫在這裡，不另開一個房間自言自語。
   *
   * 只有 `api-session/activity` 算數：它在 session-controller 裡的判據是
   *   event.type === 'user/message' && event.data.source.kind === 'user'
   * 排程投遞、agent 自己寫的、工具結果全被排除 —— 只有本人敲的那句話推進這個會話。
   *
   * 不掛在 `session/event` 上是刻意的：那條是所有事件，得自己再篩一遍，
   * 篩錯了就會把自己發出去的東西當成他說的。
   */
  try {
    ctx.effect(
      () =>
        ctx.on('api-session/activity', (sessionId, updatedAt) => {
          store.noteHomeSession(sessionId, updatedAt)
        }),
      'silt: home session',
    )
  } catch (err) {
    log(`「本人最後說話的會話」掛不上：${err?.message || err}`)
  }

  /* ── 谷時值守心跳 ──
   * 60 分鐘一拍（原本 120 秒）。
   *
   * 為什麼敢放到這麼鬆：這個心跳要做的判斷全是「日級」的 ——
   * 反省到期 24 小時、B站到期 20 小時、待確認 7 天過期。
   * 60 分鐘的粒度對這些節律完全夠，而每一拍都要寫一次 runtime.json（lastTickAt），
   * 120 秒等於一天寫 720 次，純粹是白寫。
   *
   * 唯一對延遲敏感的是 settle()（上一輪值守排程收尾），但它真的不要緊：
   *   最壞情況只是「armed 還指著上一輪 ⇒ 這段時間不會起新值守」，
   *   而 settle() 自己有保底 —— 超過 60 分鐘一律放掉，不管排程有沒有真的結束。
   *   起一輪值守的節律本來就是「一天一兩次」，多等一小時看不出來。
   */
  const DUTY_TICK_MS = 60 * 60_000
  try {
    ctx.effect(() => {
      let alive = true
      const beat = () => {
        if (!alive) return
        duty.tick().catch((err) => log(`值守心跳出錯：${err?.message || err}`))
      }
      const timer = setInterval(beat, DUTY_TICK_MS)
      timer.unref?.()
      // 開機後 8 秒補一拍：這個 timer 也要收得回來，否則插件卸載後它還會再叫一次
      const boot = setTimeout(beat, 8000)
      boot.unref?.()
      return () => {
        alive = false
        clearInterval(timer)
        clearTimeout(boot)
      }
    }, 'silt: duty tick')
  } catch (err) {
    log(`值守心跳起不來：${err?.message || err}`)
  }

  log(`已掛載 · ${toolCount} 隻手 · 家目錄 ${home} · 記憶 ${store.memories.size} 條 · 總開關 ${store.cfg.enabled ? '開' : '關'}`)
}
