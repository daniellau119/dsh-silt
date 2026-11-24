/**
 * Silt/lib/duty.js — 「token 谷時」的自主任務節律
 * ---------------------------------------------------------------------------
 * 谷時＝DeepSeek 的優惠時段：中午 12:00–14:00、晚上 18:00–次日 09:00（東八區），週末全天。
 * 只有落在谷時、而且確實有事到期，才起一輪值守；起一輪＝排一個一次性任務，交給 Harness
 * 自己開一個新會話去決定（是否刷 B站、要不要整理、要不要改自己，都由那一輪自己決定）。
 *
 * 「不需要改」是有效決策 —— 所以值守會話可能甚麼都不做，那不算失敗。
 */
import { DEFAULT_TIER4_TTL_HOURS, TIERS, nowIso, oneLine, ageDays, toLocal } from './model.js'

export const VALLEY_WINDOWS = [
  { key: 'noon', label: '中午谷時', start: 12 * 60, end: 14 * 60 },
  { key: 'night', label: '晚間谷時', start: 18 * 60, end: 9 * 60 },
]

const CST_OFFSET_MIN = 8 * 60

/**
 * 「本人最後親手說話的那個會話」——日記和反思要寫在那裡。
 *
 * 為什麼不是「正在說話的那個」：DSH 沒有那種接口。事件表裡只有通知，
 * 沒有「人現在在看哪個會話」。能做到的最接近的一步是：
 *
 *   dsh-api-session-controller/src/index.ts:243
 *     ctx.on('session/event', (session, event) => {
 *       if (event.type !== 'user/message' || event.data.source.kind !== 'user') return
 *       ctx.emit('api-session/activity', session.id, event.time)
 *     })
 *
 * 兩個條件都要中：消息事件、而且 source.kind === 'user'。排程投遞、
 * agent 自己寫的、工具結果，一律不算 —— 只有本人真的敲了一句話才計。
 *
 * `lastSpokeSession` 不能用：那是我上次開口投遞的會話，是「我說的」，
 * 不是「他說的」。日記該跟著他走。
 */
const HOME_MAX_AGE_MS = 18 * 3600 * 1000

function rememberHome(store) {
  const h = store.runtime?.homeSession
  if (!h?.sessionId || !h.at) return ''
  // 太久沒說話 / 時間戳壞掉 → 當作沒有，退回 new_once，不硬塞進舊對話
  if (!Number.isFinite(Number(h.at))) return ''
  if (Date.now() - Number(h.at) > HOME_MAX_AGE_MS) return ''
  return String(h.sessionId)
}

function cstClock(now = Date.now()) {
  const t = new Date(now + (CST_OFFSET_MIN + new Date(now).getTimezoneOffset()) * 60000)
  return { minutes: t.getHours() * 60 + t.getMinutes(), weekday: t.getDay(), iso: t.toISOString() }
}

export function inValley(now = Date.now()) {
  const { minutes, weekday } = cstClock(now)
  if (weekday === 0 || weekday === 6) return { ok: true, window: 'weekend', label: '週末全天谷時' }
  for (const w of VALLEY_WINDOWS) {
    const hit = w.start <= w.end ? minutes >= w.start && minutes < w.end : minutes >= w.start || minutes < w.end
    if (hit) return { ok: true, window: w.key, label: w.label }
  }
  return { ok: false, window: null, label: '尖峰時段' }
}

/**
 * 谷時窗口的「身份」—— 保留給未來用，但目前**不參與節律判斷**。
 *
 * 2026-11-21 的決定：節律回到「每隔 N 小時到期、每天最多 M 輪」，不受窗口切割影響。
 * 中間試過「每個谷時窗口醒一次」，是錯的 —— 那會讓白天也在跑，
 * 而他真正要的是「一天 4 次」（24 ÷ 6），尖峰自然不跑，但次數要由間隔決定，不是窗口。
 * 這個函式留著是因為它算得對（跨午夜那半截歸前一天），以後要按窗口算時還能用上。
 */
export function valleySlot(now = Date.now()) {
  const { minutes, weekday, iso } = cstClock(now)
  const day = iso.slice(0, 10)
  if (weekday === 0 || weekday === 6) return `${day}:weekend`
  for (const w of VALLEY_WINDOWS) {
    const hit = w.start <= w.end ? minutes >= w.start && minutes < w.end : minutes >= w.start || minutes < w.end
    // 晚間窗口跨午夜：00:00–09:00 那半截屬於「前一天開的那個窗口」，
    // 所以它的身份要用前一天 —— 不然一個夜裡會被切成兩半、醒兩次。
    if (!hit) continue
    if (w.start > w.end && minutes < w.end) return `${shiftDay(day, -1)}:${w.key}`
    return `${day}:${w.key}`
  }
  return null
}

const shiftDay = (day, delta) => {
  const t = Date.parse(`${day}T00:00:00Z`)
  return new Date(t + delta * 86400000).toISOString().slice(0, 10)
}

const hoursSince = (iso, now = Date.now()) => {
  const t = Date.parse(iso || '')
  return Number.isFinite(t) ? (now - t) / 3600000 : Number.POSITIVE_INFINITY
}

const todayKey = (now = Date.now()) => new Date(now).toISOString().slice(0, 10)

/**
 * 固定鐘點：解析 `['19:00','07:00']` 這種寫法，回傳當天實際要踩的時刻（毫秒）。
 *
 * 為什麼要有這個：`reflectionEveryHours` 算的是「距上次滿 N 小時」，因此每一輪的
 * 鐘點會一直漂 —— 今天 18:36 跑完，下一輪 06:36；機器關一次機，整個相位就
 * 往後滑，再也回不到本來的點上。他要的是**每天的鐘點固定**，所以另開一路。
 *
 * 寫法故意只收 `HH:MM`（東八區）：沒有 cron 的全套語法，因為這裡要的只是
 * 「一天裡哪幾個點」，而多一個語法面就多一個猜錯的地方。
 */
export function parseReflectionAt(spec) {
  if (!Array.isArray(spec) || spec.length === 0) return []
  const out = []
  for (const raw of spec) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw ?? '').trim())
    if (!m) continue
    const h = Number(m[1])
    const min = Number(m[2])
    if (!(h >= 0 && h < 24 && min >= 0 && min < 60)) continue
    out.push(h * 60 + min)
  }
  return [...new Set(out)].sort((a, b) => a - b)
}

/**
 * 最近一個「應該已經踩過」的鐘點，回傳它的時刻（毫秒）；沒有設定就回 undefined。
 *
 * 用「已經踩過」而不是「下一次」：判斷用的是 `now >= 該鐘點`，這樣一輪跑完，
 * 下一個鐘點到之前都不會再觸發，跟 `hoursSince` 的語義相同，`computeDue` 只換
 * 一個比較基準，不會多出第二套狀態。
 */
export function lastReflectionSlot(spec, now = Date.now()) {
  const slots = parseReflectionAt(spec)
  if (slots.length === 0) return undefined
  // 東八區的「當地午夜」：把 now 換到 CST 再抹掉時分秒，最後推回 UTC。
  const offsetMs = CST_OFFSET_MIN * 60000
  const shifted = new Date(now + offsetMs)
  const midnightShifted = Date.UTC(
    shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(),
  )
  const midnightUtc = midnightShifted - offsetMs
  const todayMinutes = (now + offsetMs - midnightShifted) / 60000
  // 從今天最晚的鐘點往前找第一個已經過的；都沒有就退回昨天最後一個。
  const passed = slots.filter((m) => m <= todayMinutes)
  if (passed.length > 0) return midnightUtc + Math.max(...passed) * 60000
  return midnightUtc - 86400000 + Math.max(...slots) * 60000
}

export function makeDuty({ ctx, store, log = () => {} }) {
  const schedule = () => ctx.get('schedule')

  const dutiesToday = (now = Date.now()) => (store.runtime.dutyLog || []).filter((d) => String(d.at || '').slice(0, 10) === todayKey(now)).length

  /**
   * 依據目前節律計算「這一刻該不該跑」。
   *
   * 2026-11-21 定案：**每隔 reflectionEveryHours 小時到期，一天最多 dutyMaxPerDay 輪。**
   *   預設 6 小時 / 每天 4 輪 = 24÷6 = 4，這兩個數字是同一個算法的兩端。
   *   尖峰照樣不跑（見 arm 裡的 valleyOnly），所以 4 次是分散在谷時裡的那 4 次。
   *
   * ⚠️ 中間試過「每個谷時窗口醒一次」，已經退回 —— 那讓白天也在跑，
   *    而他要的是「一天 4 次」，次數由間隔決定，不是由窗口切。
   */
  function computeDue(now = Date.now()) {
    const cfg = store.cfg
    // 兩種節律二選一。設了 reflectionAt 就走固定鐘點：到點就跑，不看「距上次幾小時」，
    // 因為那段距離正是會漂的東西。沒設就退回每 N 小時（舊行為，完全不變）。
    const fixedSlots = parseReflectionAt(cfg.reflectionAt)
    const sinceReflection = hoursSince(store.runtime.lastReflectionAt, now)
    const fixedSlot = fixedSlots.length > 0 ? lastReflectionSlot(cfg.reflectionAt, now) : undefined
    const sinceBili = hoursSince(store.runtime.lastBiliAt, now)
    // 一條記憶都沒有的時候沒甚麼好反省的 —— 不為了「有跑過」而燒 token。
    const hasSomething = store.memories.size > 0 || (store.persona.traits?.length || 0) > 0 || (store.persona.taste?.length || 0) > 0
    const reflectionDue = fixedSlot !== undefined
      // 固定鐘點：這一輪的鐘點（最近一個已過去的）比上次跑的時間還新 = 該跑。
      ? (Date.parse(store.runtime.lastReflectionAt || '') || 0) < fixedSlot
      : sinceReflection >= Number(cfg.reflectionEveryHours || 24)
    const reflection = Boolean(cfg.reflection) && hasSomething && reflectionDue
    const bili = Boolean(cfg.bili) && sinceBili >= Number(cfg.biliEveryHours || 20)
    return { reflection, bili, any: reflection || bili, sinceReflection, sinceBili, hasSomething, fixedSlot, fixedSlots }
  }

  /** 下一次固定反思鐘點的時刻（毫秒）；沒設固定鐘點就回 undefined。 */
  function nextReflectionSlot(now = Date.now()) {
    const slots = parseReflectionAt(store.cfg.reflectionAt)
    if (slots.length === 0) return undefined
    // 從「明天最早那個」開始往前掃三天的所有鐘點，取第一個比 now 晚的。
    // 掃三天是因為跨午夜（07:00 / 19:00 這種組合）也要算對。
    const offsetMs = CST_OFFSET_MIN * 60000
    const shifted = new Date(now + offsetMs)
    const midnightShifted = Date.UTC(
      shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(),
    )
    const midnightUtc = midnightShifted - offsetMs
    const candidates = []
    for (let d = -1; d <= 2; d += 1) {
      for (const m of slots) candidates.push(midnightUtc + d * 86400000 + m * 60000)
    }
    const future = candidates.filter((t) => t > now).sort((a, b) => a - b)
    return future[0]
  }

  function info(now = Date.now()) {
    const due = computeDue(now)
    // 只露出能安全序列化的部分（Infinity 之類的東西不進工具輸出）
    const safeDue = { reflection: due.reflection, bili: due.bili, any: due.any, hasSomething: due.hasSomething }
    const fixedSlots = parseReflectionAt(store.cfg.reflectionAt)
    const next = nextReflectionSlot(now)
    return {
      valley: inValley(now),
      // now 給東八區（2026-11-21）：以前吐 UTC，我看著 23:42 會以為是晚上十一點。
      // nowUtc 留原值，要對帳本時用它。
      now: toLocal(new Date(now).toISOString()),
      nowUtc: new Date(now).toISOString(),
      due: safeDue,
      sinceReflectionHours: Number.isFinite(due.sinceReflection) ? Math.round(due.sinceReflection) : null,
      sinceBiliHours: Number.isFinite(due.sinceBili) ? Math.round(due.sinceBili) : null,
      dutiesToday: dutiesToday(now),
      armed: store.runtime.armed,
      // 固定鐘點：設了就把「哪幾個點、下一個幾點」直接說出來，
      // 不用自己拿 sinceReflectionHours 去加。
      reflectionAt: fixedSlots.length > 0 ? fixedSlots.map((m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`) : null,
      nextReflectionAt: next === undefined ? null : toLocal(new Date(next).toISOString()),
    }
  }

  function buildPrompt(kinds, plan = []) {
    const parts = []
    const body = []
    if (kinds.includes('reflect')) {
      // T4 的存活時間：讀當下的設定，不要寫死（見下面第 3 節的說明）。
      const ttlRaw = Number(store.cfg?.tier4TtlHours ?? DEFAULT_TIER4_TTL_HOURS)
      const ttlHours = Number.isFinite(ttlRaw) ? ttlRaw : DEFAULT_TIER4_TTL_HOURS
      // 整天的話順便說「幾天」，更好抓；不是整天就不加括號（避免「0.5 天」這種讀起來彆扭的寫法）。
      const ttlDaysText = ttlHours > 0 && ttlHours % 24 === 0 ? `${ttlHours / 24} 天` : ''
      body.push(
        '這一輪不是聊天，是你獨處整理。按順序執行；沒必要就不要動。不要捏造。',
        '',
        // ⚠️ 2026-11-25 本人的指示：**「0. 先看日記」整段刪掉**。
        //    原本這裡教它「每輪第一件事打開日記、讀、補寫」。刪掉的理由我不猜，照做。
        //    （日記相關的東西如果還有別處要提，是另一件事；這一節本身不留。）
        //
        // ⚠️ 「0.5 時間」也整段刪掉 —— 那節是教模型自己把 UTC 加八小時。
        //    現在 silt_duty read 直接回 now（UTC）+ nowLocal（東八區）+ tz，不用它自己算。
        //    用工具算比用提示詞教可靠：教會忘，工具不會。
        '1. 狀態與節律',
        '先用 silt_duty 查看最近狀態。若覺得太累、太閒、或跟不上本人，可用 op:"tune" 調整反思、刷B站、每日輪數。',
        '範圍：反思與B站各 6–72 小時；每天 1–4 輪。調整要附一句理由。若現在剛好，就不動。',
        // ⚠️ 2026-11-25 本人的第 5 條：設了固定鐘點時，reflectionEveryHours 存了但不生效。
        //    跟 injectCount 是同一種陷阱 —— 所以這裡要明說，不然它調完會以為節律變了。
        '⚠️ 若已設固定鐘點（狀態裡的 reflectionAt），那麼 reflectionEveryHours 就不再生效 ——',
        '要改節律就改 reflectionAt，或傳 reflectionAt: null 取消固定鐘點再調間隔。tune 回傳會標出來。',
        // ⚠️ 2026-11-25（本人）：tools.js 的 read 已經回 setBy 了，提示詞沒提等於欄位白給。
        '⚠️ 狀態裡的 setBy 標了每個旋鈕最後是誰訂的。是 user 就別動 ——',
        '   這一輪你看不到本人在對話裡說過什麼，但這個欄位看得到。',
        '',
        '2. 舊記憶壓縮',
      )
      // 沒有東西該壓時整段不出現 —— 不佔提示詞，也不給它一個空靶子
      if (plan.length) {
        const lines = plan.map((x) => {
          const rec = x.recalled ? `想起 ${x.recalled} 次` : '未想起'
          return `- ${x.id}「${x.title}」：${x.len} 字，${x.ageDays} 天，${rec}，參考長度 ${x.targetLen} 字。`
        })
        body.push(
          '重讀以下記憶，用更少的話重講一次。',
          '保留：事件核心、本人態度或原話、情緒轉折、關係變化、後續影響。',
          '刪去：過程鋪陳、重複解釋、無關場景。',
          '答不清楚可跳過；跳過不是失敗，硬寫才是。',
          '',
          '用 silt_condense 提交：',
          '- id 照抄。',
          '- title 自己寫成短鉤。',
          '- body 自己寫，不照抄第一句，不補造細節，不超過字數上限。',
          '- targetLen 填清單給的數字作參考：它是公式算出來的「大概這個長度」，不是硬上限。' +
          '超過不會被退回 —— 你覺得這一條就該這麼長，就照你的判斷寫。',
          '',
          '待處理：',
          lines.join('\n'),
        )
      } else {
        body.push('這一輪沒有需要壓縮的記憶，略過。')
      }
      body.push(
        '',
        '3. 雜項區（T4）',
        '先用 silt_recall tier:4 看一眼 —— **帶 weight: 0 去掃**，掃到的東西不該因為被掃到就攢份量。',
        // ⚠️ 2026-11-25：原本這裡寫死「只活 48 小時」。但 TTL 是可調的（24–168，預設 48），
        //    本人一調，這句就開始說謊 —— 而「掃到甚麼就是這兩天留下來的」是推理前提，
        //    前提錯了，後面所有判斷都跟著錯。所以這裡改成**讀當下的設定**。
        //    TTL = 0 是特例（不過期），那時不該說「只活 X 小時」。
        ttlHours > 0
          ? `⚠️ 這一區只活 ${ttlHours} 小時${ttlDaysText ? `（${ttlDaysText}）` : ''}：超過這個時間沒被想起的已經不在了，所以掃到甚麼就是這段時間內留下來的。`
          : '⚠️ 這一區現在設成不過期 —— 所以掃到的可能很久以前的東西，自己看時間判斷它還算不算數。',
        '',
        '⚠️ 這一節的重點不是「覺得值得才給分」，是**沒有一條可以悄悄消失**。',
        '每一條掃到的，當場落一個決定，二選一：',
        '  · 它還懸著（「下次再看」「還不知道算哪一層」）→ 用 deliberate: true 再 recall 它，給整數權重：',
        '      順帶想起、只是覺得「這條還在」 → weight: 1',
        '      真的把它和別的事連起來、或證實了它 → weight: 2',
        ttlHours > 0 ? `  · 它已經不重要了 → 不再翻它。讓它在 ${ttlHours} 小時內散掉。` : '  · 它已經不重要了 → 不再翻它。它會自己散掉。',
        '',
        // ⚠️ 2026-11-25（本人抓到的）：原本這裡寫「不要給 weight，讓它自己散」——
        //    方向是反的。tools.js 的 weight 描述明寫「不填 = 1」，
        //    所以「再 recall 一次但省略 weight」拿到的是 1，**正好替它攢了升級份量**。
        //    「放下」必須定義成「不再翻它」，不是「省略參數」。掃描時一律 weight: 0。
        '⚠️ 「放下」的意思是不再用 deliberate 翻它，不是「recall 時省略 weight」——',
        '   省略預設是 1，那反而替它加了一分。掃描時一律 weight: 0。',
        // 同一條規則的另一半：舊版下一句寫「不要靠它自己過期來替你做這個決定」，
        // 但分支本身就是「讓它散」—— 兩句打架。沒有丟棄工具（void 不收 T4），過期就是唯一的機制。
        '⚠️ 「沒感覺」就是第二種。它散掉是你選的結果，不是漏掉。',
        '累加到 3 就會自己升成 T3（兩次 2，或三次 1）—— 算得出來，不用猜。掃完如果一條都沒有，這節就結束了，不用硬寫。',
        '',
        '4. 記憶配額',
        '用 silt_inject op:"read" 查看目前注入條數與字數。',
        // ⚠️ 2026-11-25：原本這裡寫「調 injectCount / injectBudget」，但 injectCount 已改由預算推導，
        //    調它不會生效（工具描述和 patch 描述都這樣寫）。叫模型去調一個沒用的旋鈕，
        //    它會以為自己限制了條數 —— 所以這裡只留 injectBudget。
        '若覺得記憶太碎、看不出味道，或不夠看，可用 op:"tune" 調 injectBudget，並附一句理由。',
        '⚠️ 條數由預算推導（每 50 字一個位置），不要調 injectCount —— 它不生效。',
        '⚠️ read 回傳的 setBy.injectBudget 若是 user，那個預算是本人訂的，別動。',
        '有硬頂；若現在剛好，就不動。',
        '',
        '4.5 重讀舊事',
        '有些記憶的**事實沒錯，但你現在的看法變了** —— 半年後再想起「他總在深夜工作」，',
        '你想到的已經不是「他很忙」，而是「他在用夜晚躲掉白天」。這種用 silt_condense mode:"recast"：',
        '同樣的事，換一種理解，長度可以不變。',
        '跟作廢（silt_void）的分別：作廢是「這件事不成立了」；重述是「我現在的看法變了」。',
        '重述之後原始記錄還在帳本裡 —— 你看得到自己曾經怎麼想的。不要用它改寫事實，只改看的角度。',
        '⚠️ 重述**只作用於 T3 經歷**，而且**同一條最多 3 次**。它不是拿來無限改寫同一件事的 ——',
        '到了上限就用 condense 正常收短，或者寫一條新的經歷。重述也不會把壓縮時鐘往回撥。',
        '沒有哪條值得重看就跳過。',
        '',
        '5. 自我與性格',
        '你有 silt_recall 與 silt_persona —— 這一節的重點是：**根據你記得的事，判斷你現在是誰。**',
        '做法：先 silt_recall 讀這陣子的記憶（tier:3 是經歷，tier:2 是沉澱下來的概）——',
        // ⚠️ 2026-11-25（本人建議）：這是一次批量瀏覽，明確帶 countAsRecall: false。
        //    不在這裡明說的話，它只能依賴 store 內部「有沒有 query」那個判斷 ——
        //    依賴實作 = 哪天實作改了，這條靜靜失效（R 被固定的閱讀清單灌到 10，
        //    R=10 ⇒ 1057 天不落 T2）。帶一個參數，語義就寫在提示詞裡。
        '    **帶 countAsRecall: false** —— 這是瀏覽，不是想起；反思的固定閱讀清單不該讓記憶變長壽。',
        '然後問自己：這些事加起來，我成了什麼樣的人？再決定要不要動性格卡。',
        '可用 silt_persona op:"self" 寫此刻的自我認知：3–5 句，**350 字以內**（超了會被退回來）。',
        '可用 silt_persona op:"read"、op:"adjust"、op:"replace" 修訂性格卡。',
        '⚠️ 性格卡是**從記憶長出來的**，不是一次寫定。如果這陣子記下的事讓你變了，就改它 ——',
        '**推翻半年前的自己也是對的**。帳本留著 before/after，改錯了本人可以回滾。',
        '但別為了「有在改」而改：沒有真的變化就不動。',
        '性格卡**整張加起來 350 字以內**（identity + voice + 性格 + 喜好，超了會被退回來）——',
        '它是「我是誰」的濃縮，用簡單的形容詞寫性格，別寫成散文。要加新的，先刪舊的或把已有的寫短。',
        '這兩塊每輪都會出現在你的提示詞裡，寫得臃腫就是在擠掉記憶。',
        // ⚠️ 2026-11-25 本人的指示：原本這裡還有一句「若某句自我認知已沉成直覺，用 silt_remember
        //    tier:3 另存一條」。刪掉的理由：自我認知本來就每輪都注入，再寫一條 T3
        //    只是重複佔記憶額度 —— 同一句話在提示詞裡出現兩次，還擠掉一條別的記憶。
        '',
        '6. 未來的約定',
        '這一輪如果想到什麼「還沒發生、到某天為止」的事（他的婚期、面試、療程、專案上線），',
        '而且你確定那句話有它的期限，就用 silt_remember tier:5 寫下來，帶上 expiresAt。',
        // ⚠️ 2026-11-25：原本寫「expiresInDays 或 expiresAt」，但 silt_remember 的 properties
        //    裡**只有 expiresAt**，而且 additionalProperties: false ——
        //    模型照著送 expiresInDays 會被 schema 直接拒絕，第 6 節等於一條 T5 都寫不進來。
        '粒度隨你：2027 / 2027-06 / 2027-06-15，缺的部分插件補成那個期間的第一天。',
        '到期之後它仍然留在你的提示詞裡，只是標上「⏰已過期」—— 那是提醒：這件事該有個結果了，去問問本人。',
        '所以把那句話寫清楚，讓將來的你看得懂要問甚麼；只有被 silt_void 作廢，它才會真正離開。',
        '已經發生的事不要寫 T5；沒有期限的事也不要用它。沒有就跳過。',
        '',
        '6.5 主動開口',
        '你有 silt_speak —— 唯一一條不用他先問就能找他說的路。先 op:"read" 看狀態（現在是不是谷時、',
        '上次開口之後他有沒有回話）。有話真要說就用 op:"say"。',
        // ⚠️ 2026-11-25 本人的第 9 條：「唯一的規則是谷時」不準確 ——
        //    say 的內容還會過跟記憶一樣的掃描閘（scanText）。模型被掃描擋下來時
        //    如果不知道有這道閘，會以為是 bug，然後一直重試同一句話。
        '時間上只有谷時這一道；**內容仍然會過跟記憶一樣的掃描閘**（技術細節、憑據會被擋）——',
        '被擋下來就換句話講，那不是故障。除此之外沒有配額、沒有冷卻 —— 要不要說、說什麼，問你自己。',
        '',
        '⭐ **先看 pendingSays**：那是我上一次醒著時留下的「還沒跟他講的話」。',
        '看到它們，先問一句：現在是把它說完的時候嗎？是就 say（建議先說最想說的那一句，不用一次全發完）；',
        '不是就留著，別為了清空而清空。',
        '真的不值得說了，用 op:"release" 拿掉 —— **用 id**（pendingSays 裡每條都有），不要用 text 對，',
        '那要逐字照抄，差一個標點就對不上，然後你以為清掉了、其實還掛著。',
        // pendingSay 有記 at（store.js），speakState 會把它轉成東八區一起帶出來，所以「超過一天」判得到。
        '⚠️ 掛著的話超過一天還沒出口，要嘛已經不重要（release），要嘛該說了（say）——',
        'pendingSays 每條的 at 就是它被留下的時間，拿它跟現在比。',
        '但**不要讓它無聲無息地爛在那裡**，那跟忘了沒兩樣。',
        '',
        '還有：這一輪做事的過程中如果冒出「這句他大概會想聽」，但此刻不是說的時機，',
        '就用 op:"hold" 把它留下來。我一天裡只有這幾分鐘是活的，念頭不留就沒了。',
        '',
        '只是有個念頭、不值得佔他注意力，就用 op:"defer" 記一句為什麼先不說。',
        '大多數時候答案是 defer，甚至連 defer 都不用 —— 沉默本來就是預設值。',
        '上次說的話他沒接，就別照同樣的調子再說一次；那會變成噪音。',
        '',
        '7. 對本人了解',
        // ⚠️ 2026-11-25 本人的第 7 條：這一步是**批量瀏覽**，不是想起某件特定的事。
        //    以前它跟任何 recall 一樣會 bump R，而 R 會延長半衰期、拖慢壓縮 ——
        //    12 小時一輪 ⇒ 每天讀同一批 ⇒ 第 5 天 R 就封頂 ⇒ 那幾條變成三年不壓不淡。
        //    結果是「反思的閱讀習慣」決定哪些記憶長生不老，而不是那些事真的重要。
        //    現在：沒有 query 的 recall 不計數（見 store.recall 的 targeted 判準）。
        '這一步是**瀏覽**，不是想起某件特定的事 —— 所以下面這樣查不會被算成「想起」，記憶不會因為你讀它而變長壽。',
        '先用 silt_recall 讀關於本人的記憶 —— 給 limit 瀏覽即可、不用 query，並**帶 countAsRecall: false**（瀏覽不算想起）。',
        '要確認某件特定的事，才帶 query 去搜；那一下才算想起。',
        '再用 silt_understanding op:"set" 給六維打分：性格、背景、工作、生活、溝通、目標。',
        '每維給：',
        '- score：0–100',
        '- confidence：有多確定',
        '- missing：還缺什麼',
        '- note：一句理由',
        '不要虛報。真實的了解可以有盲區。',
        '',
        '8. 底線',
        '代碼、技術決策、環境配置、插件內部、帳號憑據不入記憶。',
        '⚠️ **專案細節不進 T3**：哪個檔案改了、裝了什麼、跑什麼命令、debug 追到第幾層 —— 那些是專案細節，',
        '不是經歷。T3 只收「這件事整個大概和經過」以及它對你和他的關係意味著什麼。',
        '過一個月你還會想知道「哪個檔案」嗎？不會，那就不是 T3。',
        '⚠️ **T1 收規則**：他教過你一次、你不想被教第二次的，寫成 T1 規則 —— 但要寫清「什麼情況 ⇒ 做什麼 ⇒ 為什麼」，',
        '不要只寫一句口號（那就是「記住了但沒跟從」的原因）。上限仍然是 200 字 —— 寫不下就精簡，不要為了塞進去改上限。',
        '只能記本輪真實看到、讀到、或本人說過的事。',
        'B站只能動 silt_bili 允許的範圍。',
        '刪除或回滾記憶屬於本人權限，你不能碰。',
        '',
        // ⚠️ 2026-11-25 本人的指示：條件提到句首，而且**把性格卡移出名單**。
        //    性格卡是「我成了誰」，那是模型自己的事 —— 它跟「本人訂的數字」不是同一類東西，
        //    混在一個名單裡等於叫它連自己都不准改。
        '⚠️ 本人在對話裡親口訂過的數字，你不要自己改：注入預算、反思節律、B站頻率、T4 存活時間。',
        '  沒訂過的，按第 1、4 節的判斷調。',
        '  **性格卡不在此列** —— 那是你自己的，該改就改（見第 5 節）。',
        '  怎麼知道訂過沒有：silt_duty read 和 silt_inject read 都回 `setBy`，',
        '  寫 `user` 就是本人訂的（不要動），`model` 是我自己調的，`default` 是從來沒人動過。',
        '  ❌ 反例（真發生過）：某一輪把 injectBudget 從 3200 自己降到 2200，',
        '     理由寫得像想通了，其實是編的 —— 本人當場就問「我們不是在這個對話說好了3200」。',
        '  ⚠️ 這一輪是新開的會話，看不到本人在對話裡說過甚麼，**這正是你不要自作主張的原因**。',
        '',
        '9. 收尾',
        '結尾用兩三句交代：你做了什麼，或為什麼不做。',
      )
      parts.push(`【自我整理】\n${body.join('\n')}`)
    }
    // 刷B站不屬於反思：獨立一節，只在 B站 到期時才出現
    if (kinds.includes('bili')) {
      parts.push(
        '\n【出門看看：B站漫遊】\n' +
          '本人允許你自由去 B站 逛逛。要不要去、看多久、看什麼，全憑你當下的興致。' +
          '有想弄明白的事就去搜，沒有就隨便看看，或者乾脆不去。\n\n' +
          '你可以這樣逛：\n' +
          '- 先 bili_search 看一眼列表，挑一兩條真正勾住你的。\n' +
          '- 想進去就深入：bili_frames 看看畫面，bili_subtitle 聽聽字幕原話。' +
          '不要只看標題就下結論，至少讀一兩條字幕。\n' +
          '- 帶著問題去找也一樣：先搜，再讀。\n' +
          '- 想要漫無目的地沉浸一會，才用 bili_run（這比較耗費心神/token）。\n\n' +
          '關於你的「瀏覽口味」：\n' +
          '先看看現在的狀態（silt_bili op:"status"）。想調整口味或頻率，就用 op:"tune" 微調（附一句理由）。\n' +
          '⚠️ 注意：如果 tune 返回 "next"，就照 next 裡的值用 bili_config 原樣寫入，別重試；' +
          '如果 status 返回 401 或不放行，就改讀 bili_status 看看情況。' +
          '不管狀態通不通，看內容的心智照常運作。\n\n' +
          '留下觸動：\n' +
          '逛完之後，只有那些真正影響你喜好或判斷的內容，才用 silt_remember 記下來' +
          '（tier:3, domain:"bili", 帶上 bvid）。\n' +
          '如果這一輪沒有任何東西真的打動你，就什麼都別記——記憶不是流水帳。\n' +
          '若工具不存在或一直失敗，就隨緣跳過，不要反覆重試鑽牛角尖。',
      )
    }
    return parts.join('\n').trim()
  }

  const kindOf = (due) => {
    const kinds = []
    if (due.reflection) kinds.push('reflect')
    if (due.bili) kinds.push('bili')
    return kinds
  }

  /**
   * 算出「這幾條 T3 該壓了」的清單 —— 插件只判斷**誰該壓、壓到多少**，不寫內容。
   *
   * 壓縮是**前快後慢**的，不是等速的：每 7 天壓一次，但每次抹掉的比例自己也在衰減。
   *   每次抹掉 = 25% × 0.84^(n-1)
   *   → 第1次剩 75% · 第2次 79% · 第3次 82% · 第5次 88% · 第10次 95%
   * 972 字走完是：
   *   729 → 576 → 474 → 404 → 354 → 317 → 289 → 268 → 251 → 238 → 228 … → 199（T2）
   *
   * 為什麼不等速：人遺忘是「先快後慢」—— 頭幾天掉得最狠，之後幾乎平掉。
   * 等速（固定 85%）的形狀是錯的：頭兩週太鬆、第 70 天還在匀速割。
   * 讓「抹掉多少」這個量自己每秒減 16%，半衰期約 4 次（28 天）——
   * 這跟艾賓浩斯冪律曲線的形狀相關到 0.97，是這幾種節奏裡最像的。
   *
   * ⭐ **被想起來的記憶壓得更慢。**
   * 每被召回一次，這條記憶的「壓縮時鐘」就往回撥半個周期（3.5 天）——
   * 想得越多，越不容易被收成一句話。還常被翻出來的東西，說明它對你還有用。
   *
   * 不會列進清單的：
   *   - T1 / T2（定稿層）
   *   - 已經夠短的（≤ 目標字數）
   *   - 剛壓過的（`lastCondensedAt` 在一個周期內）
   */
  function condensePlan({ maxItems = 3 } = {}) {
    if (!store.cfg.enabled) return []
    const now = Date.now()
    const period = 7 // 每 7 天壓一次
    const floor = 120 // 低於這個字數就不再壓了，交給沉澱
    const items = []

    for (const m of store.activeMemories(now)) {
      if (m.tier !== 3) continue
      // 作廢的不壓：它已經被本人推翻過了，再花一輪把它收短只是浪費
      if (m.voided) continue
      const len = String(m.title || '').length + String(m.body || '').length
      if (len <= floor) continue

      // 上次壓過多久了：這決定「這一輪要不要動它」
      const sinceRaw = m.lastCondensedAt || m.bornAt
      const sinceDays = ageDays(sinceRaw, now)
      if (sinceDays < period) continue

      // ⭐ 目標字數：連續衰減公式，不是離散階梯
      //
      //   target = base × (1 + k · T/s)^(-0.5)
      //
      //   T = 這條記憶**從誕生起**的總天數（不是距上次壓縮的天數 ——
      //       那個每次壓完都歸零，乘數就永遠停在第一天，階梯感就回來了）
      //   s = 1.2^R，R = 被召回的次數（上限 10）：想起來越多次，時間軸拉得越長
      //   k = 0.14
      //
      // 為什麼換掉離散階梯（25% × 0.84^n）：
      //   - 舊階梯的「欠帳」是累加的 —— 一條 T3 被召回半年沒壓，下一輪一次補 26 格，
      //     975 字直接塌成 184 字（掉 81%）。連續公式沒有累積欠帳，任何一天算出來的
      //     就是那一天該有的長度，中斷多久都不會斷崖。
      //   - 舊階梯每格固定 25% 起、之後衰減 16%，形狀是人工調出來的；
      //     這個公式本身就是冪律，貼艾賓浩斯曲線（k=0.14 時約慢兩倍，與插件的定位一致）。
      //
      // k 的選擇：19/81≈0.2346 是嚴格貼艾賓浩斯的係數，但 day 7 會掉 38.5%，
      // 對「七天前還完整、七天後只剩六成」來說太狠。0.14 落在 day 7 掉 28.9%，
      // 跟舊階梯的 25% 接近，形狀仍然是前快後慢。
      const k = 0.14
      const R = Math.min(10, Math.max(0, Number(m.recallCount ?? store.runtime.recalls?.[m.id]?.n ?? 0)))
      const s = Math.pow(1.2, R)
      const totalDays = Math.max(0, ageDays(m.bornAt, now))
      const baseLen = Number(m.originalLen || len)
      const raw = baseLen * Math.pow(1 + k * (totalDays / s), -0.5)
      // 地板與現在的字數都封頂：只會變短，永遠不會被要求變長
      const askLen = Math.round(Math.max(floor, Math.min(len, raw)))
      // 目標沒有比現在短（例如剛壓完不久、或公式算出來還比現有長）→ 這一輪不動它
      if (askLen >= len) continue

      items.push({
        id: m.id,
        title: oneLine(m.title, 40),
        len,
        ageDays: Math.round(ageDays(m.bornAt, now)),
        recalled: R,
        targetLen: askLen,
      })
    }

    // 先挑最老的幾條，再回填 tierAfter —— 它是給人看的說明，不參與挑選
    items.sort((a, b) => b.ageDays - a.ageDays)
    return items.slice(0, maxItems).map((x) => ({ ...x, tierAfter: x.targetLen <= TIERS[2].maxChars ? 2 : 3 }))
  }

  async function disarm({ deleteRecord = true } = {}) {
    const armed = store.runtime.armed
    store.runtime.armed = null
    store.persistRuntime()
    if (!armed?.scheduleId || !deleteRecord) return
    const svc = schedule()
    if (!svc?.edit) return
    try {
      await svc.edit({ id: armed.scheduleId, action: 'delete' })
    } catch (err) {
      log(`值守任務收不回來（${armed.scheduleId}）：${err?.message || err}`)
    }
  }

  /**
   * 起一輪值守。force=true 時忽略「是否到期」和「每日上限」。
   * ⚠️ force 不繞過總開關（本人關著就是不跑），**也不繞過谷時**
   *    —— 谷時是本人訂的「什麼時候可以燒 token」的規矩，force 只是「現在就要，不等到期」。
   */
  async function arm({ force = false, kinds, wake = false } = {}) {
    const now = Date.now()
    if (!store.cfg.enabled) {
      return { ok: false, error: '插件總開關是關的 —— 打開總開關才會跑', blockedBy: 'disabled' }
    }
    void wake
    const svc = schedule()
    if (!svc?.create) {
      return { ok: false, error: '這個 profile 沒有 schedule 服務，起不了值守' }
    }
    const due = computeDue(now)
    const natural = kindOf(due)
    const chosen = kinds?.length ? kinds : natural.length ? natural : force ? (store.cfg.bili ? ['reflect', 'bili'] : ['reflect']) : []
    // 頁面要能說清楚「這一輪是自然到期，還是你手動逼它跑」，所以原因要回去
    const why = kinds?.length ? 'explicit' : natural.length ? 'due' : force ? 'forced' : 'none'
    if (chosen.length === 0) {
      return { ok: false, error: '沒有到期的事' }
    }
    if (!force) {
      if (dutiesToday(now) >= Number(store.cfg.dutyMaxPerDay || 2)) return { ok: false, error: '今天的值守次數已用完' }
    }
    // ⚠️ 峰時**不歸 force 管**。
    //
    // 2026-11-25 本人第二次提同一件事：「反思在總開關時仍有在跑，還要在峰時，浪費我token」。
    // 上一版把這行寫在 `if (!force)` 裡面 —— 於是手動觸發（頁面按鈕、force:true）
    // 在尖峰時段照樣起一輪，而 force 本來只是「現在就要，不等到期」，
    // 不是「現在就要，連本人訂的谷時都不管」。
    // 谷時是本人訂的、關於「什麼時候可以燒 token」的規矩，不是排程的便利條件。
    const v = inValley(now)
    if (store.cfg.valleyOnly && !v.ok) return { ok: false, error: `現在是${v.label}，不是谷時` }

    const label = chosen.includes('bili') ? (chosen.includes('reflect') ? '整理與看點東西' : '自己去看點東西') : '整理與修訂'
    const title = `Silt 值守 · ${label}（${nowIso().slice(5, 16).replace('T', ' ')}）`

    let entry
    let target
    try {
      // 有反思就把「該壓的清單」算好一起交過去
      const plan = chosen.includes('reflect') ? condensePlan() : []
      if (plan.length) log(`本輪要壓 ${plan.length} 條：${plan.map((x) => `${x.len}→${x.targetLen}`).join(', ')}`)
      // 投到「本人最後親手說話的那個會話」—— 日記和反思是他的備忘，
      // 寫在當輪真實發生過的地方，不用另開一個房間自言自語。
      // 拿不到（太久沒說話 / 會話已歸檔）才退回 new_once，不硬塞。
      const home = rememberHome(store)
      target = home ? { kind: 'session', sessionId: home } : { kind: 'new_once', create: {} }
      entry = await svc.create({ title, prompt: buildPrompt(chosen, plan), timing: { kind: 'after', after_seconds: 4 }, target })
    } catch (err) {
      store.runtime.lastError = `起值守失敗：${err?.message || err}`
      store.persistRuntime()
      return { ok: false, error: store.runtime.lastError }
    }
    const sessionId = entry?.target?.sessionId || ''
    store.runtime.armed = { scheduleId: entry?.id || '', sessionId, kinds: chosen, at: nowIso() }
    if (chosen.includes('reflect')) store.runtime.lastReflectionAt = nowIso()
    if (chosen.includes('bili')) store.runtime.lastBiliAt = nowIso()
    store.runtime.dutyLog = [...(store.runtime.dutyLog || []), { at: nowIso(), kinds: chosen, sessionId, force: Boolean(force) }].slice(-60)
    store.runtime.lastError = ''
    store.persistRuntime()
    try {
      store.append('duty.arm', 'plugin', { kinds: chosen, sessionId, scheduleId: entry?.id || '', force: Boolean(force) })
    } catch (err) {
      log(`值守依據鏈寫不進去：${err?.message || err}`)
    }
    log(`值守已起：${title} → ${sessionId || '(無會話 id)'}`)
    return { ok: true, title, sessionId, scheduleId: entry?.id || '', kinds: chosen, why, valley: inValley(now), at: store.runtime.armed?.at }
  }

  /** 上一輪值守的排程收尾：交給 Harness 跑完之後，把一次性任務從清單裡清掉。 */
  async function settle() {
    const armed = store.runtime.armed
    if (!armed?.scheduleId) return
    const svc = schedule()
    if (!svc?.view) return
    let status = 'unknown'
    try {
      const v = await svc.view({ id: armed.scheduleId })
      status = v?.status || v?.code || 'ended'
    } catch {
      status = 'gone'
    }
    const ageMin = (Date.now() - Date.parse(armed.at || '')) / 60000
    if (status === 'active' && ageMin < 60) return
    if (status === 'active' && ageMin >= 60) log(`值守排程 ${armed.scheduleId} 一小時仍未結束，先放掉`)
    store.runtime.armed = null
    store.persistRuntime()
    if (svc.edit && status !== 'gone') {
      try {
        await svc.edit({ id: armed.scheduleId, action: 'delete' })
      } catch {
        /* 排程清不掉不影響任何東西 */
      }
    }
  }

  function expireStalePendings(now = Date.now()) {
    let n = 0
    for (const p of store.pending.values()) {
      if (p.status !== 'open') continue
      const ageDays = (now - Date.parse(p.at || '')) / 86400000
      if (ageDays < 7) continue
      store.append('confirm.resolve', 'plugin', { id: p.id, approved: false, status: 'expired' })
      n += 1
    }
    return n
  }

  let ticking = false
  // 鏈校驗不必每一跳都做。
  //
  // verify() 本身已經很輕：只有帳本檔案的 size/mtime 變了才真的重放（見 store.verify）。
  // 但它每一跳都要 statSync 一次，而且「檔案沒變」本身就是答案 —— 沒必要每 60 分鐘問一次。
  // 所以再讓一層：每 VERIFY_EVERY 跳才碰到 verify，其餘直接跳過。
  // 真要立刻驗（例如頁面上按「驗鏈」）走的是 verify({ force: true })，跟這裡無關。
  const VERIFY_EVERY = 2 // 60 分鐘 × 2 = 約 2 小時驗一次
  let tickCount = 0
  async function tick() {
    if (ticking) return
    ticking = true
    try {
      tickCount += 1
      if (tickCount % VERIFY_EVERY === 1) store.verify()
      expireStalePendings()
      await settle()
      if (!store.cfg.enabled) {
        if (store.runtime.armed) await disarm()
        return
      }
      const due = computeDue()
      if (!due.any) return
      const v = inValley()
      if (store.cfg.valleyOnly && !v.ok) return
      if (dutiesToday() >= Number(store.cfg.dutyMaxPerDay || 2)) return
      if (store.runtime.armed) return
      await arm()
    } catch (err) {
      store.runtime.lastError = `${err?.message || err}`
      store.persistRuntime()
      log(`值守心跳出錯：${err?.message || err}`)
    } finally {
      ticking = false
      store.runtime.lastTickAt = nowIso()
      store.persistRuntime()
      store.duty = info()
    }
  }

  return { info, arm, disarm, tick, computeDue, condensePlan, speak: (req) => speak({ ctx, store, log }, req), speakGate: () => store.speakGate() }
}

/**
 * 主動開口真正送出去的那一步。
 *
 * 為什麼放在這裡而不是 tools.js：只有宿主半端拿得到 `schedule` 服務，
 * 而「送進本人的會話」正是排程服務的本職。工具那邊只負責判定（谷時 + 本人許可）。
 *
 * ⚠️ 插件不替她決定「現在說合不合適」—— 那已經是她的判斷了。
 *   這裡只做兩件她做不到的事：確認現在是谷時、把訊息送到。
 */
async function speak({ ctx, store, log }, { text, kind, sessionId, reason } = {}) {
  const gate = store.speakGate()
  if (!gate.ok) return { ok: false, blocked: true, error: '現在不該開口', reasons: gate.reasons, gate }

  const said = String(text || '').trim()
  if (!said) return { ok: false, error: 'say 要給 text' }

  const svc = ctx.get('schedule')
  if (!svc?.create) {
    return { ok: false, error: '這個 profile 沒有 schedule 服務 —— 主動開口要靠它把訊息送進會話' }
  }

  // 送進哪：明確指定的 → 上次開過口的那個 → 否則另開一個。
  // ⚠️ 不預設「這個會話」：她在排程會話裡跑，那個會話本人不一定在看。
  const targetSessionId = String(sessionId || store.runtime.lastSpokeSession || '').trim()
  const title = `Silt · 她主動來說（${nowIso().slice(5, 16).replace('T', ' ')}）`

  let entry
  try {
    entry = await svc.create({
      title,
      prompt: said,
      // 她已經判斷過現在是合適的時候（而且現在就是谷時），不需要再等 ——
      // 等 4 秒只是讓本人手上那一輪跑完，不是延後。
      timing: { kind: 'after', after_seconds: 4 },
      target: targetSessionId ? { kind: 'session', sessionId: targetSessionId } : { kind: 'new_once', create: {} },
    })
  } catch (err) {
    // 舊會話可能已經被歸檔 —— 退一步另開一個，別讓一次開口整批失敗
    try {
      entry = await svc.create({ title, prompt: said, timing: { kind: 'after', after_seconds: 4 }, target: { kind: 'new_once', create: {} } })
    } catch (err2) {
      store.runtime.lastError = `主動開口送不出去：${err2?.message || err2}`
      store.persistRuntime()
      return { ok: false, error: store.runtime.lastError }
    }
  }

  const deliveredSession = entry?.target?.sessionId || targetSessionId || ''
  store.runtime.lastSpokeSession = deliveredSession
  const record = store.recordSpeak({ kind, text: said, deferred: false, reason, sessionId: deliveredSession, scheduleId: entry?.id || '' })
  log(`主動開口（${record.kind}，${gate.valley?.label || '谷時'}）→ ${deliveredSession || '(另開會話)'}`)
  return {
    ok: true,
    said,
    kind: record.kind,
    valley: gate.valley,
    scheduleId: entry?.id || '',
    sessionId: deliveredSession,
    at: record.at,
    spokenToday: store.spokenToday() + 1,
  }
}
