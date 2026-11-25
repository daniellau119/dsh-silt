/**
 * dsh-silt · 心相 —— 宿主半端
 * ===========================================================================
 * 跨會話記憶、自進化性格與喜好；3D 星圖頁面在左側欄；谷時自主值守。
 *
 * 它做四件事：
 *   1. **記憶與人格的檔案**（`<DSH_HOME>/silt/ledger.jsonl`）：append-only、每筆帶
 *      sha256 串起的 `prev`/`hash`，記憶 / 人格 / 結構的改寫一律留 before/after 快照，
 *      可按快照 id 回滾。刪除、覆蓋、回滾、導入這一類不可逆動作只可以由本人確認。
 *   2. **注入**：把「現在的自己 + 仍記得的」壓成一段系統提示，每個會話都看得到。
 *   3. **工具**：recall / unseen / remember / void / condense / persona / archive /
 *      understanding / duty / inject / speak（見 lib/tools.js）。
 *   4. **谷時值守**：落在 DeepSeek 優惠時段才排一輪自主任務，交給 Harness 自己開會話去決定
 *      「要不要整理、要不要改自己」—— 決定不做也是有效決策。
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
 * 這一輪是不是「本人」推的 —— **不再由插件自己猜**。
 *
 * 2026-11-26 移除：舊版用 `ctx.get('agents')?.currentSession?.()?.messages`
 * 判斷，但 `agents` 是 AgentRegistry，服務契約上沒有 `currentSession()`；
 * Session 也沒有 `.messages`（它是 deriveMessages()）。探測永遠落空 ⇒ 永遠回 true，
 * 於是排程投遞也被當成本人，剛說出去的話立刻被記成「他回了」。
 *
 * 現在唯一可信的來源是宿主的 `api-session/activity`：它在
 * `event.type === 'user/message' && event.data.source.kind === 'user'` 時才發，
 * 排程投遞（source.kind === 'schedule'）不會觸發。見下面 apply() 的 listener。
 */

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
  // 工具讀狀態時要拿「現在」的，不是啟動那一拍的快照。store.duty 只在 tick 時更新，
  // 模型在尖峰/谷時邊界看到的會是舊的（valley / due 可能差上一拍）。
  store.dutyInfo = () => duty.info()
  // 谷時判斷只留在 duty 一處（跟值守同一組窗口）——
  // store 要用的時候向這裡拿，兩邊不會各有一套說法。
  store.valleyOf = (now) => inValley(now)
  
  /* ── 工具 ── */
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
              // 「這一輪是不是人推的」不在這裡判斷 —— 它由下面的
              // api-session/activity 事件寫進 store.noteHumanTurn()。
              return store.injectionText()
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

  /* ── 「本人最後親手說話的會話」與「他回話了」 ──
   * 日記和反思寫在這裡，不另開一個房間自言自語。
   *
   * 只有 `api-session/activity` 算數：它在 session-controller 裡的判據是
   *   event.type === 'user/message' && event.data.source.kind === 'user'
   * 排程投遞、agent 自己寫的、工具結果全被排除 —— 只有本人敲的那句話推進這個會話。
   *
   * 2026-11-26：**speak.ack 也接在這條**。舊版靠提示詞組裝時的
   * `hasHumanTurn` 判斷，但那個探測在這版 DSH 上永遠回 true，於是排程投遞
   * 一組裝提示詞，就把她剛說出去的話記成本人回話。api-session/activity
   * 只為 source.kind === 'user' 發，正好是「他親手敲的」。
   *
   * 不掛在 `session/event` 上是刻意的：那條是所有事件，得自己再篩一遍，
   * 篩錯了就會把自己發出去的東西當成他說的。
   */
  try {
    ctx.effect(
      () =>
        ctx.on('api-session/activity', (sessionId, updatedAt) => {
          store.noteHomeSession(sessionId, updatedAt)
          store.noteHumanTurn({ sessionId, source: 'activity' })
        }),
      'silt: home session',
    )
  } catch (err) {
    log(`「本人最後說話的會話」掛不上：${err?.message || err}`)
  }

  /* ── 谷時值守心跳 ──
   * 2026-11-26 本人：改成「對齊下一個固定反思鐘點」。
   *
   * 不再是 60 分鐘的固定 interval，而是一個單次 timer：
   *   · 有固定鐘點 → 下一次鐘點 +1 秒（留 1 秒讓 lastReflectionSlot 認得出它已過）；
   *   · 沒固定鐘點 → 下一次「上次反省 + 間隔」；
   *   · 上限 60 分鐘 —— 不管下一個鐘點多遠，至少每小時做 settle / 驗鏈 / 過期清理。
   * 每次 tick 完重排下一個；/config 改鐘點時 routes 會叫 store.dutyWake() 立即重排。
   */
  const DUTY_TICK_MS = 60 * 60_000 // 家務上限，也是 nextWakeAt 失效時的 fallback
  try {
    ctx.effect(() => {
      let alive = true
      let timer = null
      const beat = async () => {
        if (!alive) return
        try {
          await duty.tick()
        } catch (err) {
          log(`值守心跳出錯：${err?.message || err}`)
        }
        if (alive) schedule()
      }
      const schedule = () => {
        if (!alive) return
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        const now = Date.now()
        let at = now + DUTY_TICK_MS
        try {
          const next = duty.nextWakeAt(now)
          if (Number.isFinite(next)) at = next
        } catch {
          /* 算不出來就用 60 分鐘 fallback */
        }
        const delay = Math.max(1000, Math.min(at, now + DUTY_TICK_MS) - now)
        timer = setTimeout(beat, delay)
        timer.unref?.()
      }
      // 改設定（尤其 reflectionAt）之後不用等下一個鐘點
      store.dutyWake = () => {
        if (alive) schedule()
      }
      // 開機後 8 秒先補一拍（settle / 驗鏈 / 過期清理），之後才對齊
      const boot = setTimeout(beat, 8000)
      boot.unref?.()
      return () => {
        alive = false
        if (timer) clearTimeout(timer)
        clearTimeout(boot)
        store.dutyWake = null
      }
    }, 'silt: duty tick')
  } catch (err) {
    log(`值守心跳起不來：${err?.message || err}`)
  }

  log(`已掛載 · ${toolCount} 隻手 · 家目錄 ${home} · 記憶 ${store.memories.size} 條 · 總開關 ${store.cfg.enabled ? '開' : '關'}`)
}
