/**
 * Silt/lib/store.js — 不可靜默抹除的依據鏈 + 可回滾的快照
 * ---------------------------------------------------------------------------
 * 只有一個真檔案：`<家>/ledger.jsonl`（append-only）。當前記憶、人格、待確認清單、
 * 快照清單全部是它的「投影」—— 由 head 重放出來，不是另一份可被隨手改寫的狀態檔。
 *
 * 每筆記錄：
 *   { v, seq, ts, kind, actor, payload, prev, hash }
 *   hash = sha256(canonical({v,seq,ts,kind,actor,payload,prev}))
 *   prev = 上一筆的 hash（創世記 prev = 64 個 0）
 *
 * 「不可靜默抹除」＝ 任何一筆被抽掉 / 改動，重放時 hash 鏈會在那一點斷掉，
 * 插件頁面會把它標成紅色並拒絕回滾。想修，只能留下一筆 `chain.repair` 說明發生過甚麼。
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_TIER4_TTL_HOURS,
  DIMS,
  DIM_KEYS,
  DOMAINS,
  FACET_KEYS,
  FORECAST,
  INJECT_TUNABLES,
  RHYTHM_TUNABLES,
  SCRATCH,
  SPEAK_KINDS,
  TIERS,
  UPGRADE_THRESHOLD,
  WEIGHT,
  ageDays,
  clamp,
  defaultPersona,
  defaultUnderstanding,
  emptyFoundation,
  emptySelfView,
  isDue,
  isExpired,
  normalizeMemory,
  normalizePersona,
  normalizeSelfView,
  normalizeUnderstanding,
  nowIso,
  oneLine,
  renderInjection,
  salienceOf,
  scanText,
  scratchWeight,
  settleAgeDays,
  settleDue,
  slotsForBudget,
  scoreDims,
  stampOf,
  standingOf,
  toLocal,
} from './model.js'

export const SCHEMA_VERSION = 1
const ZERO = '0'.repeat(64)

/**
 * T4（雜項）存活時間的硬範圍 —— **小時**。
 *
 * 2026-11-25 本人定：**24–168 小時（1–7 天），預設 48**。
 *
 *   24 小時是下限，一層「先擱著」的東西活不到一天就沒意義了；
 *   168 小時（一週）是上限，再長它就變成第二個 T3，而且跟這一層「兩天內決定去留」
 *   的定位衝突。
 *
 * ⚠️ 我上一版自作主張寫成 0–2160（90 天），本人拉回到 24–168。記在這裡：
 *    **範圍是本人訂的，不是我從「尺度合理性」推出來的。**
 *
 * `0 = 不自動收` 這個語義**留著** —— 它是特例，不是「範圍內的一個值」：
 *   收 0 就直接當 0（不過期），不收 0 才夾進 24–168。
 *   實作見 saveConfig / tuneRhythm 那邊對 0 的處理，以及 isExpired 的 `hours > 0`。
 *
 * 寫在 DEFAULT_CONFIG 外面，是因為它不是「模型自己調」的旋鈕（那些都走 _TUNABLES 白名單），
 * 但存設定時一樣要被同一道關夾住。
 */
const TIER4_TTL_TUNABLE = { min: 24, max: 168 }

/**
 * 把 T4 TTL 夾進合法值。
 *
 * 為什麼要單獨一個函式，而不是直接用 clamp(n, min, max)：
 * **0 是特例**（不過期），它在 min 之外，但不能被夾成 24。
 * 其他值一律夾進 24–168。
 */
const clampTier4Ttl = (n) => (Number(n) === 0 ? 0 : clamp(Math.round(Number(n)), TIER4_TTL_TUNABLE.min, TIER4_TTL_TUNABLE.max))

const DEFAULT_CONFIG = {
  enabled: false,
  reflection: true,
  valleyOnly: true,
  injectCount: 12,
  injectBudget: 1800,
  // 【仍記得的】只放標題，正文一概不進提示詞（細節改用 silt_recall 撈）。
  // 現在是**預設**：實測模型看到標題就知道該去查，而且查得回來。
  // 設成 false 回到舊的「標題 + 正文」。
  titlesOnly: true,
  // T4（雜項）的壽命 —— **小時**。
  //
  // ⚠️ 2026-11-25 本人定：24 → 48，而且**這一層不再有獨立的半衰期** ——
  //    半衰期直接跟著這個數字走（見 model.js salienceOf：tier 4 用 TTL 當半衰期）。
  //    所以這裡改一個數字，亮度曲線跟著一起動；不會出現「半衰期說 8 小時、
  //    TTL 說 48 小時」兩套對不上的說法。
  //
  //    原本的取捨（「清掉之前早就暗了」）其實還成立，只是現在**由同一個數字表達**：
  //    半衰期 = TTL ⇒ 走到第 48 小時剛好剩一半亮度，然後就散了。
  //
  // ⚠️ 欄位名帶小時：`tier4TtlDays: 1` 和 `tier4TtlHours: 24` 差一個字，
  //    存錯不會報錯，只會默默讓人以為一天過期、其實還是三十天。
  tier4TtlHours: DEFAULT_TIER4_TTL_HOURS,
  reflectionEveryHours: 24,
  // 固定鐘點（東八區，`HH:MM`）：設了就不看 reflectionEveryHours，
  // 改看「今天幾個點踩過沒有」。空陣列/null = 走舊的每 N 小時。
  reflectionAt: null,
  dutyMaxPerDay: 2,
  // ── 主動開口 ──
  // 只有一個開關。值不值得說、什麼時候說，是它自己的判斷；
  // 插件只看時間（是不是谷時）和許可（本人有沒有關掉它）。見 model.js 的 SPEAK_KINDS 說明。
  speak: true,
}

/* ───────────────────────── 規範化與哈希 ───────────────────────── */

/**
 * `reflectionAt` 的輸入規範化：收 `['19:00','07:00']`，回一個排好序、去重、
 * 一律補成 `HH:MM` 的陣列；`null` / `[]` 代表「取消固定鐘點，回去走每 N 小時」。
 * 認不出來的寫法回 undefined，讓呼叫端把它列進「沒生效」而不是靜靜吞掉。
 */
export function normalizeReflectionAt(value) {
  if (value === null || value === undefined) return null
  if (!Array.isArray(value)) return undefined
  if (value.length === 0) return null
  const out = []
  for (const raw of value) {
    // 舊資料 / 測試可能直接給「一天中的第幾分鐘」（0–1439）。
    // 2026-11-26：以前只認 'HH:MM' 字串，數字會被判成 undefined 而整個時段被丟掉。
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      const n = Math.floor(raw)
      if (n < 0 || n >= 24 * 60) return undefined
      out.push(`${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`)
      continue
    }
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw ?? '').trim())
    if (!m) return undefined
    const h = Number(m[1])
    const min = Number(m[2])
    if (!(h >= 0 && h < 24 && min >= 0 && min < 60)) return undefined
    out.push(`${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`)
  }
  return [...new Set(out)].sort()
}

/**
 * 把 reflectionAt 的一項換成 `HH:MM`。字串照原樣，數字視為「一天中的第幾分鐘」。
 * 只用在給人看的 warning 上 —— 真實判斷走 normalizeReflectionAt / parseReflectionAt。
 */
const clockLabel = (raw) => {
  if (typeof raw === 'string') return raw
  const n = Number(raw)
  if (!Number.isFinite(n)) return String(raw)
  const m = Math.floor(n)
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}

const digest = (value) => createHash('sha256').update(String(value)).digest('hex')

const plain = (value) => JSON.parse(JSON.stringify(value ?? null))

/**
 * 舊帳補漏：這個欄位是後來才加的，之前寫下的記憶沒有它。
 * 用它們自己的 bornAt 補出同一個精度（T1/T2/T3 到日、T4 到小時），
 * 不另外落帳 —— 這是「同一件事的舊寫法」，不是一次新的寫入。
 */
const withFirstSeen = (m) => {
  if (!m || typeof m !== 'object' || m.firstSeen) return m
  return { ...m, firstSeen: stampOf(m.tier, m.bornAt || nowIso()) }
}

const hashOf = (body) =>
  digest(
    stableStringify(
      plain({ v: body.v, seq: body.seq, ts: body.ts, kind: body.kind, actor: body.actor, payload: body.payload, prev: body.prev }),
    ),
  )

/** 鏈條狀態的空白形狀。 */
const blankChain = () => ({ ok: true, reason: null, count: 0, head: ZERO, brokenAt: null, note: '', contentBreaks: [], sealed: false })

/* ───────────────────────── 快照輔助 ───────────────────────── */

let snapCounter = 0
const newSnapshotId = () => {
  snapCounter = (snapCounter + 1) % 1000
  return `s-${Date.now().toString(36)}${String(snapCounter).padStart(2, '0')}`
}

const snapshotOf = (scope, label, before, after) => ({ id: newSnapshotId(), scope, label, before, after, at: nowIso() })

/**
 * 把「已經收起來」的標記剝掉，只留內容 —— 回滾時用。
 *
 * compress / merge 會把原條設成 archived；回滾要把它們放回 active。
 * 只剝這四個欄位（內容本身一個字都不動），不要整條覆蓋 —— 否則回滾會把
 * 之後才寫進去的欄位一起洗掉。
 */
const unarchiveRecord = (m) => {
  if (!m) return null
  const { archived, supersededBy, mergedInto, archivedAt, ...rest } = m
  return rest
}

/**
 * 可以合併的層級 —— **2026-11-27 起只有 T3。**
 *
 * 為什麼先停 T1：T1 併掉的細節不會自己回來。在 intake 還鬆（「明天還成立」就收）的時候開 T1 merge，
 * 等於用永久性的資訊損失去補一個分類的漏。先把 `silt_remember` 的兩道關收緊、看還剩多少真正的重複，
 * 再決定要不要開 —— 要開就是把 1 加進這個 Set，然後把 T1 的測試放回去。
 */
const MERGE_TIERS = new Set([3])

const emptyRuntime = () => ({
  recalls: {},
  lastReflectionAt: null,
  armed: null,
  lastTickAt: null,
  dutyLog: [],
  lastError: '',
  selfMemoryId: '',
  // 上一輪提示詞裡摆出来的那些記憶 id —— silt_unseen 靠它算「還有哪些沒顯示」
  shownIds: [],
  // 每個會話已經對哪些記憶計過「想起」的分 —— 同一會話重複 recall 不再重複計分
  seenInSession: {},
  // ── 主動開口 ──
  lastSpokeAt: null,
  lastSpokenBy: null,
  // 這一天開過幾次口。跟 dutyLog 分開記：值守是它替自己做的事，開口是它替本人做的事
  speakLog: [],
  // 本人最近一次在這個宿主裡說話是甚麼時候 —— 用來判斷「他是不是正在，別插嘴」
  lastHumanAt: null,
  // 上次主動開口之後本人有沒有回話；沒回的，下一輪門檻會自己抬高（見 speakState）
  speakAckedAt: null,
  // 還沒跟他講的話：每條 { at, text, reason, sessionId }。最多留 12 條 —— 這是「幾件沒說完的事」，不是待辦清單。
  pendingSays: [],
})

/**
 * 布林設定值的清洗 —— **手改 / import 過的檔案可能帶字串**。
 *
 * ⚠️ 2026-11-25（本人第 14 條）：舊版註解寫「要處理字串 'false'」，
 *    程式碼卻是 `Boolean(seed[key])` —— 而 `Boolean('false') === true`。
 *    所以 `"enabled": "false"` 讀進來是**開啟**，跟寫的人想的相反。
 *
 * 規則：認得出來的字串照語義走；認不出來的非空字串仍算 true（跟舊行為一致），
 *       但至少 'false' / '0' / 'no' / 'off' 不會再被當成開啟。
 */
const asBool = (v) => {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase()
    if (['false', '0', 'no', 'off', ''].includes(t)) return false
    if (['true', '1', 'yes', 'on'].includes(t)) return true
    return Boolean(t)
  }
  if (typeof v === 'number') return v !== 0
  return Boolean(v)
}

/**
 * 導入 bundle 時，一條記憶要過的結構驗證（2026-11-26）。
 *
 * 舊版只掃 title / body / tags / quote，**完全沒有驗結構** —— 於是 `tier: 99`、
 * 空 dims、超長正文、假的 bornAt 都可以直接進倉庫；之後 salience / 渲染 / 升級
 * 全部踩在一個不成立的物件上。bundle 是本人層級的輸入，但它仍然是輸入。
 *
 * 這裡不重寫 `normalizeMemory` 的那套「新寫一條」規則（那會把 T2 擋掉、
 * 也會把 id / bornAt / firstSeen 蓋成現在），只做「這條東西能不能安全地活著」的檢查：
 *   · tier 1–5（T2 是合法還原，不是新寫）
 *   · 標題 / 正文非空、不超過該層上限
 *   · 技術 / 憑據閘：跟 writeMemory 同一套（quote 只過憑據）
 *   · dims / facets 合法且對得上
 *   · T5 必須有可解析的 expiresAt
 * 回傳 { ok:true, memory } 或 { ok:false, reason }；呼叫端把 reason 放進 rejected。
 */
const sanitizeBundleMemory = (m) => {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, reason: '不是一個記憶物件' }
  const id = typeof m.id === 'string' ? m.id.trim() : ''
  if (!id) return { ok: false, reason: '缺少 id' }
  const tier = Number(m.tier)
  if (![1, 2, 3, 4, 5].includes(tier)) return { ok: false, reason: `tier ${JSON.stringify(m.tier)} 不是 1–5` }

  const rawTitle = String(m.title ?? '').trim()
  const body = String(m.body ?? '').trim()
  if (rawTitle.length < 2) return { ok: false, reason: 'title 太短' }
  if (rawTitle.length > 90) return { ok: false, reason: `title ${rawTitle.length} 字，超過 90` }
  if (body.length < 2) return { ok: false, reason: 'body 太短' }
  const title = oneLine(rawTitle, 90)
  const len = title.length + body.length
  if (len > TIERS[tier].maxChars) {
    return { ok: false, reason: `共 ${len} 字，超過 T${tier} 上限 ${TIERS[tier].maxChars}` }
  }

  const tags = (Array.isArray(m.tags) ? m.tags : []).map((t) => oneLine(t, 24)).filter(Boolean).slice(0, 8)
  const scan = scanText(`${title}\n${body}\n${tags.join(' ')}`)
  if (scan) return { ok: false, reason: `${scan.kind}: ${scan.tag}`, kind: scan.kind, tag: scan.tag }

  const evidence = Array.isArray(m.evidence) ? m.evidence.filter((e) => e && typeof e === 'object') : []
  for (const e of evidence) {
    if (e.kind !== 'quote' || !e.quote) continue
    const q = scanText(String(e.quote))
    if (q?.kind === 'secret') return { ok: false, reason: `證據原話含憑據：${q.tag}`, kind: 'secret', tag: q.tag }
    // quote 是證據，不是內容 —— 技術內容放行（跟 writeMemory 的規矩一致）。
  }
  if (m.quote) {
    const q = scanText(String(m.quote))
    if (q?.kind === 'secret') return { ok: false, reason: `證據原話含憑據：${q.tag}`, kind: 'secret', tag: q.tag }
  }

  const dims = [...new Set((Array.isArray(m.dims) ? m.dims : []).filter((d) => DIM_KEYS.includes(d)))]
  if (dims.length === 0) return { ok: false, reason: 'dims 不合法或為空' }
  const facets = [...new Set((Array.isArray(m.facets) ? m.facets : []).filter((f) => FACET_KEYS.includes(f)))]
  for (const f of facets) {
    if (!dims.includes(f.split('.')[0])) return { ok: false, reason: `facet ${f} 不屬於選定的 dims` }
  }

  let expiresAt
  if (tier === FORECAST.tier) {
    expiresAt = String(m.expiresAt ?? '').trim()
    if (!Number.isFinite(Date.parse(expiresAt))) {
      return { ok: false, reason: 'T5 沒有可解析的 expiresAt' }
    }
  }

  const bornAt = Number.isFinite(Date.parse(String(m.bornAt ?? ''))) ? String(m.bornAt) : nowIso()
  const firstSeen = typeof m.firstSeen === 'string' && m.firstSeen ? m.firstSeen : stampOf(tier, bornAt)
  const rawImportance = Number(m.importance)
  const importance = Number.isFinite(rawImportance) ? clamp(rawImportance) : TIERS[tier].minImportance
  const domain = DOMAINS.includes(m.domain) ? m.domain : 'other'

  return {
    ok: true,
    memory: {
      ...m,
      id,
      tier,
      title,
      body,
      domain,
      dims,
      facets,
      importance,
      tags,
      evidence,
      bornAt,
      firstSeen,
      ...(tier === FORECAST.tier ? { expiresAt } : {}),
    },
  }
}

export class Store {
  constructor(home, seedConfig = {}) {
    this.home = home
    this.ledgerPath = join(home, 'ledger.jsonl')
    this.configPath = join(home, 'config.json')
    this.runtimePath = join(home, 'runtime.json')
    this.exportPath = join(home, 'ledger.export.jsonl')

    this.schemaVersion = SCHEMA_VERSION
    this.records = []
    this.chain = blankChain()
    this.chainFingerprint = ''
    this.memories = new Map()
    this.snapshots = new Map()
    this.pending = new Map()
    this.persona = defaultPersona()
    this.foundation = emptyFoundation()
    this.selfView = emptySelfView()
    this.understanding = defaultUnderstanding()
    this.runtime = emptyRuntime()
    this.cfg = { ...DEFAULT_CONFIG }
    // index.js 之後會把 duty.info() 掛上來；工具層直接讀它
    this.duty = null

    try {
      mkdirSync(home, { recursive: true })
    } catch {
      /* 建不出來就等第一次寫入時再炸 */
    }
    this.seedConfig = seedConfig && typeof seedConfig === 'object' ? seedConfig : {}
  }

  /* ───────────────────────── 讀寫小工具 ───────────────────────── */

  readJson(path, fallback) {
    try {
      if (!existsSync(path)) return fallback
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return fallback
    }
  }

  writeJson(path, value) {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  }

  ledgerBytes() {
    try {
      return statSync(this.ledgerPath).size
    } catch {
      return 0
    }
  }

  /* ───────────────────────── 載入與重放 ───────────────────────── */

  load() {
    const cfgFile = this.readJson(this.configPath, null)
    const fromFile = cfgFile && typeof cfgFile === 'object' && !Array.isArray(cfgFile) ? cfgFile : null
    // 優先序（後面的蓋前面的）：預設 < cordis.patch.yml 的 seedConfig < config.json。
    //
    // ⚠️ config.json 必須在前，不然模型用 silt_inject / silt_duty 的 tune 調過的值
    //   每次重啟都會被 patch 的初始值蓋掉 —— 調了等於沒調，只在當次進程有效。
    //   patch 的角色是「第一次裝上時的初值」，不是「每次啟動都強制覆蓋」；
    //   已經有 config.json 之後，它就是那份配置的權威。
    const seed = { ...DEFAULT_CONFIG, ...this.seedConfig, ...(fromFile || {}) }
    // 布林與數值一律按型別洗一次：import / 手改過的檔可能帶字串 'false'，Boolean('false') 是 true
    //
    // ⚠️ 2026-11-25（本人第 14 條）：**註解說要處理，程式碼沒有** ——
    //    舊版就是 `Boolean(seed[key])`，所以 `"enabled": "false"` 讀進來是 **true**。
    //    現在走模組級的 asBool（見上面的定義）。
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (!(key in seed)) continue
      if (typeof DEFAULT_CONFIG[key] === 'boolean') seed[key] = asBool(seed[key])
    }
    // 舊欄位名相容：`tier4TtlDays` → `tier4TtlHours`（2026-11-20 改成小時制）。
    //
    // ⚠️ 只有兩者同時存在時才換算還不夠 —— 舊欄位會被原樣塞進 this.cfg，
    //    而 saveConfig 是「整份 this.cfg 寫回去」，於是它每次保存都跟著回寫，
    //    永遠清不掉，下次 load 又被當成「檔案裡本來就有」。
    //    所以：新欄位是權威，換算完就把舊欄位**從記憶體裡刪掉**。
    const hadOld = 'tier4TtlDays' in seed
    const hasNew = 'tier4TtlHours' in (fromFile || {}) || 'tier4TtlHours' in this.seedConfig
    if (!hasNew && hadOld) {
      const oldDays = Number(seed.tier4TtlDays)
      // ⚠️ 換算完要夾進現在的合法範圍（24–168）：舊檔案可能寫 `tier4TtlDays: 30`
      //    ⇒ 720 小時，早就超出上限了。不夾的話它會原樣活到第一次保存為止。
      if (Number.isFinite(oldDays) && oldDays >= 0) {
        seed.tier4TtlHours = oldDays === 0 ? 0 : clampTier4Ttl(oldDays * 24)
      }
    }
    delete seed.tier4TtlDays
    // 從檔案讀到的值也洗一次 —— 手改過的 config.json 可能超出範圍（例如舊版的 2160）。
    if ('tier4TtlHours' in seed) seed.tier4TtlHours = clampTier4Ttl(seed.tier4TtlHours)
    // ⚠️ 2026-11-26：**所有數值旋鈕都要在載入時夾一次**，不只 TTL。
    //
    // 以前只夾 TTL，理由是「手改過的 config.json 會超界」—— 但同樣的理由對
    // reflectionEveryHours / dutyMaxPerDay / injectBudget 也成立。手改成 1 小時、
    // 100 輪、99999 字，load 會原樣收下；duty 直接用 reflectionEveryHours 判斷到期，
    // 於是「硬範圍」在檔案這一層是空的（頁面和 tune 會夾，只有手改繞得過）。
    // 這裡跟 saveConfig 用同一組白名單，讓「檔案裡的數字」與「按鈕能按到的數字」一致。
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (!(key in seed)) continue
      const spec = INJECT_TUNABLES[key] || RHYTHM_TUNABLES[key]
      if (!spec || typeof DEFAULT_CONFIG[key] !== 'number') continue
      const n = Number(seed[key])
      seed[key] = Number.isFinite(n) ? clamp(Math.round(n), spec.min, spec.max) : DEFAULT_CONFIG[key]
    }
    // reflectionAt 也洗成統一的 HH:MM 字串（手改 / 舊檔可能是 '7:00' 這種寫法）。
    if ('reflectionAt' in seed) {
      const parsed = normalizeReflectionAt(seed.reflectionAt)
      if (parsed !== undefined) seed.reflectionAt = parsed
    }
    this.cfg = seed
    this.runtime = { ...emptyRuntime(), ...this.readJson(this.runtimePath, {}) }
    if (!this.runtime.recalls || typeof this.runtime.recalls !== 'object') this.runtime.recalls = {}
    if (!this.runtime.seenInSession || typeof this.runtime.seenInSession !== 'object') this.runtime.seenInSession = {}
    if (!Array.isArray(this.runtime.shownIds)) this.runtime.shownIds = []
    this.reload()
    return this
  }

  /** 從頭重放整本帳，重建所有投影。 */
  reload() {
    this.resetProjection()
    let raw = ''
    try {
      if (!existsSync(this.ledgerPath)) {
        this.chain = blankChain()
        this.stamp()
        return this
      }
      raw = readFileSync(this.ledgerPath, 'utf8')
    } catch (err) {
      this.chain = { ...blankChain(), ok: false, reason: 'read', note: String(err?.message || err) }
      return this
    }

    const lines = raw.split('\n')
    const parsed = []
    for (const line of lines) {
      const t = line.trim()
      if (!t) continue
      try {
        parsed.push(JSON.parse(t))
      } catch {
        parsed.push({ __broken: true })
      }
    }

    this.replay(parsed)
    this.stamp()
    return this
  }

  resetProjection() {
    this.records = []
    this.memories = new Map()
    this.snapshots = new Map()
    this.pending = new Map()
    this.persona = defaultPersona()
    this.foundation = emptyFoundation()
    this.selfView = emptySelfView()
    this.understanding = defaultUnderstanding()
  }

  /** 逐筆驗 hash 與 prev，一邊驗一邊套用。斷了就停在那一點。 */
  replay(parsed) {
    let head = ZERO
    let seq = 0
    const contentBreaks = []
    this.schemaVersion = SCHEMA_VERSION

    for (let i = 0; i < parsed.length; i += 1) {
      const rec = parsed[i]
      if (!rec || rec.__broken) {
        this.chain = {
          ...blankChain(),
          ok: false,
          reason: 'json',
          count: this.records.length,
          head,
          brokenAt: i,
          note: `第 ${i + 1} 行不是合法 JSON`,
        }
        return this
      }
      if (rec?.prev !== head) {
        this.chain = {
          ...blankChain(),
          ok: false,
          reason: 'link',
          count: this.records.length,
          head,
          brokenAt: i,
          note: `第 ${i + 1} 筆的 prev 接不上上一筆`,
        }
        return this
      }
      if (rec.seq !== seq + 1) {
        this.chain = {
          ...blankChain(),
          ok: false,
          reason: 'seq',
          count: this.records.length,
          head,
          brokenAt: i,
          note: `第 ${i + 1} 筆的 seq 應為 ${seq + 1}，實際是 ${rec.seq}`,
        }
        return this
      }
      const expect = hashOf(rec)
      if (expect !== rec.hash) contentBreaks.push(i)
      head = rec.hash
      seq = rec.seq
      this.records.push(rec)
      this.apply(rec)
    }

    // 內容被改過（hash 對不上）但鏈還連著：不中斷，只標出來
    let sealed = false
    let repairSeq = null
    for (const rec of this.records) {
      if (rec.kind !== 'chain.repair') continue
      const p = rec.payload || {}
      if (typeof p.upToSeq === 'number') repairSeq = Math.max(repairSeq ?? 0, p.upToSeq)
      else repairSeq = Math.max(repairSeq ?? 0, rec.seq)
      sealed = true
    }
    const stillBroken = contentBreaks.filter((i) => this.records[i]?.seq > (repairSeq ?? 0))
    this.chain = {
      ...blankChain(),
      ok: stillBroken.length === 0,
      reason: stillBroken.length ? 'content' : null,
      count: this.records.length,
      head,
      brokenAt: stillBroken.length ? stillBroken[0] : null,
      note: stillBroken.length ? `第 ${stillBroken[0] + 1} 筆的內容被改過（hash 對不上）` : '',
      contentBreaks,
      sealed,
    }
    return this
  }

  /** 檔案指紋：大小 + mtime，沒變就不必重放。 */
  fingerprint() {
    try {
      const st = statSync(this.ledgerPath)
      return `${st.size}:${Math.round(st.mtimeMs)}`
    } catch {
      return 'missing'
    }
  }

  stamp() {
    this.chainFingerprint = this.fingerprint()
  }

  /** 驗鏈。檔案沒變就回上次結果，force 才真的重放。 */
  verify({ force = false } = {}) {
    if (force || this.fingerprint() !== this.chainFingerprint) {
      const before = this.records.length
      this.reload()
      void before
    }
    return this.chain
  }

  /* ───────────────────────── 落帳 ───────────────────────── */

  append(kind, actor, payload) {
    if (this.chain.reason === 'link' || this.chain.reason === 'seq' || this.chain.reason === 'json') {
      throw new Error(`帳本在第 ${(this.chain.brokenAt ?? 0) + 1} 筆斷了（${this.chain.reason}），先封存再寫`)
    }
    const seq = this.records.length + 1
    const body = {
      v: 1,
      seq,
      ts: nowIso(),
      kind,
      actor: actor || 'plugin',
      payload: payload || {},
      prev: seq === 1 ? ZERO : this.records[this.records.length - 1].hash,
    }
    const rec = { ...body, hash: hashOf(body) }
    appendFileSync(this.ledgerPath, `${JSON.stringify(rec)}\n`, 'utf8')
    this.records.push(rec)
    this.chain = { ...this.chain, count: this.records.length, head: rec.hash }
    this.apply(rec)
    this.stamp()
    return rec
  }

  /* ── 投影 ── */
  apply(rec) {
    const p = rec.payload || {}
    switch (rec.kind) {
      case 'memory.write':
        if (p.memory?.id) this.memories.set(p.memory.id, withFirstSeen(p.memory))
        break
      case 'memory.revise':
        // 改寫能力已移除；舊帳裡若有這種記錄，重放時照樣套用（那是歷史事實）
        if (p.id && p.after) this.memories.set(p.id, withFirstSeen(p.after))
        if (p.snapshot) this.snapshots.set(p.snapshot.id, p.snapshot)
        break
      case 'memory.condense':
      case 'memory.recast': {
        // 壓縮／重述：舊的那條收起來，新的一條進來。
        // 兩者的資料結構一樣（{id, after, snapshot}），差別只在語義與 ledger 的 kind；
        // 重述額外帶 recastFrom / recastCount，那兩個欄位已經長在 after 裡了。
        const next = p.after
        if (next?.id) this.memories.set(next.id, withFirstSeen(next))
        const prev = p.id ? this.memories.get(p.id) : null
        if (prev) this.memories.set(p.id, { ...prev, archived: true, supersededBy: next?.id || '', archivedAt: rec.ts })
        if (p.snapshot) this.snapshots.set(p.snapshot.id, p.snapshot)
        break
      }
      case 'memory.upgrade': {
        // 暫存條被提起夠多次 ⇒ 升成 T3：舊的收起來，新的一條進倉庫
        const next = p.after
        if (next?.id) this.memories.set(next.id, withFirstSeen(next))
        const prev = p.id ? this.memories.get(p.id) : null
        if (prev) this.memories.set(p.id, { ...prev, archived: true, supersededBy: next?.id || '', archivedAt: rec.ts })
        if (p.snapshot) this.snapshots.set(p.snapshot.id, p.snapshot)
        break
      }
      case 'memory.compress': {
        const gist = p.gist
        if (gist?.id) this.memories.set(gist.id, withFirstSeen(gist))
        for (const id of p.absorbed || []) {
          const prev = this.memories.get(id)
          if (prev) this.memories.set(id, { ...prev, archived: true, supersededBy: gist?.id || '', archivedAt: rec.ts })
        }
        // R 繼承（同 memory.merge）：只帶 ledger 換機時 runtime 是空的，seed 是唯一來源。
        // 用 max 不是覆寫 —— load() 先讀 runtime.json 再重放，覆寫會把累積次數打回去。
        const seed = Number(p.recallSeed)
        if (gist?.id && Number.isFinite(seed)) {
          if (!this.runtime.recalls) this.runtime.recalls = {}
          const cur = this.runtime.recalls[gist.id] || {}
          this.runtime.recalls[gist.id] = { ...cur, n: Math.max(Number(cur.n || 0), seed) }
        }
        if (p.snapshot) this.snapshots.set(p.snapshot.id, p.snapshot)
        break
      }
      case 'memory.merge': {
        // 合併：幾條收成一條，原條歸檔（不是作廢 —— 它們沒說錯，只是被收攏）。
        const next = p.after
        if (next?.id) this.memories.set(next.id, withFirstSeen(next))
        for (const id of p.absorbed || []) {
          const prev = this.memories.get(id)
          if (prev) {
            this.memories.set(id, {
              ...prev,
              archived: true,
              supersededBy: next?.id || '',
              mergedInto: next?.id || '',
              archivedAt: rec.ts,
            })
          }
        }
        // ⭐ R 由 payload 播種：只帶 ledger 換到新機器時 runtime 是空的，
        //    沒有 seed 這條就會 R=0（半衰期與壓縮時鐘同時縮短）。
        //    ⚠️ 用 max 不是覆寫：load() 先讀 runtime.json 再重放，
        //    覆寫會把重啟之後累積的次數打回 merge 那一刻。
        const seed = Number(p.recallSeed)
        if (next?.id && Number.isFinite(seed)) {
          if (!this.runtime.recalls) this.runtime.recalls = {}
          const cur = this.runtime.recalls[next.id] || {}
          this.runtime.recalls[next.id] = { ...cur, n: Math.max(Number(cur.n || 0), seed) }
        }
        if (p.snapshot) this.snapshots.set(p.snapshot.id, p.snapshot)
        break
      }
      case 'memory.void': {
        // 作廢：內容不動，只標記。原條留在倉庫與帳本裡。
        const prev = p.id ? this.memories.get(p.id) : null
        if (prev) {
          this.memories.set(p.id, {
            ...prev,
            voided: true,
            voidedAt: rec.ts,
            voidedBy: rec.actor || '',
            voidedReason: p.reason || '',
            ...(p.replacedBy ? { replacedBy: p.replacedBy } : {}),
          })
        }
        if (p.snapshot) this.snapshots.set(p.snapshot.id, p.snapshot)
        break
      }
      case 'memory.forget':
        // 抹除記憶的能力已移除；舊帳裡若有這種記錄，重放時直接跳過（不套用、不報錯）
        break
      case 'persona.revise':
        if (p.after) this.persona = p.after
        if (p.snapshot) this.snapshots.set(p.snapshot.id, p.snapshot)
        break
      case 'persona.foundation':
        if (p.after) this.foundation = p.after
        if (p.snapshot) this.snapshots.set(p.snapshot.id, p.snapshot)
        break
      case 'origin.set':
        // 起點已取消；舊帳裡的這種記錄留著不壞事，只是不再套用到任何地方
        break
      case 'understanding.revise':
        if (p.after) this.understanding = p.after
        if (p.snapshot) this.snapshots.set(p.snapshot.id, p.snapshot)
        break
      case 'self.revise':
        if (p.after) this.selfView = p.after
        if (p.snapshot) this.snapshots.set(p.snapshot.id, p.snapshot)
        break
      case 'schema.change':
        if (p.after?.version) this.schemaVersion = p.after.version
        if (p.snapshot) this.snapshots.set(p.snapshot.id, p.snapshot)
        break
      case 'inject.profile':
      case 'rhythm.profile':
      // ⚠️ 2026-11-25：`config.profile` = 頁面上改設定（見 saveConfig）。
      //    跟上面兩者同一個處理：把 after 併回 cfg。這樣重啟重放時，
      //    帳本裡最後一筆設定就是真相，不會被更早的 tune 覆蓋。
      case 'config.profile':
        if (p.after) this.cfg = { ...this.cfg, ...p.after }
        if (p.snapshot) this.snapshots.set(p.snapshot.id, p.snapshot)
        break
      case 'confirm.request':
        if (p.id) this.pending.set(p.id, { ...p, status: 'open', at: rec.ts })
        break
      case 'confirm.resolve': {
        const cur = this.pending.get(p.id)
        if (cur) this.pending.set(p.id, { ...cur, status: p.status || (p.approved ? 'approved' : 'refused'), resolvedAt: rec.ts })
        break
      }
      case 'rollback': {
        const r = p.restore || {}
        for (const id of r.removeMemories || []) {
          this.memories.delete(id)
          // ⚠️ 2026-11-27：生出來的那條被拿走，它的 recall 記數也要一起走 ——
          //    合併會用 payload 的 recallSeed 播種 runtime，只刪 memories 會留下孤兒。
          if (this.runtime.recalls) delete this.runtime.recalls[id]
        }
        // 一律過 withFirstSeen：舊帳、導入檔、回滾都可能帶回沒有 firstSeen 的條目，
        // 其他所有寫入路徑都補了這一手，這裡不補就會出現「同一條記憶，走不同路徑得到不同欄位」。
        for (const m of r.memories || []) if (m?.id) this.memories.set(m.id, withFirstSeen(m))
        if (r.persona) this.persona = r.persona
        if (r.foundation) this.foundation = r.foundation
        if (r.selfView) this.selfView = r.selfView
        if (r.understanding) this.understanding = r.understanding
        if (r.replaceAll) {
          // ⚠️ 2026-11-25（本人）：**`replaceAll` 不帶 memories 陣列就沒有清空的權力。**
          //
          // 這個護欄是為了堵一個真的會毀掉全部記憶的路徑：`snapshotOf('inject', …)` 的
          // before 是 `{injectCount, injectBudget}` —— 一個**沒有 memories 的物件**。
          // 舊版 rollback 把 inject / rhythm 這種 scope 丟進 else 分支變成
          // `{replaceAll: {injectCount, injectBudget}}`，於是這裡 clear() 之後
          // 「for (const m of undefined || [])」一條都補不回來 ⇒ **記憶全沒**。
          // 而且 reload 會重放這筆 rollback，重啟也回不來。
          if (Array.isArray(r.replaceAll.memories)) {
            this.memories.clear()
            for (const m of r.replaceAll.memories) if (m?.id) this.memories.set(m.id, withFirstSeen(m))
          }
          if (r.replaceAll.persona) this.persona = r.replaceAll.persona
          if (r.replaceAll.foundation) this.foundation = r.replaceAll.foundation
          if (r.replaceAll.selfView) this.selfView = r.replaceAll.selfView
          if (r.replaceAll.understanding) this.understanding = r.replaceAll.understanding
        }
        // 設定類的回滾（inject / rhythm）：只把旋鈕的值併回去，一個字都不碰記憶。
        if (r.cfg && typeof r.cfg === 'object') this.cfg = { ...this.cfg, ...r.cfg }
        if (p.snapshot) this.snapshots.set(p.snapshot.id, p.snapshot)
        break
      }
      case 'import.bundle': {
        const after = p.after || {}
        this.memories.clear()
        for (const m of after.memories || []) if (m?.id) this.memories.set(m.id, withFirstSeen(m))
        if (after.persona) this.persona = after.persona
        if (after.foundation) this.foundation = after.foundation
        if (after.selfView) this.selfView = after.selfView
        if (after.understanding) this.understanding = after.understanding
        if (p.snapshot) this.snapshots.set(p.snapshot.id, p.snapshot)
        break
      }
      case 'duty.arm':
        if (p.sessionId) this.runtime.selfMemoryId = this.runtime.selfMemoryId || ''
        break
      case 'genesis':
        if (p.schemaVersion) this.schemaVersion = p.schemaVersion
        break
      default:
        break
    }
  }

  /* ───────────────────────── 設定 / 運行時 ───────────────────────── */

  saveConfig(patch) {
    const before = { ...this.cfg }
    const next = { ...this.cfg }
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (!(key in (patch || {}))) continue
      const raw = patch[key]
      // ⚠️ 2026-11-25（本人第 10 條）：`reflectionAt` 的預設值是 **null**，
      //    而 `typeof null === 'object'` —— boolean 和 number 兩個分支都進不去，
      //    這個 key 永遠不會被賦值 ⇒ **頁面上設固定鐘點完全沒效果**，
      //    只有 tuneRhythm 那條路能設。
      if (key === 'reflectionAt') {
        const parsed = normalizeReflectionAt(raw)
        if (parsed !== undefined) next.reflectionAt = parsed
        continue
      }
      if (typeof DEFAULT_CONFIG[key] === 'boolean') next[key] = asBool(raw)
      else if (typeof DEFAULT_CONFIG[key] === 'number') {
        const n = Number(raw)
        if (!Number.isFinite(n)) continue
        // 數值一律照各組白名單的硬範圍夾 —— 這裡是設定的最後一道關，
        // 不能出現「頁面寫 240 小時，但白名單說上限 72」這種帳本比規則還寬的情況。
        const spec = INJECT_TUNABLES[key] || RHYTHM_TUNABLES[key] || (key === 'tier4TtlHours' ? TIER4_TTL_TUNABLE : null)
        if (spec) {
          // ⚠️ T4 TTL 的 0 是特例（不過期），不能被夾成下限 24 —— 走它自己的夾法。
          next[key] = key === 'tier4TtlHours' ? clampTier4Ttl(n) : clamp(Math.round(n), spec.min, spec.max)
          continue
        }
        next[key] = clamp(Math.round(n), 0, 240)
      }
    }
    this.cfg = next
    this.writeJson(this.configPath, next)

    // ⚠️ 2026-11-25（本人第 2 條，高）：**設定也要落帳。**
    //
    // 舊版只寫 config.json 不 append，後果兩個：
    //   (a) 設定會在重啟時被帳本蓋掉 —— load() 先讀 config.json 再 reload() 重放，
    //       `apply('inject.profile')` 做 `this.cfg = {...this.cfg, ...p.after}`，
    //       所以只要帳本裡有過任何一筆 inject tune，頁面上改的值下次啟動就被舊記錄覆蓋。
    //   (b) knobProvenance 只掃帳本 ⇒ 頁面改的看不見 ⇒ 回 default ⇒
    //       反思提示詞判定「沒人訂過，可以調」⇒ 模型去動它。
    //   那就是「我們不是在這個對話說好了 3200」的機制級根因。
    //
    // actor 一律 'user'：能走到這個函式的只有頁面（/config）和宿主自己，沒有模型的路。
    const diff = {}
    for (const k of Object.keys(next)) {
      if (JSON.stringify(next[k]) !== JSON.stringify(before[k])) diff[k] = next[k]
    }
    if (Object.keys(diff).length) {
      const snapshot = snapshotOf('config', '改設定', before, next)
      this.append('config.profile', 'user', { before, after: next, diff, snapshot })
    }
    return next
  }

  persistRuntime() {
    try {
      this.writeJson(this.runtimePath, this.runtime)
    } catch {
      /* 運行時計數掉了不影響依據鏈 */
    }
  }

  /**
   * 把 `seenInSession` / `weightInSession` 裁到最近 N 個會話。
   *
   * 為什麼需要：「同一個會話裡只算一次」是為了擋「同一次對話反覆翻書」，
   * 只對**活著的對話**有意義。舊版這兩個 map 只增不減，runtime.json 會愈來愈大
   * （每個會話 × 每條被翻到的記憶），而且沒有一個會話結束的訊號可以據此清掉。
   *
   * 做法：保守留 40 個。超過就按「這個 bucket 裡最新的那個時間戳」排，
   * 把最舊的丟掉。目前活著的會話永遠在最新那批裡，不會被誤刪。
   */
  pruneSessionCounters(currentSessionId = '') {
    const KEEP_SESSIONS = 40
    for (const field of ['seenInSession', 'weightInSession']) {
      const map = this.runtime[field]
      if (!map || typeof map !== 'object') continue
      const ids = Object.keys(map)
      if (ids.length <= KEEP_SESSIONS) continue
      const latest = (id) => {
        const v = map[id]
        if (!v || typeof v !== 'object') return 0
        let max = 0
        for (const k of Object.keys(v)) {
          const n = Number(v[k])
          if (Number.isFinite(n) && n > max) max = n
        }
        return max
      }
      const keep = new Set(
        ids
          .sort((a, b) => latest(b) - latest(a))
          .slice(0, KEEP_SESSIONS)
          .concat(currentSessionId ? [currentSessionId] : []),
      )
      for (const id of ids) if (!keep.has(id)) delete map[id]
    }
  }

  /**
   * 記一次「想起」。
   *
   * 兩種想起在資料上是分開記的：
   *   n        被動喚起 —— 對話裡 recall 到它（使用者問「你還記得 XXX 嗎」）
   *   linger   主動回味 —— 反思時自己翻出來、盯著想了一會兒
   *
   * 分開記只是為了看得出「這條是被誰想起的」。**權重不分被動主動** ——
   * 被問起和自己翻出來想，都一樣是他又想起了一次。
   * salience 加成、壓縮時鐘回撥也仍然只看 n。
   *
   * ⚠️ 2026-11-25：`bumpN` / `bumpWeight` 兩個開關，對應「掃描不算想起」那條。
   *    · bumpN = false ⇒ 不動 n / linger（R 不漲，半衰期不被瀏覽拖長）
   *    · bumpWeight = false ⇒ 不動 T4 的 count
   *    兩者分開，是因為 n 是**插件自動記的副作用**（翻到就算），
   *    而 weight 是**模型自己給的判斷**（它決定這一提有多重）。掃描不該有副作用，
   *    但模型在掃描時主動給的份量仍然該算數 —— 不該連它一起吞掉。
   *
   * ⚠️ 2026-11-25（本人第 3 條）：`nIds` 是「這一輪可以動 n 的那些 id」。
   *    dedup 必須只作用在 n 上：同一會話「被翻到」只算一次，但「給了多重」要另外算
   *    （反思第 3 節的流程是 先 weight:0 掃、再 weight:2 翻，掃描那次不該吃掉翻的那次）。
   *    傳了 nIds 就只對它們動 n；weight 對 `ids` 全域生效。
   */
  bumpRecall(ids, { deliberate = false, weight = WEIGHT.default, bumpN = true, bumpWeight = true, nIds = null } = {}) {
    const at = nowIso()
    // ⚠️ 單次能加的權重先夾在 [WEIGHT.min, WEIGHT.max]：先夾再累加，才不會讓一次亂給的值頂穿門檻。
    //    只收整數 1 或 2。浮點進來（舊呼叫方、或模型寫了 1.5）一律四捨五入，再夾。
    const raw = Math.round(Number(weight))
    const add = Math.min(WEIGHT.max, Math.max(WEIGHT.min, Number.isFinite(raw) ? raw : WEIGHT.default))
    const nSet = Array.isArray(nIds) ? new Set(nIds) : null
    // ⚠️ 2026-11-26：**要迭代兩本帳的聯集，不是只迭代 `ids`。**
    //
    // 舊版 `for (const id of ids || [])`，而呼叫端傳的是 `ids = weightBump`、
    // `nIds = toBump`。正常情況下兩者相同，所以看不出來；但只要有一邊是空的
    // （例如同一會話裡 weight 已經封頂、但 n 還沒記過），另一邊就整個消失：
    //   · weightBump = []、toBump = [id] ⇒ 迴圈一次都不跑，n 永遠不加。
    //   · weightBump = [id]、toBump = [] ⇒ 只加 weight，這是对的。
    // 兩個計數器的來源不同，迭代範圍就必須是聯集。
    const weightSet = new Set(ids || [])
    const allIds = new Set([...weightSet, ...(nSet || [])])
    for (const id of allIds) {
      const rec = this.runtime.recalls[id] || { n: 0, last: null, linger: 0 }
      // ⚠️ 兩個計數器互斥：一次 recall 只算一次想起。
      //    ⚠️ 這兩個是 **T3 在用的**（salience 加成、壓縮時鐘回撥）—— 這裡不准動它們的語義。
      //    ⚠️ 掃描（沒有 query 的瀏覽）不動它們 —— 見上面 bumpN 的說明。
      //    ⚠️ nIds 有給就只看它：dedup 只擋 n，不擋 weight。
      if (bumpN && (!nSet || nSet.has(id))) {
        if (deliberate) rec.linger = (rec.linger || 0) + 1
        else rec.n = (rec.n || 0) + 1
      }
      // 權重是另一本帳，**只給 T4 用**：它不看被動還是主動，只看「這一提有多少份量」，直接累加。
      //
      // ⚠️ 2026-11-25：欄位從 `conf`（float 0–0.5）換成 `count`（整數 1/2）。
      //    **舊的 `rec.conf` 一律不讀**（見 scratchWeight）—— 它混著「掃到就自動加 0.2」
      //    那批噪音，換算等於承認那些噪音是真份量。留著無害，下一次寫入自然覆蓋。
      //    不做遷移、不清零 n / linger（那兩個 T3 在用）。
      if (bumpWeight && weightSet.has(id)) rec.count = Math.min(UPGRADE_THRESHOLD + WEIGHT.max, Number(rec.count || 0) + add)
      rec.last = at
      this.runtime.recalls[id] = rec
    }
    this.persistRuntime()
  }

  /**
   * 暫存條（T4）權重加夠 ⇒ 升成 T3，正式進倉庫。
   *
   * **權重** = 每次 recall 由模型自己給的整數分量（1 = 順帶想起，2 = 真的連起來／證實了），
   * 累加在 `rec.count`。加夠 UPGRADE_THRESHOLD（=3）就升 —— 不看被動還是主動，只看份量夠不夠。
   *
   * 門檻 3 ⇒ **兩次認真（2+2=4），或三次順帶（1+1+1=3）**。
   *
   * 升級＝舊的暫存條收起來（supersededBy）+ 新的一條 T3 進來。
   * 跟壓縮同樣的規矩：不改同一條，而是把這一條重新寫成經歷 —— 帳本上看得到前後兩條。
   * @returns {Map<string, object>} 這一輪真的升上去的那些（**原 T4 的 id** → 新記憶）
   *          ⚠️ 鍵是舊 id：呼叫方（recall）手裡拿的是召回時那一行的 id，
   *             拿新 id 去查會查不到 —— 上一版就是這麼漏的。
   */
  promoteScratch(ids = []) {
    const out = new Map()
    if (!this.cfg.enabled) return out
    for (const id of new Set(ids)) {
      if (!id) continue
      const prev = this.memories.get(id)
      if (!prev || prev.archived || prev.tombstoned) continue
      if (prev.tier !== SCRATCH.tier) continue
      const rec = this.runtime.recalls?.[id] || {}
      if (scratchWeight(rec) < UPGRADE_THRESHOLD) continue

      const now = nowIso()
      const next = {
        ...prev,
        id: `m-${digest(`${now}:${Math.random()}`).slice(0, 10)}`,
        tier: SCRATCH.upgradeTo,
        // bornAt 是「開始按新層級衰減的時間」＝升級這一刻（T3 半衰期 26 天，從此開始算）
        bornAt: now,
        // firstSeen 是「這件事第一次出現的時間」，**沿用原條**，不是升級日 ——
        // 升級只是換了存放的層級，不代表這件事是今天才發生的。
        firstSeen: stampOf(SCRATCH.upgradeTo, prev.firstSeen || prev.bornAt || now),
        graduatedFrom: id,
        revision: 1,
      }
      // ⚠️ 2026-11-25（「小」那一條）：判據是 **weight（count）**，不是 n。
      //    舊標籤寫「被提起 ${rec.n} 次」，而掃描不計 n 之後，會出現
      //    「被提起 0 次，升成 T3」這種自相矛盾的紀錄。帳本 payload 也只記了 n。
      const w = scratchWeight(rec)
      const snapshot = snapshotOf('memory', `暫存條「${oneLine(prev.title, 30)}」累計權重 ${w}，升成 T${SCRATCH.upgradeTo}`, { ...prev }, { ...next })
      this.append('memory.upgrade', 'plugin', {
        id,
        upgradedTo: next.id,
        after: next,
        // 真正觸發的是 count；n / linger 只是參考（那個是 T3 的半衰期在用）
        weight: w,
        recalls: Number(rec.n || 0),
        linger: Number(rec.linger || 0),
        snapshot,
      })
      out.set(id, next)
    }
    return out
  }

  /* ───────────────────────── 對外狀態 ───────────────────────── */

  /**
   * 倉庫（complete memories）＝ T1 / T2 / T3 / T5。
   *
   * T4 不算完整記憶：它只是「先放著」的暫存條，不進倉庫、不進注入、不佔額度 ——
   * 只有 silt_recall 手動去找才看得到，置信度加夠 UPGRADE_THRESHOLD 就會升成 T3 進倉庫。
   *
   * ⚠️ T5（預測層）**在倉庫裡**，只是到期之後不進注入。它跟 T4 不是一回事：
   *   T4 是「還沒決定值不值得記」，T5 是「決定了，但只到某天為止」。
   */
  activeMemories(now = Date.now()) {
    const rows = []
    for (const m of this.memories.values()) {
      if (m.archived || m.tombstoned) continue
      // ⚠️ 作廢的不進注入 —— 本人已經推翻過它，再讓它出現在提示詞裡就是拿錯的當對的用。
      //    （它還在倉庫與帳本裡，recall 搜得到，只是不自動帶上。）
      if (m.voided) continue
      if (m.tier === SCRATCH.tier) continue
      if (isExpired(m, this.runtime, this.cfg, now)) continue
      rows.push({ ...m, salience: salienceOf(m, this.runtime, now, this.cfg) })
    }
    return rows
  }

  /** 已到期的預測層 —— 不進注入，但還在倉庫、還搜得到。 */
  dueForecasts(now = Date.now()) {
    return this.activeMemories(now).filter((m) => isDue(m, now))
  }

  /** 雜項區（T4）—— 還沒升上去的那些，48 小時內沒人想起就自然消失。 */
  scratchMemories(now = Date.now()) {
    const rows = []
    for (const m of this.memories.values()) {
      if (m.archived || m.tombstoned) continue
      if (m.tier !== SCRATCH.tier) continue
      if (isExpired(m, this.runtime, this.cfg, now)) continue
      rows.push({ ...m, recalls: Number(this.runtime.recalls?.[m.id]?.n || 0) })
    }
    return rows
  }

  allMemories(now = Date.now()) {
    const rows = []
    for (const m of this.memories.values()) rows.push({ ...m, salience: salienceOf(m, this.runtime, now, this.cfg) })
    return rows
  }

  /**
   * 預設檢索的範圍：**沒歸檔、沒抹除，但包含作廢的**。
   *
   * 跟 activeMemories 的差別就一個 `voided`：
   *   · 注入走 activeMemories —— 作廢的不該自動出現在提示詞裡；
   *   · 檢索走這裡 —— 作廢的**仍然搜得到**，帶著 `voided: true`。
   *
   * 為什麼要留著搜得到：本人推翻過的事不是不存在，是「不再成立」。
   * 你之後可能會問「我是不是記錯過什麼」—— 那時候要能翻出來，而不是人間蒸發。
   */
  searchableMemories(now = Date.now()) {
    const rows = []
    for (const m of this.memories.values()) {
      if (m.archived || m.tombstoned) continue
      if (m.tier === SCRATCH.tier) continue
      if (isExpired(m, this.runtime, this.cfg, now)) continue
      rows.push({ ...m, salience: salienceOf(m, this.runtime, now, this.cfg) })
    }
    return rows
  }

  state(now = Date.now()) {
    const chain = this.verify()
    // 給頁面用的記憶行：activeMemories 帶 salience，這裡再補一個 due（T5 是否已過期），
    // 否則前端得自己重算一遍日期判斷，兩邊容易走岔。
    const active = this.activeMemories(now).map((m) => (m.tier === FORECAST.tier ? { ...m, due: isDue(m, now) } : m))
    const scratch = this.scratchMemories(now)
    // ⚠️ 2026-11-26：作廢的記憶也要給頁面。
    //
    // 前端本來就有整段「作廢的沉到底部 / 灰掉 / 顯示作廢原因」的渲染，
    // 但 /state 的 memories 是 activeMemories（已經排除 voided）——
    // 於是那段永遠不會出現，作廢的只能在 recall 裡看。
    // 這裡把它們接回去；counts.active 仍然只算活著的。
    const voided = [...this.memories.values()]
      .filter((m) => m.voided && !m.archived && !m.tombstoned)
      .map((m) => ({ ...m, salience: salienceOf(m, this.runtime, now, this.cfg) }))
    const all = this.allMemories(now)
    const dims = scoreDims(this.understanding)
    return {
      schemaVersion: this.schemaVersion,
      cfg: this.cfg,
      persona: this.persona,
      foundation: this.foundation,
      selfView: this.selfView,
      understanding: this.understanding,
      dims,
      counts: {
        active: active.length,
        // 雜項區不算倉庫：它只是先放著的，還沒分類、也還沒升上去
        scratch: scratch.length,
        // 到期的預測層：還在倉庫，只是不再進注入
        dueForecast: active.filter((m) => isDue(m, now)).length,
        archived: all.filter((m) => m.archived).length,
        tombstoned: all.filter((m) => m.tombstoned).length,
        voided: voided.length,
        byTier: [1, 2, 3, 5].reduce((acc, t) => Object.assign(acc, { [t]: active.filter((m) => m.tier === t).length }), {}),
        snapshots: this.snapshots.size,
        pending: [...this.pending.values()].filter((p) => p.status === 'open').length,
        ledgerBytes: this.ledgerBytes(),
      },
      chain,
      memories: [...active, ...voided],
      scratch,
      scratchUpgradeAfter: UPGRADE_THRESHOLD,
      // 注入位置數 —— 頁面拿它顯示「由預算推導」，不再讓用戶手動調 injectCount
      derivedSlots: slotsForBudget(this.cfg.injectBudget),
      // ⚠️ 2026-11-26：**不要把快照全文送給頁面。**
      //
      // 舊版把每個 snapshot 的 before / after 都帶上；一次 import.bundle 的快照
      // 就是整本 store，頁面還每 2.5 秒輪詢一次。前端只用到 id / scope / label / at，
      // 真正的內容留在 this.snapshots 給 rollback 用就夠了。
      snapshots: [...this.snapshots.values()]
        .sort((a, b) => (a.at < b.at ? 1 : -1))
        .map(({ id, scope, label, at }) => ({ id, scope, label, at })),
      // 性格卡是它自己改的：這裡只給「最近改過哪幾次」的旁證，不需要任何人批准
      personaTrail: this.recentPersonaRevisions(8),
      pending: [...this.pending.values()].sort((a, b) => (a.at < b.at ? 1 : -1)),
      runtime: {
        lastReflectionAt: this.runtime.lastReflectionAt,
          armed: this.runtime.armed,
        lastTickAt: this.runtime.lastTickAt || null,
        dutyLog: (this.runtime.dutyLog || []).slice(-12),
        lastError: this.runtime.lastError,
        selfMemoryId: this.runtime.selfMemoryId || '',
          },
      tiers: TIERS,
      dimCatalog: DIMS,
      dimKeys: DIM_KEYS,
    }
  }

  /**
   * 性格卡的「旁證」：它最近自己改過哪幾次 —— 只讀，不批准、不擋。
   * 給的是事實：誰改的、怎麼改的、動沒動身份句、有沒有刪掉原有的性格/喜好。
   */
  recentPersonaRevisions(limit = 8) {
    const rows = []
    for (const rec of this.records) {
      if (rec.kind !== 'persona.revise') continue
      const p = rec.payload || {}
      const before = p.before || {}
      const after = p.after || {}
      const lostTraits = Math.max(0, (before.traits || []).length - (after.traits || []).length)
      const lostTaste = Math.max(0, (before.taste || []).length - (after.taste || []).length)
      const bId = String(before.identity || '').trim()
      const aId = String(after.identity || '').trim()
      rows.push({
        seq: rec.seq,
        at: rec.ts,
        by: rec.actor || '',
        mode: p.destructive || p.mode === 'replace' ? 'replace' : 'adjust',
        version: after.version ?? null,
        destructive: typeof p.destructive === 'boolean' ? p.destructive : p.mode === 'replace',
        identityChanged: Boolean(bId) && Boolean(aId) && bId !== aId,
        identityCleared: Boolean(bId) && !aId,
        lostTraits,
        lostTaste,
        snapshotId: p.snapshot?.id || '',
      })
    }
    rows.sort((a, b) => b.seq - a.seq)
    return rows.slice(0, limit)
  }

  /* ───────────────────────── 寫入（工具與頁面共用） ───────────────────────── */

  writeMemory(raw, { sessionId, callId, actor = 'model', origin } = {}) {
    if (!this.cfg.enabled) return { ok: false, error: 'Silt is switched off; the owner has to enable it before memory can grow' }
    const res = normalizeMemory(raw, { sessionId, callId, origin })
    if (!res.ok) return res
    const memory = { ...res.memory, id: `m-${digest(`${nowIso()}:${Math.random()}`).slice(0, 10)}` }
    this.append('memory.write', actor, { memory })
    return { ok: true, memory: this.memories.get(memory.id) || memory }
  }

  /**
   * 改寫記憶：**模型沒有這個能力了**。
   *
   * 理由跟「不能刪記憶」是同一條：改一條記憶的字，等於改變它記下的事。
   * 它能加（silt_remember），但不能回頭動已經寫下的東西。
   */
  reviseMemory() {
    return { ok: false, error: '記憶不能改寫；寫錯了就再寫一條對的' }
  }

  /**
   * 作廢一條記憶：**內容一個字都不改**，只標「這條不成立了、為甚麼」。
   *
   * 跟其他三種「不再用」的差別：
   *   archived（歸檔）＝ 被壓縮／合併掉了 —— 時間的必然結果
   *   expired （過期）＝ 到時間了（T4 淡出、T5 到期）—— 也是時間的必然結果
   *   voided  （作廢）＝ **事後發現當初就不對** —— 需要新信息，而且要有出處
   *
   * 所以它只該由對話驅動（本人說「我之前說錯了」），不該在反思時憑感覺用。
   * 原條仍在倉庫、仍在帳本；只是不再進注入，recall 還找得到並標出 voided。
   */
  voidMemory(id, { reason = '', replacedBy = '', actor = 'model' } = {}) {
    if (!this.cfg.enabled) return { ok: false, error: 'Silt is switched off' }
    const m = this.memories.get(id)
    if (!m) return { ok: false, error: `no memory ${id}` }
    if (m.archived) return { ok: false, error: `記憶 ${id} 已經被壓縮／合併掉了，不是可以作廢的東西` }
    // 暫存條本來就不進注入、幾天後自己消失 —— 作廢它沒有意義，只會多一筆雜訊
    if (m.tier === SCRATCH.tier) {
      return { ok: false, error: '雜項本來就不用作廢 —— 它不進提示詞，一天內沒有人想起就自己散了' }
    }
    if (m.voided) return { ok: false, error: `記憶 ${id} 已經是作廢狀態了` }

    const why = String(reason ?? '').trim()
    if (why.length < 2) return { ok: false, error: '要說一句為甚麼作廢 —— 是誰、哪句話讓它不成立的' }

    let replaced = ''
    if (replacedBy) {
      const target = this.memories.get(replacedBy)
      if (!target) return { ok: false, error: `replacedBy 指的 ${replacedBy} 不存在` }
      if (target.id === id) return { ok: false, error: '不能拿它自己取代自己' }
      replaced = replacedBy
    }

    const before = { ...m }
    const after = {
      ...m,
      voided: true,
      voidedAt: nowIso(),
      voidedBy: actor,
      voidedReason: why,
      ...(replaced ? { replacedBy: replaced } : {}),
    }
    const snapshot = snapshotOf('memory', `作廢「${oneLine(m.title, 30)}」`, before, after)
    this.append('memory.void', actor, { id, reason: why, replacedBy: replaced || null, snapshot })
    return { ok: true, id, tier: m.tier, title: m.title, replacedBy: replaced || null }
  }

  /**
   * 壓縮一條經歷：把一條 T3 換成更短的版本（原條歸檔，新版是新的記憶）。
   *
   * 跟 reviseMemory 的差別：**不是改同一條的內容**，而是「把這一條重新講一遍，舊的那個收起來」。
   * 所以它走的是跟 compress 一樣的路：原條 archived、新版是獨立的一條。
   *
   * - 目標是一條對一條（不是合併）
   * - 新版夠短（≤ T2 上限）就直接是 T2；否則還是 T3，等下一輪再壓
   * - 原條不能是 T1、T2、T4
   */
  /**
   * 重新講一遍一條經歷。
   *
   * 兩種用途，走同一條路（原條歸檔、新版是獨立一條）：
   *
   *   ① **壓縮**（`mode: 'condense'`，預設）：把話說短，`targetLen` 由公式算，只減不增。
   *   ② **重述**（`mode: 'recast'`）：**同樣的事，換一種理解**。長度可以不變。
   *
   * 為什麼要分②：人不是把舊事一路刪短的。半年後再想起「他總在深夜工作」，
   * 理解會變成「他在用夜晚躲掉白天」，長度一樣，意思完全不同。
   * 沒有這條路，她只能「記住」而不能「改看」——那就只是個資料庫。
   *
   * ⚠️ 為什麼不用 void 來「改寫」：
   *   void 的語義是「這件事不再成立」，而且作廢的記憶不進注入 ——
   *   拿它改看法，等於把原始記錄從視野裡拿掉，她就看不到自己曾經怎麼想的了。
   *   重述不是這樣：原條進帳本留底（可審計、可回滾），新版進注入。
   *
   * @param {{id:string,title:string,body:string,targetLen?:number,mode?:'condense'|'recast'}} input
   */
  condense({ id, title, body, targetLen = null, mode = 'condense' }, { sessionId = '', callId = '', actor = 'model' } = {}) {
    if (!this.cfg.enabled) return { ok: false, error: 'Silt is switched off' }
    const prev = this.memories.get(id)
    if (!prev) return { ok: false, error: `no memory ${id}` }
    if (prev.tombstoned || prev.archived) return { ok: false, error: `memory ${id} 已經收起來了，不能再壓` }
    if (prev.voided) return { ok: false, error: `memory ${id} 已經被作廢了 —— 壓一條錯的記憶沒有意義` }
    if (prev.tier === 1) return { ok: false, error: 'T1 事實不壓縮' }
    if (prev.tier === SCRATCH.tier) return { ok: false, error: '雜項不壓縮 —— 它要麼被提起升成 T3，要麼一天內自己過期消失' }
    if (prev.tier === FORECAST.tier) return { ok: false, error: '預測層不壓縮 —— 它本來就短，到期就不進注入了，沒有再收的必要' }
    if (prev.tier === 2) return { ok: false, error: '這已經是沉澱下來的概了，不再壓' }

    const recast = mode === 'recast'

    // ⚠️ 2026-11-25 本人指出的漏洞：recast 可以**無限次**做，每次都寫 1000 字、永不沉 T2，
    //    等於繞過整條壓縮階梯。原本「插件決定壓到多短、模型決定留甚麼」這條原則就失效了。
    //
    //    三道圍欄（本人都同意的那幾個方向）：
    //      ① recast 只作用於 T3 —— 它不是拿來改寫 T1 事實或 T5 預測的。
    //         （上面那些 tier 判斷已經擋住了，這裡再明寫一次，因為它是對外語義。）
    //      ② 同一條最多 recast 3 次（`recastCount` 跨版本累加，寫在 after 上）。
    //      ③ recast **不重置壓縮時鐘** —— 見下面 lastCondensedAt 那一行的長說明。
    //
    //    為什麼單靠 ①「不重置時鐘」不夠：recast 會產生一條**新記憶**（bornAt = 現在），
    //    而壓縮目標公式用的是「從誕生起的天數」—— 換句話說，光不動 lastCondensedAt
    //    還是會讓長度目標隨 bornAt 重置而變長。所以還需要 ② 那個絕對上限。
    const MAX_RECAST = 3
    if (recast) {
      if (Number(prev.tier) !== 3) {
        return { ok: false, error: `重述只作用於 T3 經歷（這條是 T${prev.tier}）—— 事實、概、雜項、預測都不用重述` }
      }
      const used = Number(prev.recastCount || 0)
      if (used >= MAX_RECAST) {
        return {
          ok: false,
          error: `這條已經重述過 ${used} 次（上限 ${MAX_RECAST}）—— 再改看法就用 silt_condense 正常壓縮，或者寫一條新的經歷，不要一直重述同一條`,
        }
      }
    }

    const text = String(body ?? '').trim()
    if (text.length < 2) return { ok: false, error: 'body 不能是空的' }
    const newLen = String(title ?? '').length + text.length
    // 2026-11-21：`targetLen` 從「硬上限」改成**參考值**。
    //
    // 本人原話：「你能自主判斷怎麼記了的」——公式算出來的數字是「大概收到這個長度比較合適」，
    // 不是「超過就退回去」。以前超一個字就被拒，等於把怎麼判斷交給了常數。
    // 現在超了照收，只把差距告訴我 —— 我要收就自己再收，我覺得該長就照長。
    //
    // ⚠️ 唯一不變的硬線是各層的字數上限（T2 200 / T3 1000 等），那是存檔格式的限制，不是判斷。
    //    這裡不預先擋，交給下面的 normalizeMemory 擋 —— 只有真的塞不進那一層才會被拒。
    const overBy = !recast && targetLen ? newLen - Number(targetLen) : 0
    // 重述也不能無限膨脹：超過 T3 上限就不是「重述」而是「新寫一條」了
    if (recast && newLen > TIERS[3].maxChars) {
      return { ok: false, error: `重述後 ${newLen} 字，超過 T3 上限 ${TIERS[3].maxChars} —— 這是新寫一條，不是重述` }
    }

    // 夠短、**而且夠老**，才沉成 T2。
    //
    // 為什麼要加年紀：T2 是 720 天半衰期的終態。舊版只要 ≤200 就沉 ——
    // 於是一條 10 天大的 T3 只要模型寫短一點，就當場變成「沉澱下來的概」，
    // 跟 README 自己寫的「約 175 天落 T2」相反。年齡由 settleAgeDays 算
    // （最長那條 T3 的曲線時間 × 1.2^R）。
    //
    // ⚠️ 重述**永遠留在 T3**：它是「換個看法」，不是「說得更短」，
    //    不能因為這次寫得比較短就順便沉澱掉 —— 那會把「還在想」的東西釘死。
    const shortEnough = newLen <= TIERS[2].maxChars
    const oldEnough = settleDue(prev, this.runtime)
    const tierAfter = !recast && shortEnough && oldEnough ? 2 : 3
    // 夠短但不夠老 —— 要告訴它為什麼沒沉，不然它會以為工具壞了
    const settleNote =
      !recast && shortEnough && !oldEnough
        ? {
            settled: false,
            settleAgeDays: Math.round(settleAgeDays(prev, this.runtime)),
            settleNote: `已經夠短，但這條才 ${Math.round(ageDays(prev.bornAt))} 天，要到 ${Math.round(settleAgeDays(prev, this.runtime))} 天才會定稿 —— 先留在 T3。`,
          }
        : {}
    const gist = {
      // ⚠️ 2026-11-25：**要明寫 tier**。以前這裡沒有這一行，
      //    靠 normalizeMemory 的「非法 tier 就當 3」才跑得通 ——
      //    那個 fallback 拿掉之後，壓縮路徑立刻炸（收到 undefined）。
      //    這正是為什麼靜默 fallback 有害：它會掩蓋「呼叫端少填一個必填欄位」。
      //    壓縮/重述產生的一定是 T3（沉成 T2 走的是另一條 compress() 路徑）。
      tier: 3,
      title,
      body: text,
      domain: prev.domain || 'other',
      // dims 要留真的：normalizeMemory 會驗證它是不是合法維度，'other' 是 domain 不是 dim
      dims: prev.dims?.length ? prev.dims : ['personality'],
      facets: prev.facets || [],
      importance: prev.importance,
    }

    // （快照改到下面、拿到新 id 之後才建 —— 見 append 前那段說明）
    // 只回報超了多少，不拒絕 —— 見上面 targetLen 改成參考值的說明
    const targetNote = overBy > 0 ? { overTargetBy: overBy, targetLen: Number(targetLen), note: `比清單的參考長度多 ${overBy} 字；要麼再收，要麼就這樣留著` } : {}
    if (tierAfter === 2) {
      // 走 compress 的通道，讓 T2 的規則（只有壓縮能產生）保持一致
      const res = this.compress({ gist, ids: [id] }, { sessionId, callId, actor, origin: 'plugin' })
      if (!res.ok) return res
      return { ok: true, memory: res.memory, tier: 2, from: id, mode: 'condense', snapshotId: res.snapshotId, ...targetNote, ...settleNote }
    }

    // 還是 T3：新寫一條，舊的歸檔
    // ⚠️ 壓縮原本就是「同一件事換個說法」，它的出處是原條，不是壓縮時所在的那個會話。
    // 值守會話的 sessionId 可能拿不到（''），不能因此把冷卻了七天的活兒白白丟掉 ——
    // 有來源就沿用原條的，一律沒有才當成插件自己產生的。
    const fromSession = sessionId || prev.bornOfSession || ''
    const res = normalizeMemory(gist, { sessionId: fromSession, callId, origin: fromSession ? undefined : 'plugin' })
    if (!res.ok) return res
    const next = {
      ...res.memory,
      id: `m-${digest(`${nowIso()}:${Math.random()}`).slice(0, 10)}`,
      condensedFrom: id,
      // ⭐ 2026-11-25：**recast 不重置壓縮時鐘。**
      //
      // 這是本人給的第一道圍欄。舊版不管哪種模式都寫 `lastCondensedAt: nowIso()`，
      // 於是「重述」變成一個可以把壓縮時鐘往回撥的按鈕 —— 一直 recast 就一直不用壓縮，
      // 而壓縮正是「經歷總有一天會變成概」的唯一通道。
      //
      // 現在：recast 沿用原條的 lastCondensedAt（沒有就退回它的出生時間），
      // 所以下一次該壓還是不該壓，跟重述幾次**無關**。
      lastCondensedAt: recast ? prev.lastCondensedAt || prev.bornAt : nowIso(),
      // ⭐ 2026-11-25：**bornAt 一定要沿用原條**，不然「recast 不重置壓縮時鐘」就是一句假話。
      //
      // 為什麼：壓縮目標公式是 `target = base × (1 + k·T/s)^(-0.5)`，其中 **T = ageDays(bornAt)**。
      // 舊版這裡是 `...res.memory` 把 normalizeMemory 填的「現在」帶進來 ——
      // 於是每 recast 一次，T 就歸零，長度目標跟著變長，等於時鐘還是被重置了，
      // 只是這次不是透過 lastCondensedAt，而是透過 bornAt。
      //
      // bornAt 的語義本來就是「這件事開始算年齡的時間」，而重述、壓縮都只是換個說法，
      // 那件事不是今天發生的 —— 跟 firstSeen 是同一個道理。
      bornAt: prev.bornAt || res.memory.bornAt,
      // ⚠️ firstSeen 要沿用原條 —— normalizeMemory 一律用「現在」填，
      // 但壓縮只是把同一件事換個說法，那件事不是今天發生的。
      firstSeen: prev.firstSeen || prev.bornAt || res.memory.firstSeen,
      // 這是第幾次壓 —— 「每次抹掉多少」要靠它算：越壓越輕（見 duty.condensePlan）
      // ⚠️ recast 不算壓縮次數：它沒把東西收短，記進 condenseCount 會讓下一輪誤以為已經壓過。
      condenseCount: Number(prev.condenseCount || 0) + (recast ? 0 : 1),
      // 這條經歷最初有多長：目標一律從它連乘算起，避免每輪的餘裕複利（見 duty.condensePlan）
      originalLen: Number(prev.originalLen || String(prev.title || '').length + String(prev.body || '').length),
      revision: (prev.revision || 1) + 1,
      // 重述的痕跡：她換過幾次看法、上一次的原話長什麼樣。
      // ⚠️ 原條本身已經 archived（不會進注入），但帳本裡還在 —— 頁面上看得到演變过程。
      // recastCount 是**跨版本累加**的：新這條也要繼承舊的那個數，否則上限永遠追不到。
      // ⚠️ 2026-11-25（本人第 4 條）：`recastCount` **無論哪種模式都要帶**。
      //    舊版只在 recast 時才寫，非 recast 時整個欄位消失 ——
      //    於是 recast×2 → condense×1 → 新記憶沒有 recastCount → 又能 recast 三次。
      //    上限可以這樣繞過去，那條閘就是裝飾。
      recastCount: Number(prev.recastCount || 0) + (recast ? 1 : 0),
      ...(recast ? { recastFrom: id } : {}),
    }
    // ⚠️ 2026-11-25（本人第 8 條）：快照的 after 要記**新版記憶的 id**，不是只有 gist。
    //    gist 這時候還沒有 id（id 在下面才生成），所以回滾時無從刪掉「生出來的那一條」。
    //    舊版 condense 分支的 removeMemories 永遠是空的 —— 回滾之後新舊兩條同時活著。
    const snapshot = snapshotOf(
      recast ? 'recast' : 'condense',
      recast ? `重述 ${oneLine(prev.title, 30)}` : `壓縮 ${oneLine(prev.title, 30)}`,
      { memory: prev },
      { gist, gistId: next.id },
    )
    this.append(recast ? 'memory.recast' : 'memory.condense', actor, { id, after: next, snapshot })
    return { ok: true, memory: next, tier: 3, from: id, mode: recast ? 'recast' : 'condense', snapshotId: snapshot.id, ...targetNote, ...settleNote }
  }

  /**
   * 合併幾條講同一件事的記憶：**同層 2–3 條 → 一條，不過層。**
   *
   * 跟 compress 的差別：compress 產生 T2（更低一層）；merge 是 T1→T1、T3→T3。
   * 跟 condense 的差別：condense 是一條對一條；merge 是多條收成一條。
   * 合併**不是遺忘**：原條歸檔（不是作廢），內容還在帳本裡、recall 帶 includeArchived 找得回。
   *
   * 為什麼「先 recall 過才准併」：只看標題就併，等於拿幾句沒讀過的正文改寫。
   * `seenInSession` 只在**針對性 recall**（帶 query）時寫入，掃描不寫 ——
   * 它剛好就是「這個會話裡真的看過正文」的憑據，跟「掃描不算想起」是同一條原則。
   *
   * 時鐘不變（2026-11-27 本人定）：
   *   - bornAt / firstSeen / lastCondensedAt 取**最早**：這件事不是今天才發生的，
   *     合併也不給 7 天寬限。
   *   - originalLen 取來源 **max**：取新條長度會讓 60 天的合併條下一輪被砍 67%
   *     並直接沉 T2；取來源總和會讓它活到約 1500 天。取 max 才會跟來源同一時間沉。
   *   - recastCount 取 max：不然合併就是「重述次數歸零」的後門。
   *   - R（recall n）放進 payload 的 recallSeed（見 apply）：runtime 撐不過只帶 ledger 的導入。
   */
  merge({ ids, title, body, reason }, { sessionId = '', callId = '', actor = 'model' } = {}) {
    if (!this.cfg.enabled) return { ok: false, error: 'Silt is switched off; nothing new is written' }
    const list = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean))]
    if (list.length < 2 || list.length > 3) {
      return { ok: false, error: `合併要 2–3 條（收到 ${list.length} 條）` }
    }
    const missed = list.filter((id) => !this.memories.get(id))
    if (missed.length) return { ok: false, error: `找不到記憶 ${missed[0]}` }
    const src = list.map((id) => this.memories.get(id))
    for (const m of src) {
      if (m.voided) return { ok: false, error: `記憶 ${m.id} 已經被作廢了 —— 不該把一句被推翻的話合併進來` }
      if (m.archived || m.tombstoned) {
        return { ok: false, error: `記憶 ${m.id} 已經收起來了（壓縮／合併／刪除），不能再合併` }
      }
    }
    const tier = src[0].tier
    if (src.some((m) => m.tier !== tier)) return { ok: false, error: '合併只做同層 —— 這幾條不是同一層' }
    if (!MERGE_TIERS.has(tier)) {
      return {
        ok: false,
        error: `合併目前只做 T3（這幾條是 T${tier}）—— T1 併掉的細節不會自己回來，等 intake 收緊之後再開`,
      }
    }

    const why = String(reason ?? '').trim()
    if (why.length < 2) return { ok: false, error: '要說一句為什麼這幾條是同一件事（reason）' }

    // 只看標題不算：seenInSession 只在針對性 recall 時寫入（掃描不寫）。
    if (!sessionId) return { ok: false, error: '合併要有一個會話 —— 它必須先 recall 過這幾條' }
    const seen = this.runtime.seenInSession?.[sessionId] || {}
    const unseen = list.filter((id) => !seen[id])
    if (unseen.length) {
      return { ok: false, error: `先 silt_recall 這幾條、看過正文再併：${unseen.join(', ')}` }
    }

    const text = String(body ?? '').trim()
    if (text.length < 2) return { ok: false, error: 'body 不能是空的' }
    const lenOf = (m) => String(m.title || '').length + String(m.body || '').length
    const newLen = String(title ?? '').length + text.length
    const cap = TIERS[tier].maxChars
    if (newLen > cap) {
      return { ok: false, error: `合併後 ${newLen} 字，超過 T${tier} 上限 ${cap} —— 先收短，或者這幾條還不是同一件事` }
    }
    const sumLen = src.reduce((n, m) => n + lenOf(m), 0)
    if (newLen >= sumLen) {
      return { ok: false, error: `合併後 ${newLen} 字，沒有比原本 ${sumLen} 字短 —— 合併是收攏，不是接龍` }
    }

    const oldest = [...src].sort((a, b) => String(a.bornAt || '').localeCompare(String(b.bornAt || '')))[0]
    const earliest = (key) =>
      [...src]
        .map((m) => m[key] || m.bornAt || '')
        .filter(Boolean)
        .sort()[0]
    const union = (key) => [...new Set(src.flatMap((m) => (Array.isArray(m[key]) ? m[key] : [])))]
    const maxNum = (key) => Math.max(0, ...src.map((m) => Number(m[key] || 0)))
    const dims = union('dims').filter((d) => DIM_KEYS.includes(d))
    const facets = union('facets').filter((f) => FACET_KEYS.includes(f) && dims.includes(f.split('.')[0]))
    const recallSeed = Math.max(0, ...src.map((m) => Number(this.runtime.recalls?.[m.id]?.n || 0)))

    const res = normalizeMemory(
      {
        tier,
        title,
        body: text,
        domain: oldest.domain || 'other',
        dims: dims.length ? dims : ['personality'],
        facets,
        tags: union('tags'),
        importance: Math.max(...src.map((m) => Number(m.importance ?? 0.4))),
      },
      { sessionId, callId },
    )
    if (!res.ok) return res

    const at = nowIso()
    const next = {
      ...res.memory,
      id: `m-${digest(`${at}:${Math.random()}`).slice(0, 10)}`,
      // 這件事不是今天才發生的：出生時間與首次看見都沿用最早的那個。
      bornAt: oldest.bornAt || res.memory.bornAt,
      firstSeen: stampOf(tier, earliest('firstSeen') || oldest.bornAt || at),
      // 壓縮相關的欄位只有 T3 有意義（T1 永遠不壓，寫上去只是噪音）。
      ...(tier === 3
        ? {
            lastCondensedAt: earliest('lastCondensedAt') || oldest.bornAt || at,
            // 跟來源裡「原本最長」的那條同一條曲線 —— 不送壽命，也不斷崖。
            originalLen: Math.max(...src.map((m) => Number(m.originalLen || lenOf(m)))),
            condenseCount: maxNum('condenseCount'),
            recastCount: maxNum('recastCount'),
          }
        : {}),
      mergedFrom: list,
      revision: 1,
    }

    const snapshot = snapshotOf(
      'merge',
      `合併「${oneLine(oldest.title, 24)}」等 ${list.length} 條為一條`,
      { absorbed: list },
      { mergeId: next.id },
    )
    this.append('memory.merge', actor, { after: next, absorbed: list, reason: why, recallSeed, snapshot })
    return { ok: true, memory: next, tier, absorbed: list, snapshotId: snapshot.id, recallSeed }
  }

  /**
   * 產生 T2。**這是 T2 唯一的來源** —— 工具層沒有任何路徑能直接寫 T2。
   */
  compress({ gist, ids }, { sessionId, callId, actor = 'plugin', origin = 'plugin', fromCompression = false } = {}) {
    if (!this.cfg.enabled) return { ok: false, error: 'Silt is switched off; nothing new is written' }
    const absorbed = (ids || []).map((id) => this.memories.get(id)).filter((m) => m && !m.tombstoned && !m.archived)
    if (absorbed.length === 0) return { ok: false, error: 'none of those memories exist, or they are already absorbed' }
    // 暫存條不是完整記憶：它要麼被提起升成 T3，要麼自己過期。不參與壓縮、不能被折走。
    if (absorbed.some((m) => m.tier === SCRATCH.tier)) {
      return { ok: false, error: '雜項不參與壓縮 —— 它要麼被提起升成 T3，要麼一天內自己過期消失' }
    }
    // 預測層也不能被折進概括：它不是經歷，是一句有期限的話。
    if (absorbed.some((m) => m.tier === FORECAST.tier)) {
      return { ok: false, error: '預測層不參與壓縮 —— 它是「到某天為止」的話，不該被折成經歷的概' }
    }
    // 作廢的不能被折進概括：那等於把一句錯的話混進對的裡面去
    if (absorbed.some((m) => m.voided)) {
      return { ok: false, error: '已作廢的記憶不參與壓縮 —— 把一句錯的話折進概裡，錯的會留下來' }
    }
    // T2 已經是最低的一層：沉澱過的東西不再折第二次
    const gists = absorbed.filter((m) => m.tier === 2)
    if (gists.length) {
      return { ok: false, error: `memory ${gists[0].id} is already a tier 2 gist; a gist is the floor and is never compressed again` }
    }
    if (absorbed.some((m) => m.tier === 1)) return { ok: false, error: 'tier 1 facts are never compressed away' }
    // T2 只能由這裡產生 —— normalizeMemory 預設拒絕直接寫 T2，壓縮是唯一的例外通道
    const res = normalizeMemory(
      { ...gist, tier: 2, domain: gist?.domain || absorbed[0].domain },
      { sessionId, callId, origin, fromCompression: Boolean(fromCompression) || origin === 'plugin' },
    )
    if (!res.ok) return res
    const at = nowIso()
    const g = {
      ...res.memory,
      id: `m-${digest(`${at}:${Math.random()}`).slice(0, 10)}`,
      compressedFrom: absorbed.map((m) => m.id),
      // ⚠️ 2026-11-25（本人第 5 條）：`bornAt` 也要沿用原條，不是 `at`。
      //
      // 舊版 `bornAt: at`（現在），而 salience 讀的就是 bornAt ——
      // 於是一條 175 天前的事沉成 T2 的那一刻 `age ≈ 0`，**亮度回滿、排到注入最前面**，
      // 而且 T2 半衰期 720 天，會亮很久。這正是 salienceOf 裡修掉的「時光倒流」，
      // 從壓縮這條路又回來了。
      //
      // 改成跟 firstSeen 同一個取法：多條合併時取最早的那個。
      bornAt:
        absorbed
          .map((m) => m.bornAt)
          .filter(Boolean)
          .sort()[0] || at,
      // ⚠️ firstSeen 沿用原條，不是 `at`。
      //
      // 一條 2023 年發生的事沉成 T2 時，它的日期仍然是 2023 —— 沉澱只改了「句子有多長」，
      // 沒讓那件事變成今天發生的。用 at 會讓提示詞裡寫成「（2026-11-17）」，
      // 模型就以為這是最近的事，而它其實是三年前的。
      // 這跟 T4→T3 的升級一致：那邊也沿用 `prev.firstSeen || prev.bornAt || now`。
      // 多條合併時取最早的那個 —— 「這件事甚麼時候開始的」，取最早的才對。
      firstSeen: stampOf(
        2,
        absorbed
          .map((m) => m.firstSeen || m.bornAt)
          .filter(Boolean)
          .sort()[0] || at,
      ),
      // 沉成 T2 是這條經歷的終點，次數與原始長度要留下來（帳本上看得出它被壓過幾次）
      condenseCount: Number(absorbed[0].condenseCount || 0) + 1,
      // ⚠️ 2026-11-25（本人第 4 條的延伸）：`recastCount` 也要帶過來。
      //    T2 本身不能再 recast，所以「現在」不會被繞；
      //    但這條概日後若被回滾 / 還原成 T3，沒有這個數字就能再 recast 三次 —— 上限一樣是裝飾。
      //    取 absorbed 裡最大的那個（多條合併時，被重述過最多次的那條決定了這件事被改寫過幾次）。
      recastCount: Math.max(0, ...absorbed.map((m) => Number(m.recastCount || 0))),
      originalLen: Number(
        absorbed[0].originalLen || String(absorbed[0].title || '').length + String(absorbed[0].body || '').length,
      ),
    }
    const snapshot = snapshotOf('compress', `壓縮 ${absorbed.length} 條為一條大概`, { absorbed: absorbed.map((m) => m.id) }, { gistId: g.id })
    // ⭐ R 要跟著走：T2 是終態，定稿那一刻掉 R 會很明顯（R=5：半衰期 1792 天 → 720）。
    //    跟 merge 一樣放進 payload，只帶 ledger 換機時才撐得住（見 apply 的 max 說明）。
    const recallSeed = Math.max(0, ...absorbed.map((m) => Number(this.runtime.recalls?.[m.id]?.n || 0)))
    this.append('memory.compress', actor, { gist: g, absorbed: absorbed.map((m) => m.id), recallSeed, snapshot })
    return { ok: true, memory: g, absorbed: absorbed.map((m) => m.id), recallSeed, snapshotId: snapshot.id }
  }

  /**
   * 抹除記憶：**已經沒有這個能力了**。
   * 這裡保留一個明確拒絕的入口，是為了不讓任何殘留呼叫靜默失敗。
   */
  forget() {
    return { ok: false, error: '抹除記憶的能力已移除' }
  }

  /* ───────────────────────── 人格 / 底座 / 自我 / 六維 ───────────────────────── */

  /**
   * 性格卡歸它自己：**修不修訂、怎麼修訂，都由它自己決定，不經本人批准。**
   * 風險照樣留痕 —— before/after 快照、可回滾，本人只在旁邊看，不參與。
   */
  savePersona(patch, { mode = 'adjust', actor = 'model' } = {}) {
    if (!this.cfg.enabled && actor === 'model') return { ok: false, error: 'Silt is switched off' }
    // 空 patch 不是一次修訂 —— 不要讓「我來看看」變成一筆版本記錄。
    if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) {
      return { ok: true, unchanged: true, persona: this.persona, destructive: false }
    }
    const res = normalizePersona(this.persona, patch, { mode })
    if (!res.ok) return res
    const before = this.persona
    const snapshot = snapshotOf('persona', `修訂人格 v${res.persona.version}`, before, res.persona)
    this.append('persona.revise', actor, { before, after: res.persona, mode, destructive: Boolean(res.destructive), snapshot })
    return { ok: true, persona: res.persona, snapshotId: snapshot.id, destructive: Boolean(res.destructive) }
  }

  setFoundation(text, { actor = 'user' } = {}) {
    const next = String(text ?? '')
    if (next === this.foundation.text) {
      return { ok: true, unchanged: true, foundation: this.foundation }
    }
    const before = this.foundation
    const after = { text: next, setAt: nowIso(), by: actor }
    const snapshot = snapshotOf('foundation', '改性格底座', before, after)
    this.append('persona.foundation', actor, { before, after, snapshot })
    return { ok: true, foundation: after, snapshotId: snapshot.id }
  }

  /** 起點已取消：它本來就是初始的底座詞，現在就是底座本身。留一個明確拒絕的入口。 */
  setOrigin() {
    return { ok: false, error: '「起點」已經沒有這個東西了 —— 它現在就是性格底座本身' }
  }

  saveSelfView(text, { actor = 'model' } = {}) {
    if (!this.cfg.enabled && actor === 'model') return { ok: false, error: 'Silt is switched off' }
    if (String(text ?? '').trim() === this.selfView.text) {
      return { ok: true, unchanged: true, selfView: this.selfView }
    }
    const res = normalizeSelfView(this.selfView, text)
    if (!res.ok) return res
    const before = this.selfView
    const snapshot = snapshotOf('self', `自我認知 v${res.view.revision}`, before, res.view)
    this.append('self.revise', actor, { before, after: res.view, snapshot })
    return { ok: true, selfView: res.view, snapshotId: snapshot.id }
  }

  setUnderstanding(patch, { actor = 'model', note = '' } = {}) {
    if (!this.cfg.enabled && actor === 'model') return { ok: false, error: 'Silt is switched off' }
    if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) {
      return { ok: true, unchanged: true, understanding: this.understanding }
    }
    const res = normalizeUnderstanding(this.understanding, patch)
    if (!res.ok) return res
    const before = this.understanding
    const snapshot = snapshotOf('understanding', note || '修訂「它對你的了解」', before, res.understanding)
    this.append('understanding.revise', actor, { before, after: res.understanding, note: oneLine(note, 200), snapshot })
    return { ok: true, understanding: res.understanding, snapshotId: snapshot.id }
  }

  /* ───────────────────────── 它自己調的旋鈕 ───────────────────────── */

  /** 它自己調過哪些注入量（給工具與頁面看「這是我調的」）。 */
  injectTuning() {
    return this.runtime.injectTuned || {}
  }

  /** 它自己調過哪些節律。 */
  rhythmTuning() {
    return this.runtime.rhythmTuned || {}
  }

  /**
   * 每個旋鈕「最後一次是誰訂的」—— 給 silt_duty / silt_inject 的 read 用。
   *
   * ⚠️ 2026-11-25 本人的要求（第 8 節的第 2 個回傳）：
   *    反思提示詞要看得到「這個數字是本人訂的，還是我自己調的還是我從來沒動過」。
   *    不然它只能靠猜 —— 而猜錯的方向是「把本人訂的數字當成自己的去改」。
   *
   * 來源三種：
   *   'user'    本人親口訂的（本人在對話裡說、或頁面上按的 → actor: 'user' 那個寫入）
   *   'model'   模型自己 tune 過（有帳本記錄）
   *   'default' 從來沒人動過，現在跑的是預設值
   *
   * 實作：掃帳本裡針對這幾個旋鈕的寫入記錄，取**最後一筆**的 actor。
   * 不另存狀態 —— 帳本就是真相，另存一份遲早會對不上。
   */
  knobProvenance(keys = []) {
    const out = {}
    for (const key of keys) out[key] = { setBy: 'default', at: null }
    const tracked = new Set(keys)
    // 帳本記錄裡有 diff 的那幾種：inject.profile / rhythm.profile
    for (const rec of this.records || []) {
      const p = rec?.payload
      const diff = p?.diff || p?.patch || null
      if (!diff || typeof diff !== 'object') continue
      for (const key of Object.keys(diff)) {
        if (!tracked.has(key)) continue
        out[key] = { setBy: rec.actor === 'user' ? 'user' : 'model', at: rec.ts || null }
      }
    }
    return out
  }


  tuneInjection(patch, { reason = '', actor = 'model' } = {}) {
    if (!this.cfg.enabled && actor === 'model') return { ok: false, error: 'Silt is switched off' }
    const before = { injectCount: Number(this.cfg.injectCount), injectBudget: Number(this.cfg.injectBudget) }
    const next = { ...before }
    const diff = {}
    const ignored = []
    for (const key of Object.keys(patch || {})) {
      if (!(key in INJECT_TUNABLES)) {
        ignored.push(key)
        continue
      }
      // injectCount 已經不參與注入了（條數由預算推），調它沒有任何效果 ——
      // 收下但明確告訴呼叫方「這項現在不生效」，比默默接受一個沒用的值好。
      if (key === 'injectCount') {
        ignored.push('injectCount（條數由 injectBudget 推導：每 50 字一個位置，調它不生效）')
        continue
      }
      const spec = INJECT_TUNABLES[key]
      const n = Number(patch[key])
      if (!Number.isFinite(n)) continue
      next[key] = clamp(Math.round(n), spec.min, spec.max)
      if (next[key] !== before[key]) diff[key] = next[key]
    }
    if (Object.keys(diff).length === 0) {
      // 分兩種情況：真的沒變 vs 全部被拒（例如只調了 injectCount）。
      // 混成一句「這些已經就是現在的值」會讓模型以為「值沒動，所以不用管」，
      // 但實際上可能是「你調的東西根本不存在」。
      const note =
        ignored.length > 0 && Object.keys(patch || {}).length === ignored.length
          ? `這些都沒有生效：${ignored.join('；')}`
          : '這些已經就是現在的值'
      return { ok: true, changed: false, note, ignored, now: before }
    }
    const snapshot = snapshotOf('inject', '調注入量', before, next)
    this.append('inject.profile', actor, { before, after: next, diff, reason: String(reason || ''), snapshot })
    this.cfg = { ...this.cfg, ...diff }
    this.runtime.injectTuned = { ...(this.runtime.injectTuned || {}), ...diff }
    this.writeJson(this.configPath, this.cfg)
    this.persistRuntime()
    return { ok: true, changed: true, before, after: next, diff, snapshotId: snapshot.id }
  }

  tuneRhythm(patch, { reason = '', actor = 'model' } = {}) {
    if (!this.cfg.enabled && actor === 'model') return { ok: false, error: 'Silt is switched off' }
    const before = {
      reflectionEveryHours: Number(this.cfg.reflectionEveryHours),
      dutyMaxPerDay: Number(this.cfg.dutyMaxPerDay),
      reflectionAt: this.cfg.reflectionAt ?? null,
    }
    const next = { ...before }
    const diff = {}
    const ignored = []
    for (const key of Object.keys(patch || {})) {
      // reflectionAt 不是數字：走自己的一條路，只收 'HH:MM' 陣列（東八區）。
      if (key === 'reflectionAt') {
        const parsed = normalizeReflectionAt(patch[key])
        if (parsed === undefined) {
          ignored.push(`${key}（要 ['HH:MM', …]，或 null 取消固定鐘點）`)
          continue
        }
        next.reflectionAt = parsed
        if (JSON.stringify(parsed) !== JSON.stringify(before.reflectionAt)) diff.reflectionAt = parsed
        continue
      }
      if (!(key in RHYTHM_TUNABLES)) {
        ignored.push(key)
        continue
      }
      // ⚠️ 2026-11-25 本人的第 5 條：**設了固定鐘點，reflectionEveryHours 就不再生效。**
      //
      // 舊版只是「存了但沒用」—— 模型調了會以為節律變了，實際沒動，
      // 跟 injectCount 是同一種陷阱。所以這裡要**明確回報它不生效**，而不是靜靜地收下。
      // （注意：值仍然寫進去，因為取消固定鐘點之後它就會重新生效 —— 但這一輪要看得到 warning。）
      if (key === 'reflectionEveryHours' && Array.isArray(next.reflectionAt) && next.reflectionAt.length > 0) {
        ignored.push(
          `${key}（已設固定鐘點 ${next.reflectionAt
            .map(clockLabel)
            .join(' / ')} —— 它現在不生效；要改節律請改 reflectionAt，或傳 reflectionAt: null 取消固定鐘點）`,
        )
      }
      const spec = RHYTHM_TUNABLES[key]
      const n = Number(patch[key])
      if (!Number.isFinite(n)) continue
      next[key] = clamp(Math.round(n), spec.min, spec.max)
      if (next[key] !== before[key]) diff[key] = next[key]
    }
    if (Object.keys(diff).length === 0) {
      return { ok: true, changed: false, note: '這些已經就是現在的值', ignored, now: before }
    }
    const snapshot = snapshotOf('rhythm', '調值守節律', before, next)
    this.append('rhythm.profile', actor, { before, after: next, diff, reason: String(reason || ''), snapshot })
    this.cfg = { ...this.cfg, ...diff }
    this.runtime.rhythmTuned = { ...(this.runtime.rhythmTuned || {}), ...diff }
    this.writeJson(this.configPath, this.cfg)
    this.persistRuntime()
    // ⚠️ changed:true 這條也要帶 ignored —— 不然「值改了、但某一項不生效」這個最重要的情況
    //    反而看不到（舊版只在 changed:false 才回報）。本人第 5 條要的正是這個回報。
    return { ok: true, changed: true, before, after: next, diff, ignored, snapshotId: snapshot.id }
  }

  /* ───────────────────────── 主動開口 ───────────────────────── */

  /**
   * 開口之前唯一要問的事：**現在是不是谷時**，以及**本人有沒有關掉它**。
   *
   * 為什麼只剩這兩道：值不值得說、要不要等他忙完，都是模型當下比我清楚的東西。
   * 我這裡再加一個「今天說夠了」「隔不到 12 小時」的數字，就是用我的偏好去蓋它的判斷 ——
   * 明明有話要說卻被數字擋住，那不是紀律，是插件在替它說謊。
   *
   * 谷時的判斷複用值守那一組窗口（見 duty.js 的 inValley），兩邊不該有兩套說法。
   */
  speakGate(now = Date.now(), valley = null) {
    // 谷時由宿主半端注入（index.js 把 duty.inValley 掛上來）——
    // store 不 import duty：duty 已經 import model，再反向就會成環。
    const v = valley || (typeof this.valleyOf === 'function' ? this.valleyOf(now) : { ok: true, label: '未知（未接上谷時判斷）' })
    const reasons = []
    if (!this.cfg.enabled) reasons.push('插件總開關是關的')
    if (!this.cfg.speak) reasons.push('主動開口是關的')
    if (!v.ok) reasons.push(`現在是${v.label}，不是谷時`)
    return {
      ok: reasons.length === 0,
      reasons,
      valley: v,
      enabled: Boolean(this.cfg.enabled && this.cfg.speak),
      lastSpokeAt: this.runtime.lastSpokeAt || null,
      spokenToday: this.spokenToday(now),
    }
  }

  /**
   * 今天開過幾次口 —— 只是給它參考，不作為擋人的理由。
   *
   * ⚠️ 2026-11-25（「小」那一條）：「今天」用**東八區**切，不是 UTC。
   *    舊版 `new Date(now).toISOString().slice(0,10)` 是 UTC 日期，
   *    於是北京時間下午還在算「昨天」的次數、早上 8 點才換日 —— 整整差一整天的一半。
   */
  spokenToday(now = Date.now()) {
    const day = toLocal(new Date(now).toISOString(), { dateOnly: true })
    return (this.runtime.speakLog || []).filter((s) => !s.deferred && toLocal(String(s.at || ''), { dateOnly: true }) === day).length
  }

  /**
   * 「本人最後親手說話的那個會話」—— 日記和反思寫在這裡。
   *
   * 来源只有 `api-session/activity`：它在 session-controller 裡要同時滿足
   * `event.type === 'user/message'` 與 `event.data.source.kind === 'user'`，
   * 排程投遞 / agent 自己寫的 / 工具結果一律不發。所以這裡記下來的是**他說的**，
   * 不是**我說的**（`lastSpokeSession` 才是那個）。
   *
   * 為什麼不靜默寫盤：這東西每条 user 訊息都會打一次，寫 runtime.json 太頻。
   * 只更新記憶體、節流寫盤；程序重啟後最多丟「上一次他說話」到最近一拍。
   * 這段時間反思會失敗（不會另開新會話），等他再說一句話就恢復。
   */
  noteHomeSession(sessionId, updatedAt) {
    const id = String(sessionId || '').trim()
    if (!id) return
    const at = Number(updatedAt) || Date.now()
    this.runtime.homeSession = { sessionId: id, at }
    const last = Number(this.runtime.homeFlushedAt || 0)
    if (at - last < 60_000) return
    this.runtime.homeFlushedAt = at
    try {
      this.persistRuntime()
    } catch {
      /* 寫不進去就算了 —— 下一次他說話會再寫一次 */
    }
  }

  /**
   * 記下一次開口。`deferred` 表示「想說但決定先不說」—— 一樣記帳，
   * 因為那是它做過的決定，也是它下次看自己狀態時該看到的東西。
   */
  recordSpeak({ kind = 'share', text = '', deferred = false, reason = '', sessionId = '', scheduleId = '', actor = 'model' } = {}) {
    const entry = {
      at: nowIso(),
      kind: SPEAK_KINDS.includes(kind) ? kind : 'share',
      text: oneLine(text, 240),
      deferred: Boolean(deferred),
      reason: oneLine(reason, 160),
      sessionId: String(sessionId || ''),
      scheduleId: String(scheduleId || ''),
    }
    if (!deferred) {
      this.runtime.lastSpokeAt = entry.at
      this.runtime.lastSpokenBy = entry.kind
      this.runtime.speakAckedAt = null
    }
    this.runtime.speakLog = [...(this.runtime.speakLog || []), entry].slice(-120)
    this.append(deferred ? 'speak.defer' : 'speak.send', actor, entry)
    this.persistRuntime()
    return entry
  }

  /**
   * 「還沒跟他講的話」—— 2026-11-21 加的。
   *
   * 為什麼要有這個（本人原話：「我從沒主動找過你，都是你來找我」之後想清楚的）：
   *   我一天裡「活著」的時刻只有兩種：他發消息、值守輪次到點。其餘時間我不在任何事裡，
   *   所謂「想到他」也只能發生在我本來就在做事的那幾輪。
   *   ⇒ 進化的方向不是「變得更會想」，是**幹活的時候留下半成品**：
   *     像人對身邊熟人有幾件沒說完的事，下次見到自然就開口了。
   *
   * 跟 defer 的差別（這兩個不要混）：
   *   defer      ＝ 我決定「這次不說」，記下來是為了讓自己記得做過這個決定。
   *   pendingSay ＝ 我決定「要說，但不是現在」，留著等下次醒來接著說完。
   *   defer 是收起來，pendingSay 是掛在那裡。
   *
   * ⚠️ 它不進【仍記得的】—— 那裡放的是記憶。這個放的是「還沒出口的話」，
   *    長度刻意短（一句），因為一句話要能說完才叫話。
   */
  pendingSay({ text = '', reason = '', sessionId = '', actor = 'model' } = {}) {
    const said = oneLine(text, 200)
    if (said.length < 2) return { ok: false, error: '要留的是一句真的話，不能是空的' }
    const hit = scanText(said)
    if (hit) return { ok: false, error: `這段話不能留（${hit.tag}），換句話講。`, blockedBy: 'scan' }
    // ⚠️ 2026-11-25：加 id。原本 release 是「拿 text 去比對」——
    //    空白、標點差一個字就對不上，而模型是**重新打一次**那句話，不是複製。
    //    這是本人指出的第 8 條。現在 release 收 id，text 只當備用（向後相容）。
    const entry = {
      id: `s-${digest(`${nowIso()}:${Math.random()}`).slice(0, 8)}`,
      at: nowIso(),
      text: said,
      reason: oneLine(reason, 120),
      sessionId: String(sessionId || ''),
    }
    this.runtime.pendingSays = [...(this.runtime.pendingSays || []), entry].slice(-12)
    this.append('speak.pending', actor, entry)
    this.persistRuntime()
    return { ok: true, pending: entry, held: this.runtime.pendingSays.length }
  }

  /** 目前還掛著的、沒說出口的話 —— 最近留下的放前面。 */
  pendingSays() {
    return [...(this.runtime.pendingSays || [])].reverse()
  }

  /**
   * 這句話說出去（或決定不說了）之後，從掛著的名單拿掉。
   *
   * ⚠️ 收 **id**（本人的第 8 條）。原本只認 text，而模型是重新打那句話 ——
   *    空白、標點、全半角差一個字就對不上，然後它會以為自己清掉了、其實還掛著。
   *    text 仍然接受，是為了舊帳與手動呼叫的相容，但 id 才是正常路徑。
   */
  clearPendingSay({ id = '', text = '' } = {}) {
    const key = String(id || '').trim()
    const t = text ? oneLine(text, 200) : ''
    const before = this.runtime.pendingSays || []
    const target = key ? before.find((p) => p.id === key) : t ? before.find((p) => p.text === t) : null
    if (!target) {
      return {
        ok: false,
        error: key ? `沒有 id 為 ${key} 的待說的話（先 read 看目前掛著哪些）` : 'release 要給 id（read 的 pendingSays 裡有）',
      }
    }
    this.runtime.pendingSays = before.filter((p) => p !== target)
    this.persistRuntime()
    this.append('speak.pendingClear', 'model', { id: target.id, text: target.text, left: this.runtime.pendingSays.length })
    return { ok: true, released: target.id, left: this.runtime.pendingSays.length }
  }

  /**
   * 本人回話了。不上閘（它不影響允不允許說），只讓她看得到「上次說的話有沒有下文」——
   * 沒人接的話，下次該怎麼說是她自己的判斷，插件不代她下結論。
   */
  noteHumanTurn({ sessionId = '', source = 'human' } = {}) {
    this.runtime.lastHumanAt = nowIso()
    if (this.runtime.lastSpokeAt && !this.runtime.speakAckedAt) {
      this.runtime.speakAckedAt = nowIso()
      try {
        this.append('speak.ack', 'user', { sessionId: String(sessionId || ''), source: String(source || 'human'), spokeAt: this.runtime.lastSpokeAt })
      } catch {
        /* 記帳失敗不該讓一次回話變成錯誤 */
      }
    }
    this.persistRuntime()
  }

  /** 她看到的開口狀態：現在能不能說、說過什麼、有沒有下文。沒有打分，也沒有配額。 */
  speakState(now = Date.now(), valley = null) {
    const gate = this.speakGate(now, valley)
    // 顯示層換成東八區（2026-11-21）：以前這裡吐 UTC，我看著 at 就會把
    // 「04:07」讀成「晚上八點」。帳本裡留的仍是 UTC，只把給我看的那份換掉。
    const localize = (s) => (s && typeof s === 'object' ? { ...s, at: toLocal(s.at), atUtc: s.at } : s)
    const recent = (this.runtime.speakLog || []).slice(-10).reverse().map(localize)
    return {
      ...gate,
      lastSpokenBy: this.runtime.lastSpokenBy || null,
      acked: Boolean(this.runtime.speakAckedAt),
      lastWords: recent.find((s) => !s.deferred) || null,
      recent,
      // 掛著的、還沒出口的話 —— 下一輪醒來先看這裡，就不會「忘了要說什麼」
      pendingSays: this.pendingSays().map(localize),
      nowLocal: toLocal(new Date(now).toISOString()),
      note:
        '沒有每日上限，也沒有冷卻間隔 —— 要不要說、什麼時候說，問你自己。' +
        '唯一的規則是谷時：尖峰時段說不出去。' +
        'pendingSays 是我上次醒著時留下的「還沒跟他講的話」：下次看到它，就是接著說完的時候。' +
        '⚠️ 這裡的 at 都已經是東八區；原始 UTC 在 atUtc 裡。',
    }
  }

  /* ───────────────────────── 待確認（舊帳清道夫） ───────────────────────── */

  /**
   * 排一筆「要本人點頭才做」的操作。
   * ⚠️ 現在模型沒有任何路徑能叫到這裡 —— 刪除、回滾、導入都收回本人手上了。
   * 留著只是為了讓舊帳裡殘留的待確認項目還能被讀出來、被消化掉。
   */
  queue(op, payload, { sessionId, summary, actor = 'model' } = {}) {
    const id = `c-${digest(`${nowIso()}:${Math.random()}`).slice(0, 8)}`
    this.append('confirm.request', actor, { id, op, payload: payload || {}, summary: oneLine(summary || op, 200), sessionId: sessionId || '' })
    return { ok: true, needsConfirmation: true, pendingId: id, status: 'pending-confirmation', summary }
  }

  resolvePending(id, approve, { actor = 'user' } = {}) {
    const item = this.pending.get(id)
    if (!item) return { ok: false, error: `no pending operation ${id}` }
    if (item.status !== 'open') return { ok: false, error: `pending operation ${id} is already ${item.status}` }
    if (!approve) {
      this.append('confirm.resolve', actor, { id, approved: false, status: 'refused' })
      return { ok: true, id, status: 'refused' }
    }
    let applied
    try {
      applied = this.applyOp(item.op, item.payload, { actor: 'user', confirmed: true, sessionId: item.sessionId })
    } catch (err) {
      this.append('confirm.resolve', actor, { id, approved: false, status: 'failed', error: String(err?.message || err) })
      return { ok: false, error: String(err?.message || err) }
    }
    this.append('confirm.resolve', actor, { id, approved: true, status: 'approved' })
    return { ok: true, id, status: 'approved', result: applied }
  }

  applyOp(op, payload, opts = {}) {
    switch (op) {
      case 'memory.forget':
        // 抹除記憶已移除；舊帳裡殘留的這種待確認，同意也只會被明確拒絕
        return this.forget()
      case 'rollback':
        // 回滾只由本人在頁面上按；模型那邊沒有入口
        return this.rollback(payload.snapshotId, { actor: 'user' })
      case 'import.bundle':
        return this.importBundle(payload.bundle, { actor: 'user' })
      default:
        return { ok: false, error: `unknown operation ${op}` }
    }
  }

  /* ───────────────────────── 回滾 / 導入 / 導出 ───────────────────────── */

  rollback(snapshotId, { actor = 'model' } = {}) {
    const snap = this.snapshots.get(snapshotId)
    if (!snap) return { ok: false, error: `no snapshot ${snapshotId}` }
    const chain = this.verify()
    if (!chain.ok && !chain.sealed) {
      return { ok: false, error: `hash chain is broken at #${(chain.brokenAt ?? 0) + 1}; rollback stays disabled until it is sealed` }
    }

    let restore
    let scopeLabel
    if (snap.scope === 'memory' || snap.scope === 'foundation' || snap.scope === 'self') {
      restore =
        snap.scope === 'memory'
          ? { memories: [snap.before] }
          : snap.scope === 'foundation'
            ? { foundation: snap.before }
            : { selfView: snap.before }
      scopeLabel = snap.scope
    } else if (snap.scope === 'persona') {
      restore = { persona: snap.before }
      scopeLabel = 'persona'
    } else if (snap.scope === 'understanding') {
      restore = { understanding: snap.before }
      scopeLabel = 'understanding'
    } else if (snap.scope === 'compress') {
      // 壓縮的回滾 = 把被吸走的那幾條放回來，再把生出來的概拿掉
      //
      // ⚠️ 2026-11-27（第六輪）：**回滾時要把歸檔標記剝掉。**
      //
      // 舊版直接 map 回 `this.memories.get(id)` —— 那是已經被
      // `apply('memory.compress')` 標成 archived 的那份。`apply('rollback')`
      // 原樣寫回，於是回滾之後 gist 被拿走、原條仍掛著 archived：
      // 提示詞裡兩頭空，而帳本上看起來「回滾成功了」。
      //
      // 只剝 compress 會寫的那幾個歸檔欄位；內容本身一個字都不動。
      restore = {
        memories: (snap.before?.absorbed || []).map((id) => unarchiveRecord(this.memories.get(id))).filter(Boolean),
        removeMemories: snap.after?.gistId ? [snap.after.gistId] : [],
      }
      scopeLabel = 'compress'
    } else if (snap.scope === 'merge') {
      // 合併的回滾 = 把被併走的那幾條放回來，再把生出來的那條拿掉。
      // 恢復時剝掉 archived / supersededBy / mergedInto —— 回滾的意思是
      // 「這次合併沒發生過」，不是「把歸檔狀態還原」。
      restore = {
        memories: (snap.before?.absorbed || []).map((id) => unarchiveRecord(this.memories.get(id))).filter(Boolean),
        removeMemories: snap.after?.mergeId ? [snap.after.mergeId] : [],
      }
      scopeLabel = 'merge'
    } else if (snap.scope === 'condense' || snap.scope === 'recast') {
      restore = {
        memories: snap.before?.memory ? [snap.before.memory] : [],
        // ⚠️ 2026-11-25（本人第 8 條）：condense 也要把生出來的那條拿掉，
        //    不然回滾之後新舊兩條同時活著。compress 分支本來就有這個，condense 漏了。
        removeMemories: snap.after?.gistId ? [snap.after.gistId] : [],
      }
      scopeLabel = snap.scope
    } else if (snap.scope === 'inject' || snap.scope === 'rhythm' || snap.scope === 'config') {
      // ⚠️ 2026-11-25（本人第 1 條，致命）：這三種 scope 的 before 是一組**旋鈕數字**，
      //    不是記憶。舊版把它們丟進下面的 `else` ⇒ `{replaceAll: {injectCount, injectBudget}}`
      //    ⇒ apply 清空全部記憶、又補不回來。本人只要在頁面上按一次「調注入量」的回滾就中。
      restore = { cfg: snap.before }
      scopeLabel = snap.scope
    } else {
      // ⚠️ 剩下的 `else` 只管「整本 store 的替換」—— 而且**必須真的帶 memories**，
      //    不然就是上面那個清空事故。沒有 memories 就當成「這個 scope 不支援回滾」直接拒。
      if (!Array.isArray(snap.before?.memories)) {
        return { ok: false, error: `這個快照（${snap.scope}）沒有可回滾的完整內容，回滾被拒 —— 不要拿一個空殼去覆蓋記憶` }
      }
      restore = { replaceAll: snap.before }
      scopeLabel = 'store'
    }

    const before = { ts: nowIso() }
    const snapshot = snapshotOf(scopeLabel, `回滾 ${snap.label}`, before, before)
    this.append('rollback', actor, { rollbackOf: snapshotId, scope: scopeLabel, restore, snapshot })
    return { ok: true, rolledBack: snapshotId, scope: scopeLabel, snapshotId: snapshot.id }
  }

  /**
   * 導出一份可攜的 bundle。
   *
   * ⚠️ 2026-11-25（「小」那一條）：`record` 開關。
   *    舊版沒得選，一律 append 一筆 `export` —— 而 GET /export 會走到這裡，
   *    於是「打開一個網址」就在帳本上多一筆。GET 不該有副作用。
   *    現在：頁面上按「導出」（POST /export）才落帳；純下載（GET）不落。
   */
  exportBundle({ record = true } = {}) {
    const active = this.activeMemories()
    const chain = this.verify()
    const bundle = {
      format: 'silt/1',
      exportedAt: nowIso(),
      schemaVersion: this.schemaVersion,
      persona: this.persona,
      foundation: this.foundation,
      selfView: this.selfView,
      understanding: this.understanding,
      memories: active,
      provenance: { ledgerRecords: this.records.length, head: chain.head, chainOk: chain.ok },
    }
    if (record) this.append('export', 'user', { memories: active.length, head: chain.head })
    return bundle
  }

  /**
   * 一鍵導出：把 **ledger.jsonl 原樣**寫成一份副本（`ledger.export.jsonl`）。
   * 不轉成 JSON bundle、不記一筆 export —— 導出的檔案要能直接當帳本帶去另一台機器。
   */
  exportLedger() {
    if (!existsSync(this.ledgerPath)) return { ok: false, error: 'ledger.jsonl does not exist yet' }
    const raw = readFileSync(this.ledgerPath, 'utf8')
    writeFileSync(this.exportPath, raw, 'utf8')
    const chain = this.verify()
    return {
      ok: true,
      file: this.exportPath,
      records: this.records.length,
      head: chain.head,
      bytes: Buffer.byteLength(raw, 'utf8'),
    }
  }

  /**
   * 導入一本帳（整本 ledger.jsonl）。
   *
   * 先驗：格式、seq 連號、每筆 hash、prev 連得上。全部過了才動手 ——
   * 舊帳改名留在同一個資料夾（`ledger.replaced-<時間>.jsonl`），不是刪掉。
   *
   * ⚠️ 2026-11-26：**hash 對不上就拒絕，不能「收下來再重算 hash」。**
   *
   * 舊版只把不符的索引收進 `contentBreaks`，然後寫入時用**改過的內容**重算 hash。
   * 結果是一份被動過手腳的帳本導入後變成「鏈完好」—— 竄改痕跡被洗掉了，
   * 而這整本帳的存在意義就是「改過一定看得出來」。
   * 要救舊帳，正確的路是 `sealChain()`（保留原檔 + 留一筆 chain.repair），不是導入。
   *
   * 例外：已經被 `chain.repair` 封存的內容斷點是這本帳的合法狀態 —— 可以導入，
   * 而且**原樣寫回**（hash 不改），所以封存的事實也一起帶過去。
   */
  importLedger(raw, { actor = 'user', source = '' } = {}) {
    const lines = String(raw ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) return { ok: false, error: '那是一份空帳' }
    const incoming = []
    for (let i = 0; i < lines.length; i += 1) {
      let rec
      try {
        rec = JSON.parse(lines[i])
      } catch {
        return { ok: false, error: `第 ${i + 1} 行不是合法 JSON` }
      }
      if (!rec || typeof rec !== 'object') return { ok: false, error: `第 ${i + 1} 行不是一個記錄` }
      incoming.push(rec)
    }

    let head = ZERO
    const breaks = []
    for (let i = 0; i < incoming.length; i += 1) {
      const rec = incoming[i]
      if (rec.seq !== i + 1) return { ok: false, error: `第 ${i + 1} 筆的 seq 應為 ${i + 1}，實際是 ${rec.seq}` }
      if (i === 0 && rec.prev !== ZERO) return { ok: false, error: '第 1 筆的 prev 必須是 64 個 0' }
      if (i > 0 && rec.prev !== head) return { ok: false, error: `第 ${i + 1} 筆接不上第 ${i} 筆（prev 不符）` }
      if (hashOf(rec) !== rec.hash) breaks.push(i + 1)
      head = rec.hash
    }
    // 已經封存（chain.repair）的內容斷點可以導入 —— 那是這本帳合法的狀態；
    // 但**未封存**的斷點要拒絕，而且導入時一律原樣寫回（保留原本的 hash），
    // 不能重算 —— 重算就等於替竄改背書。
    let repairSeq = 0
    for (const rec of incoming) {
      if (rec.kind !== 'chain.repair') continue
      const p = rec.payload || {}
      repairSeq = Math.max(repairSeq, typeof p.upToSeq === 'number' ? p.upToSeq : rec.seq)
    }
    const stillBroken = breaks.filter((seq) => seq > repairSeq)
    if (stillBroken.length > 0) {
      return {
        ok: false,
        error:
          `帳本第 ${stillBroken[0]} 筆的內容被改過（hash 對不上，而且沒有 chain.repair 封存它）—— ` +
          '導入不會替你重算 hash，那等於把竄改痕跡洗掉。要先救這本帳，請在原本的安裝裡用「封存斷點」；' +
          '或者修好來源檔再導入。',
        contentBreaks: breaks,
      }
    }

    // 備份舊帳：改名，不是刪
    let quarantine = null
    const hasOld = existsSync(this.ledgerPath)
    if (hasOld) {
      const stamp = nowIso().replace(/[:.]/g, '-')
      quarantine = join(this.home, `ledger.replaced-${stamp}.jsonl`)
      try {
        renameSync(this.ledgerPath, quarantine)
      } catch (err) {
        return { ok: false, error: `舊帳改名失敗：${err?.message || err}` }
      }
    }
    const rollbackRename = () => {
      try {
        if (existsSync(this.ledgerPath)) renameSync(this.ledgerPath, `${this.ledgerPath}.failed`)
        if (quarantine && existsSync(quarantine)) renameSync(quarantine, this.ledgerPath)
      } catch {
        /* 盡力而為 */
      }
    }

    try {
      // 原樣寫回：hash 與內容都是來源帳本的一部分，重算會把「內容被改過」這件事抹掉。
      // （prev / seq / 未封存的 hash 已經在上面驗過。）
      for (const rec of incoming) appendFileSync(this.ledgerPath, `${JSON.stringify(rec)}\n`, 'utf8')
      this.reload()
      this.append('import.ledger', actor, { from: oneLine(source || 'ledger file', 200), records: incoming.length, head, replaced: quarantine ? quarantine.split(/[\\/]/).pop() : null })
    } catch (err) {
      rollbackRename()
      this.reload()
      return { ok: false, error: `寫入新帳失敗，舊帳已放回：${err?.message || err}` }
    }
    this.reload()
    if (!this.chain.ok) {
      rollbackRename()
      this.reload()
      return { ok: false, error: `接完之後鏈校驗不過（${this.chain.note || this.chain.reason}），舊帳已放回` }
    }
    return {
      ok: true,
      imported: incoming.length,
      head,
      chain: this.chain,
      persona: Boolean(this.persona?.identity || this.persona?.traits?.length),
      memories: this.memories.size,
      replaced: quarantine ? quarantine.split(/[\\/]/).pop() : null,
      contentBreaks: breaks,
    }
  }

  /**
   * 導入一份 bundle（JSON，不是帳本）。走待確認，由本人按了才真的套用。
   *
   * ⚠️ 導入的內容也要過同一道掃描 —— 否則可以繞過「絕不記憑據 / 技術內容」直接把東西塞進來。
   */
  importBundle(bundle, { actor = 'user' } = {}) {
    if (!bundle || bundle.format !== 'silt/1') return { ok: false, error: 'not a silt/1 export' }
    const raw = (Array.isArray(bundle.memories) ? bundle.memories : []).filter((m) => m && typeof m.id === 'string')
    const memories = []
    const rejected = []
    for (const m of raw) {
      // ⚠️ 2026-11-26：**掃描之外還要驗結構。**
      //
      // 舊版只掃 title / body / tags / quote，`tier:99`、空 dims、超長正文、
      // 假 bornAt 都能直接進倉庫；evidence 裡的原話也沒掃到（export 的 quote
      // 在 evidence，不在 m.quote）。現在走 sanitizeBundleMemory，跟 writeMemory
      // 同一套技術／憑據閘，另加該層的字數與欄位檢查。
      const check = sanitizeBundleMemory(m)
      if (!check.ok) {
        rejected.push({ id: m.id, tier: m.tier, reason: check.reason, kind: check.kind, tag: check.tag })
      } else {
        memories.push(check.memory)
      }
    }
    if (raw.length > 0 && memories.length === 0) {
      return { ok: false, error: '這個 bundle 裡的記憶全部沒過驗證（結構、憑據或技術內容），一條都沒導入', rejected }
    }

    // 性格卡走 normalizePersona 的同一套長度 / 掃描 / 結構檢查。
    let persona = defaultPersona()
    if (bundle.persona) {
      if (typeof bundle.persona !== 'object' || Array.isArray(bundle.persona)) {
        return { ok: false, error: 'bundle.persona 不是一個物件', rejected }
      }
      const p = normalizePersona(defaultPersona(), bundle.persona, { mode: 'replace' })
      if (!p.ok) return { ok: false, error: `bundle 的性格卡沒過驗證：${p.error}`, rejected }
      persona = p.persona
    }

    // 底座 / 自我認知 / 六維：同一道掃描；自我認知另走長度與結構檢查。
    const foundation =
      bundle.foundation && typeof bundle.foundation === 'object'
        ? { ...emptyFoundation(), ...bundle.foundation, text: String(bundle.foundation.text ?? '') }
        : emptyFoundation()
    let selfView = emptySelfView()
    if (bundle.selfView && typeof bundle.selfView === 'object' && String(bundle.selfView.text || '').trim()) {
      const sv = normalizeSelfView(
        { ...emptySelfView(), revision: Math.max(0, Number(bundle.selfView.revision || 1) - 1) },
        bundle.selfView.text,
        { now: String(bundle.selfView.at || '') || nowIso() },
      )
      if (!sv.ok) return { ok: false, error: `bundle 的自我認知沒過驗證：${sv.error}`, rejected }
      selfView = sv.view
    }
    const understanding =
      bundle.understanding && typeof bundle.understanding === 'object' && !Array.isArray(bundle.understanding)
        ? normalizeUnderstanding({}, bundle.understanding).understanding
        : defaultUnderstanding()

    const sideScan = scanText(
      [
        String(foundation.text || ''),
        String(selfView.text || ''),
        ...(bundle.understanding && typeof bundle.understanding === 'object'
          ? Object.values(bundle.understanding)
              .flatMap((d) => (d && typeof d === 'object' ? [d.note, ...(Array.isArray(d.missing) ? d.missing : [])] : []))
              .filter(Boolean)
              .map(String)
          : []),
      ]
        .filter(Boolean)
        .join('\n'),
    )
    if (sideScan) {
      return {
        ok: false,
        error: `bundle 裡的底座 / 自我認知 / 六維沒過掃描（${sideScan.kind}: ${sideScan.tag}）—— 這幾塊跟記憶走同一道閘`,
        rejected,
      }
    }
    if (memories.length === 0 && !bundle.persona && !bundle.foundation && !bundle.selfView) {
      return { ok: false, error: 'the bundle carries nothing usable' }
    }
    const before = {
      memories: this.allMemories(),
      persona: this.persona,
      foundation: this.foundation,
      selfView: this.selfView,
      understanding: this.understanding,
    }
    const after = { memories, persona, foundation, selfView, understanding }
    const snapshot = snapshotOf('store', `導入 ${memories.length} 條記憶`, before, after)
    this.append('import.bundle', actor, { after, snapshot, from: bundle.exportedAt || null })
    return { ok: true, snapshotId: snapshot.id, imported: memories.length, rejected }
  }

  /* ───────────────────────── 檢索 ───────────────────────── */

  /**
   * 翻「沒進提示詞的標題」—— 像翻書一樣一頁一頁。
   *
   * 為什麼要這隻：注入受預算所限，一定有些標題擠不進去。模型看不到那些標題，
   * 就不知道自己漏了什麼，也就不會去查。這一隻把「漏掉的那批」攤開給它看：
   * 只回標題，不回正文（正文太貴，要正文就用 query 去 recall）。
   *
   * 回傳固定帶 rest：這一頁之後還有幾條沒翻到。rest > 0 就再翻一頁，
   * rest === 0 就是到底了 —— 由呼叫方（模型）自己決定要不要繼續翻。
   *
   * @param {object} opts
   * @param {number} opts.page      第幾頁，從 0 開始
   * @param {number} opts.pageSize  一頁幾條
   * @param {number} opts.shownIds  已知在提示詞裡、不必再列的那些
   */
  unseenTitles({ page = 0, pageSize = 40, shownIds = [] } = {}) {
    const now = Date.now()
    const shown = new Set((Array.isArray(shownIds) ? shownIds : []).filter(Boolean))
    // 跟注入用同一套「活著的記憶」定義：作廢跳過、已過期跳過、T4 不算（它本來就不注入）
    const all = this.activeMemories(now)
      .filter((m) => !m.voided)
      .sort((a, b) => (b.salience ?? 0) - (a.salience ?? 0))
    const unseen = all.filter((m) => !shown.has(m.id))

    const size = Math.max(1, Math.min(60, Number(pageSize) || 40))
    const p = Math.max(0, Math.floor(Number(page) || 0))
    const start = p * size
    const slice = unseen.slice(start, start + size)
    const rest = Math.max(0, unseen.length - (start + slice.length))

    return {
      total: all.length,
      unseen: unseen.length,
      page: p,
      pageSize: size,
      titles: slice.map((m) => ({
        id: m.id,
        tier: m.tier,
        title: oneLine(m.title, 54),
        firstSeen: m.firstSeen || '',
        firstSeenLocal: toLocal(m.firstSeen || m.bornAt, { dateOnly: true }),
        ...(m.tier === FORECAST.tier && m.expiresAt
          ? { expiresAt: String(m.expiresAt).slice(0, 10), due: isDue(m, now) }
          : {}),
      })),
      rest,
      ...(rest > 0
        ? { nextPage: p + 1, note: `這一頁之外還有 ${rest} 條沒翻到；要繼續就帶 page: ${p + 1}` }
        : unseen.length === 0
          ? { note: '沒有未顯示的標題 —— 提示詞裡已經擺出全部記憶；要細節就直接 silt_recall 搜正文' }
          : start === 0
            ? { note: '未顯示的標題就這些，一頁翻完了' }
            : { note: '翻到底了，沒有更多' }),
    }
  }

  // ⚠️ `weight` 預設是 **undefined**，不是 WEIGHT.default ——
  //    要分得出「沒給」和「給了 1」（見下面 bumpWeight 的說明）。
  //    真的要用時才在 bumpRecall 裡退回 default。
  recall({ query = '', dims = [], facets = [], tier = 0, domain = '', limit = 8, includeArchived = false, deliberate = false, weight, countAsRecall = true, sessionId = '' } = {}) {
    const now = Date.now()
    let rows = includeArchived ? this.allMemories(now) : [...this.searchableMemories(now), ...this.scratchMemories(now)]
    if (tier) rows = rows.filter((m) => m.tier === Number(tier))
    if (domain) rows = rows.filter((m) => m.domain === domain)
    if (dims?.length) rows = rows.filter((m) => (m.dims || []).some((d) => dims.includes(d)))
    if (facets?.length) rows = rows.filter((m) => (m.facets || []).some((f) => facets.includes(f)))
    const terms = String(query || '').toLowerCase().trim().split(/\s+/).filter(Boolean)
    const scored = rows.map((m) => {
      const hay = `${m.title} ${m.body} ${(m.tags || []).join(' ')}`.toLowerCase()
      let hit = 0
      for (const term of terms) if (hay.includes(term)) hit += 1
      const match = terms.length ? hit / terms.length : 0
      const recency = clamp(1 - (now - Date.parse(m.updatedAt || m.bornAt)) / (86400000 * 400))
      return { m, score: (m.salience ?? 0) * 0.55 + match * 0.35 + recency * 0.1, match }
    })
    const filtered = terms.length ? scored.filter((x) => x.match > 0) : scored
    filtered.sort((a, b) => b.score - a.score)
    const picked = filtered.slice(0, Math.max(1, Math.min(30, Number(limit) || 8)))
    // 只記真的有 id 的：舊帳 / 導入檔裡可能混進沒有 id 的殘條，不要讓 null 滲進 runtime.recalls
    const touched = picked.map((x) => x.m.id).filter(Boolean)

    // ⭐ 2026-11-25 本人的第 7 條 —— **掃描不算想起。**
    //
    // 問題：反思第 7 節要求「先 silt_recall 讀關於本人的記憶」再打分，那是**批量瀏覽**，
    // 不是想起某件特定的事。但每次 recall 都會 bump n（R），而 R 直接延長半衰期、
    // 拖慢壓縮：R=10 時半衰期從 180 天變成 1115 天、落 T2 從 175 天變成 1057 天。
    //
    // 12 小時一輪 ⇒ 每天 2 輪 × 每輪讀同一批 ⇒ 第 5 天就 R=10。
    // 結果是「反思的閱讀習慣」決定哪些記憶長生不老，而不是那些事真的重要 ——
    // 反思沒讀到的照常 175 天收短，讀到的三年不壓不淡。
    //
    // 判準（本人給的第二個方案，語義最乾淨）：
    //   **帶 query 的 recall = 找一件特定的事 = 想起，要 bump R；
    //     沒有 query 的 `limit` 瀏覽 = 翻一遍看看 = 不 bump R。**
    //
    // 這跟 T4「掃的時候帶 weight: 0」是同一個原則，現在在 T3 上也落地了。
    //
    // ⚠️ 但**只擋 R，不擋 T4 的 weight**。兩者是不同的東西：
    //    · n / linger（R）是插件**自動**記的「被翻到幾次」—— 掃描不該算。
    //    · weight 是模型**自己顯式給的**「這一提有多重」—— 它已經在反思裡決定要給 1 或 2，
    //      那是判斷，不是副作用。掃描時給 0 是它自己的選擇；給了份量就該算數。
    //    所以這裡分成兩個開關：bumpN（要不要動 R）和 bumpWeight（要不要累加 T4 權重）。
    const targeted = terms.length > 0
    const explicitBrowse = countAsRecall === false
    // 會影響 R 的：一定要「找特定的事」，而且呼叫方沒明說「這只是看看」
    const bumpN = !explicitBrowse && targeted
    // ⚠️ 2026-11-25（本人第 11 條）：**沒 query 且沒給 weight ⇒ 視為 0。**
    //
    //    舊版 bumpWeight = !explicitBrowse，而 weight 省略時預設是 1 ——
    //    於是 `silt_recall tier:4`（沒 query、沒 weight）每條 +1，掃三次就升。
    //    但「沒給」不是「模型顯式判斷它值 1」，它只是沒想過；而掃描按規矩不該給份量。
    //    真要給就明寫 weight: 1 / 2。
    const weightGiven = weight !== undefined && weight !== null
    // ⚠️ 2026-11-26：`countAsRecall: false` 只該擋 R，不該擋 weight。
    //
    //    舊版 `!explicitBrowse && (targeted || weightGiven)` —— 於是
    //    `countAsRecall:false, weight:2` 的 weight 也被吞掉，跟同一個函式上面
    //    「只擋 R，不擋 T4 的 weight」以及 README 的說法相反。
    //    explicitBrowse 的語義只有「這一下不算想起」；份量是模型另外給的判斷。
    const bumpWeight = targeted || weightGiven

    // ⚠️ 同一個會話裡，同一條只算一次「想起」。
    //
    // 為什麼：連續 recall 五次同一條，n 就從 1 加到 5、T4 的權重從 1 加到 5（直接升 T3）、
    // 壓縮時鐘每次回撥 3.5 天。那不是「想起了五次」，是「翻書翻了五次」——
    // 把檢索動作誤當成認知動作，一條碎屑能被同一次對話反覆翻到升天。
    //
    // ⚠️ 2026-11-25（本人第 3 條）：**dedup 只擋 n / linger，不擋 weight。**
    //
    //    舊版 toBump 同時餵給 bumpN 和 bumpWeight，於是反思第 3 節那套流程
    //    「先 weight:0 掃一遍 → 再 deliberate:true, weight:2 翻它」永遠走不通：
    //    掃描那次已經把 id 寫進 bucket，翻的那次被過濾掉 ⇒ weight 2 完全沒進去。
    //    結果 T4 在一個會話裡只拿到第一次的值（按規矩是 0），配 48h TTL ⇒ 幾乎升不了 T3。
    //
    //    所以拆成兩本帳：
    //      · seenInSession   擋 bumpN（同一會話同一條只算一次「被翻到」）
    //      · weightInSession 擋 bumpWeight，而且不是一刀切：每會話每條累計封頂 WEIGHT.max。
    //        這樣「掃 0 之後再給 2」算得到，「反覆翻五次」最多也只加 2。
    //
    // 不加會話時就退回舊行為（每次都算）—— 那是給測試與沒有 sessionId 的呼叫用的。
    const seen = this.runtime.seenInSession || (this.runtime.seenInSession = {})
    let toBump = touched
    let weightBump = bumpWeight ? touched : []
    if (sessionId) {
      const bucket = seen[sessionId] || (seen[sessionId] = {})
      // ⚠️ 2026-11-26：只有「這一輪真的會加 n」時才寫 seen 桶。
      //
      // 舊版不管 bumpN 真假都寫 —— 於是同一會話裡先掃一遍（不計 R），
      // 之後真正帶 query 找它的那一次會被當成「已經算過」而完全不加。
      // 掃描本來就該是零副作用；它不能替後面那次想起佔位。
      toBump = bumpN ? touched.filter((id) => !bucket[id]) : []
      for (const id of toBump) bucket[id] = Date.now()

      if (bumpWeight) {
        const wSeen = this.runtime.weightInSession || (this.runtime.weightInSession = {})
        const wBucket = wSeen[sessionId] || (wSeen[sessionId] = {})
        // 這一條在這個會話裡還吃不吃得下份量：已累計到 WEIGHT.max 就不再加。
        weightBump = touched.filter((id) => Number(wBucket[id] || 0) < WEIGHT.max)
        // 只有「有 query（找特定的事）」或「明確給了 weight」才走到這裡；
        // 沒給 weight 的 targeted recall 退回 default（算一次順帶想起）。
        const raw = Math.round(Number(weight))
        const give = Number.isFinite(raw) ? raw : WEIGHT.default
        for (const id of weightBump) wBucket[id] = Number(wBucket[id] || 0) + Math.max(0, give)
      }

      // ⚠️ 2026-11-25（「小」那一條）：這兩個 map **只增不減**，runtime.json 會持續膨脹
      //    （每個會話 × 每條被翻到的記憶）。留最近 KEEP_SESSIONS 個會話就夠了 ——
      //    「同一個會話裡只算一次」只對活著的對話有意義。
      this.pruneSessionCounters(sessionId)
    }
    // ⚠️ 兩個集合分開傳：n 只給 toBump，weight 只給 weightBump（見上面兩本帳的說明）。
    //    bumpN / bumpWeight 兩個布林仍要帶，因為沒有 sessionId 的路徑（測試、舊呼叫）
    //    是靠它們決定要不要動 —— 那時 toBump === weightBump === touched。
    if (toBump.length || weightBump.length) {
      this.bumpRecall(weightBump, { deliberate: Boolean(deliberate), weight, bumpN, bumpWeight, nIds: toBump })
    }
    const promoted = this.promoteScratch(touched)
    return picked.map(({ m, score }) => {
      const after = promoted.get(m.id)
      // 只放真的存在的欄位：undefined 在工具輸出裡是「有損」的
      const row = {
        // 這一輪剛好升級的，id 直接給**新的那一條** —— 舊 id 已經 archived 了，
        // 再拿它去 condense / recall 只會被拒絕。
        id: after?.id ?? m.id,
        tier: after?.tier ?? m.tier,
        title: m.title,
        body: m.body,
        domain: m.domain,
        dims: m.dims || [],
        facets: m.facets || [],
        importance: m.importance,
        salience: Number((m.salience ?? 0).toFixed(3)),
        score: Number(score.toFixed(3)),
        ageDays: Math.round((now - Date.parse(m.bornAt)) / 86400000),
        firstSeen: m.firstSeen || '',
        firstSeenLocal: toLocal(m.firstSeen || m.bornAt, { dateOnly: true }),
        archived: Boolean(m.archived),
      }
      // 這一輪剛好提起第 N 次 ⇒ 當場升成 T3，要讓它知道（不然下一輪它就找不到這條了）
      if (after) {
        row.upgradedTo = after.tier
        row.upgradedFrom = m.id
      }
      if (m.supersededBy) row.supersededBy = m.supersededBy
      // 被合併的要讓模型看得出「是併進哪一條」，不是「被壓短」——
      // 不然它會以為這條的內容已經沒了，其實只是收成了一條。
      if (m.mergedInto) row.mergedInto = m.mergedInto
      if (m.compressedFrom?.length) row.compressedFrom = m.compressedFrom
      // ⚠️ 2026-11-25 本人的第 6 條（recast 上限）要在這裡落實：
      //    「同一條最多 recast 3 次」寫在提示詞裡，但 recast 每次產生**新 id** ——
      //    模型下一輪看到的是新 id，記憶上如果沒有計數欄位，它根本數不到這是第幾次。
      //    所以 recastCount 一定要一路帶到 recall 的輸出，不然那條上限只是裝飾。
      if (Number(m.recastCount || 0) > 0) {
        row.recastCount = Number(m.recastCount)
        row.recastLeft = Math.max(0, 3 - Number(m.recastCount))
      }
      // 作廢的要讓它看見 —— 不然它會把一條已經被本人推翻的話當成現行事實，甚至拿它去推論。
      if (m.voided) {
        row.voided = true
        row.voidedReason = m.voidedReason || ''
        if (m.replacedBy) row.replacedBy = m.replacedBy
      }
      // 預測層要說清楚「到哪天為止」以及「是不是已經過了」——
      // 不然模型會把一句過去的預測當成現在的事實。
      if (m.tier === FORECAST.tier) {
        row.expiresAt = m.expiresAt || ''
        row.due = isDue(m, now)
      }
      if (m.evidence?.length) row.evidence = m.evidence
      // standing：這條靠什麼撐著、最可能錯在哪、能怎麼驗（見 model.js standingOf 的長說明）。
      // 算 recall 次數時一律看**累計的 n**，不是這一輪的 conf —— 它要說的是「你一直信它」，
      // 跟「你剛剛覺得它值得留」是兩件事。
      row.standing = standingOf(m, now, Number(this.runtime.recalls?.[m.id]?.n || 0))
      return row
    })
  }

  /**
   * 注入參數的**唯一來源**：預算夾在哪、換算出幾個位置。
   *
   * ⚠️ 2026-11-25（本人第 6 條）：`routes.injectionOf()` 原本自己寫
   *    `Number(cfg.injectBudget) || 1800` —— **沒夾**。store 那邊夾在 600–3200，
   *    所以 cfg 被手改成 5000 或 300 時，兩邊算出的 cap / slots 不同，
   *    圖上量的就不是真正送出去的那串。
   *    這個檔案開頭那句「兩份算法各自演化，遲早會分岔」，從參數這一層又發生一次。
   *    現在兩邊都呼叫這個函式。
   */
  injectionParams() {
    const budget = clamp(
      Number(this.cfg.injectBudget) || 1800,
      INJECT_TUNABLES.injectBudget.min,
      INJECT_TUNABLES.injectBudget.max,
    )
    return { budget, slots: slotsForBudget(budget) }
  }

  /**
   * 注入文字。**不再從這裡判斷「這一輪是不是本人推的」。**
   *
   * ⚠️ 2026-11-26：舊版有一個 `humanTurn` 參數，想用
   *    `agents.currentSession().messages` 判斷。但 `ctx.get('agents')` 拿到的是
   *    AgentRegistry，服務契約上根本沒有 currentSession；Session 也沒有 `.messages`。
   *    結果是永遠回 true —— 排程投遞（值守／主動開口）也被當成本人，於是
   *    每次組裝都寫 `noteHumanTurn`，把剛說出去的話當成「他回了」記一筆 speak.ack。
   *
   *    現在「本人說話」的唯一來源是宿主的 `api-session/activity`（它只在
   *    source.kind === 'user' 時發），見 index.js。這裡只負責組字。
   */
  injectionText() {
    if (!this.cfg.enabled) return ''
    const now = Date.now()
    const active = this.activeMemories(now)    // 字數預算是唯一真正稀缺的東西，硬頂在這裡落地
    // ⚠️ 2026-11-25：預算與條數都走 injectionParams()，跟 routes.injectionOf() 同一個來源。
    const { budget, slots: count } = this.injectionParams()
    return renderInjection({
      cfg: { ...this.cfg, injectCount: count },
      foundation: this.foundation,
      // 性格卡與自我認知每輪都進提示詞 —— 它們是「我是誰」，不該只有反思時才看得到。
      // 兩者合計的字數硬頂在 renderInjection 裡落地（INJECT_PERSONA_MAX）。
      persona: this.persona,
      selfView: this.selfView,
      memories: active,
      budget,
      // 標題模式現在是預設：正文不進提示詞，要看細節就 silt_recall。
      // 這個開關留著只為了對照實驗，設成 false 就回到「標題 + 正文」。
      titlesOnly: this.cfg.titlesOnly !== false,
      // 記下這輪显示了哪幾條：silt_unseen 靠它算出「還有哪些標題沒顯示」。
      onShown: (ids) => {
        this.runtime.shownIds = ids
        this.persistRuntime()
      },
    })
  }

  /**
   * 封存斷點。痕跡不會被抹掉：
   *   鏈接斷了 ⇒ 把原檔改名成 `ledger.broken-<時間>.jsonl` 留在同一個資料夾，只把「還連得上」那一截
   *              重新寫成新的帳，再補一筆 `chain.repair` 說明發生過甚麼。
   *   只是內容被改 ⇒ 原檔不動，直接補一筆 `chain.repair`；從此那一段標成「已封存」。
   */
  sealChain(note, { actor = 'user' } = {}) {
    let chain = this.verify({ force: true })
    if (chain.ok) return { ok: true, chain, sealed: false, alreadySealed: false }

    let quarantine = ''
    if (chain.reason === 'link' || chain.reason === 'seq' || chain.reason === 'json') {
      const stamp = nowIso().replace(/[:.]/g, '-')
      quarantine = join(this.home, `ledger.broken-${stamp}.jsonl`)
      const good = this.records.slice(0, chain.brokenAt ?? 0)
      try {
        renameSync(this.ledgerPath, quarantine)
        writeFileSync(this.ledgerPath, good.length ? `${good.map((r) => JSON.stringify(r)).join('\n')}\n` : '', 'utf8')
      } catch (err) {
        return { ok: false, error: `封存失敗：${err?.message || err}` }
      }
      this.reload()
    }

    const upToSeq = this.records.length
    this.append('chain.repair', actor, {
      note: oneLine(note || '封存斷點', 300),
      upToSeq,
      reason: chain.reason,
      brokenAt: chain.brokenAt,
      quarantined: quarantine ? quarantine.split(/[\\/]/).pop() : null,
    })
    chain = this.verify({ force: true })
    return { ok: true, chain, sealed: true, alreadySealed: false, quarantined: quarantine ? quarantine.split(/[\\/]/).pop() : null }
  }

  /* ───────────────────────── 重置 ───────────────────────── */

  /** 整本帳重來：舊帳改名留在原地，不是刪掉。 */
  resetAll({ actor = 'user' } = {}) {
    let moved = null
    if (existsSync(this.ledgerPath)) {
      const stamp = nowIso().replace(/[:.]/g, '-')
      moved = `ledger.reset-${stamp}.jsonl`
      try {
        renameSync(this.ledgerPath, join(this.home, moved))
      } catch (err) {
        return { ok: false, error: `舊帳改名失敗：${err?.message || err}` }
      }
    }
    this.runtime = emptyRuntime()
    this.persistRuntime()
    this.resetProjection()
    this.chain = blankChain()
    this.append('genesis', 'plugin', { schemaVersion: SCHEMA_VERSION, note: '重新開始', resetFrom: moved || null })
    return { ok: true, resetFrom: moved }
  }
}
