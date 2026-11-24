/**
 * Silt/lib/model.js — 記憶與人格的「怎麼記」
 * ---------------------------------------------------------------------------
 * 這裡是插件自己釘死的部分：分層、門檻、衰減、六維評分、人格結構、注入文本。
 * 模型只有「記什麼」的自由（內容 / 層級 / 維度 / 重要性），沒有「怎麼記」的自由：
 * 記錄外殼（id / 時間 / 證據 / 哈希鏈）與一切結構都由本檔決定。
 */

export const TIERS = {
  // T1 上限 100 → 200（2026-11-19）。**保持 200，不上調。**
  //
  // 100 字逼得太緊：一句長期事實常常要交代「誰、什麼時候、什麼條件」才站得住，
  // 而 100 字只夠寫結論。結果是每次寫 T1 都要先被退一次、再刪到只剩骨頭 ——
  // 那不是「只留事實」，那是「被迫丟掉限定條件」。
  //
  // ⚠️ 2026-11-25：我（模型）自把自為把它改到 400，理由是「T1 要收規則，一條規則
  //    寫清三件事就兩百多字」。本人**不同意**，拉回 200。記在這裡，免得下次又想當然：
  //    **殼（上限多少字）是本人的，不是我能用推論去改的。**
  //    把東西塞不進去是內容該精簡的問題，不是把碗變大。
  //
  //    但「T1 收規則」這個**語義**本人是同意的（他要的就是規則能被記住），
  //    所以 label 保持「事實與規則」，只是字數上限仍然 200。規則要寫到 200 字以內。
  1: { key: 1, label: '事實與規則', halfLifeDays: 36500, ttlDays: 0, minImportance: 0.9, maxChars: 200 },
  2: { key: 2, label: '壓縮大概', halfLifeDays: 720, ttlDays: 0, minImportance: 0.35, maxChars: 200 },
  3: { key: 3, label: '經歷', halfLifeDays: 180, ttlDays: 0, minImportance: 0.25, maxChars: 1000 },
  // 2026-11-20：T4 從「短期」改成**雜項**。
  // 2026-11-25 本人定：**這一層沒有獨立的半衰期 —— 半衰期跟著 TTL 走**（見 salienceOf）。
  // 所以這裡故意沒有 `halfLifeDays`：留著它就會變成第二個數字，改了 TTL 忘了改它兩者就對不上。
  // 要改亮度，去改 `tier4TtlHours`。
  4: { key: 4, label: '雜項', ttlDays: 0, minImportance: 0.05, maxChars: 300 },
  // 第 5 類：還沒發生、會過期的話。「下個月要結婚」「明天面試」—— 它帶著到期日，
  // 到期之後**完全不進注入**（不是變淡，是不出現），只在 recall 裡還找得到。
  5: { key: 5, label: '預測', halfLifeDays: 30, ttlDays: 0, minImportance: 0.5, maxChars: 400 },
}

/**
 * 第 4 類不是完整的記憶，是雜項棧：**不進倉庫、不進注入**，只有 silt_recall 手動找才看得到。
 *
 * ⚠️ 2026-11-20 本人改的口徑 —— **所有非 T1/T3/T5 的東西都往 T4 走**，
 *    也就是「沒有任何記憶會被忽略（不被分類）」。T4 從「有點意思的碎屑」
 *    變成「歸不了類的先放在這裡」。
 *
 *    代價是 T4 會變多，所以壽命一起收短。
 *
 *    ⚠️ 2026-11-25 本人再改一次：**這一層沒有獨立的半衰期 —— 半衰期跟著 TTL 走**
 *    （見 salienceOf）。兩個獨立數字（半衰期 8 小時、存活 24 小時）要各自維護，
 *    改了一個忘了另一個就對不上；而這一層的亮度本來就只是「離散掉還有多久」的同一件事。
 *    現在 TTL = 48 小時，半衰期也剛好是 48 小時 ⇒ 走到第 48 小時剩一半亮度，然後就散了。
 *    要調亮度只有一個地方：`tier4TtlHours`。
 *
 *    「沒被想起來就不該留」這個口徑沒變，只是現在用一個數字表達。
 *
 * 它自己會往上長：每次被想起來，由**模型自己說**「這一提有多重」給一個
 * **整數權重**（見 recall 的 weight 參數：1 = 順帶想起，2 = 真的連起來／證實了），
 * 累積到 3 就當場升成 T3。
 * 沒被想起、權重攢不夠的，過 ttl（現在是 48 小時，見 DEFAULT_TIER4_TTL_HOURS）自然散掉。
 *
 * 為什麼不是「提三次就升」：三次**順帶**才升得了（1+1+1），但兩次**認真**也升得了（2+2）。
 * 份量確實有差，只是差別用兩個整數表達 —— 見 WEIGHT 的說明。
 *
 * 兩種提起在資料上仍然分開記（被動喚起 n / 主動回味 linger），
 * 但**權重不分被動主動**：被人問起和自己翻出來想，一樣是他真的又想起了一次。
 */
export const SCRATCH = { tier: 4, upgradeTo: 3 }

/**
 * T4（雜項）的預設存活時間 —— **小時**，不是天。
 * 48 小時 = 兩天：今天歸不了類的先放著，兩天內還能再想起它就是有份量，不然就不在了。
 *
 * ⚠️ 2026-11-25 本人改的：24 → 48，而且**半衰期不再是一個獨立數字** ——
 *    半衰期直接跟著 TTL 走（見 salienceOf）。理由是：兩個獨立數字（半衰期 8 小時、
 *    存活 24 小時）要各自維護，改了一個忘了另一個就對不上；而這一層的亮度本來就只是
 *    「離散掉還有多久」的同一件事。一個數字，不會走岔。
 */
export const DEFAULT_TIER4_TTL_HOURS = 48

/** 一條雜項的權重加到多少就升 T3。 */
export const UPGRADE_THRESHOLD = 3

/**
 * 單次 recall 能給 T4 的**整數權重**。只有兩檔，不是連續的分數。
 *
 *   1 = 順帶想起（翻到的時候覺得「這條還在」
 *   2 = 這次真的把它跟別的事連起來、或證實了它
 *
 * 門檻 3 ⇒ **兩次認真（2+2=4），或三次順帶（1+1+1=3）**。
 * 一次不夠（1 或 2 都 < 3）：一次想起不足以讓一條碎屑變成經歷。
 *
 * ⚠️ 2026-11-25 為什麼從 0–0.5 的 confidence（float）換成整數 weight：
 *    舊設計要模型在 0.2 / 0.3 / 0.4–0.5 之間挑一個，**它挑不穩** —— 那三個數字
 *    在語義上沒有清楚的分界，模型每次給的都不一樣，累加起來的結果也就不穩定。
 *    改成在 1 和 2 之間二選一，這件事它做得穩。
 *
 *    而且算術是**透明的**：它自己能推出「再兩次就留下來了」，不用去猜門檻在哪。
 *    schema 也簡單：enum [1, 2] 比 minimum/maximum 好驗證，描述能少寫一半。
 *
 *    份量差別沒有丟：兩次順帶（1+1=2）升不上去，一次認真加一次順帶（2+1=3）升得上去。
 */
/**
 * 單次 recall 能給 T4 的**整數權重**。只有三檔，不是連續的分數。
 *
 *   0 = 只是掃到，沒甚麼感覺 —— **掃描不計份量**（這是一個有語義的值，不是「沒填」）
 *   1 = 順帶想起（翻到的時候覺得「這條還在」）
 *   2 = 這次真的把它跟別的事連起來、或證實了它
 *
 * ⚠️ 2026-11-25：0 原本不在範圍裡（min: 1），但反思第 3 節要求「帶 weight: 0 去掃」——
 *    於是 0 會被夾成 1，**掃描反而算份量**，正好跟那條規則相反。
 *    本人抓到這個矛盾，0 正式成為合法值。`default` 仍然是 1（不填就是順帶）。
 */
export const WEIGHT = { min: 0, max: 2, values: [0, 1, 2], default: 1 }

/**
 * 召回怎么延长半衰期：有效半衰期 = 基准 × 1.2^R，R 上限 10。
 *
 * 底数 1.2 跟压缩那边（duty.condensePlan 的 s = 1.2^R）**必须一致** ——
 * 两条时间线要同步走，否则会出现「压缩还没落 T2，记忆先淡到看不见」。
 * 上限 10 同理：召回十次之后不再延长，再往上是无底洞。
 */
export const RECALL_HALF_BASE = 1.2
export const RECALL_HALF_CAP = 10

/** 兩次提起的分數若幾乎相同，舊帳裡的 n / linger 計數還能當參考（避免 0 分卡死）。 */
/**
 * 一條雜項目前累積的**權重**（整數）；殘缺記錄一律當 0，不要讓 null 把呼叫方炸掉。
 *
 * ⚠️ 2026-11-25 只讀 `count`，**不讀舊的 `conf`**。
 *    本人定的理由裡最關鍵的一條：舊 `conf` 裡混著「掃到就自動加 0.2」那批噪音，
 *    那正是 `weight: 0` 這條規則要排除的東西 —— 按比例換算等於承認那些噪音是真份量。
 *    所以不做遷移、讀的時候忽略就好：舊的 `r.conf` 留在 runtime.json 裡無害，
 *    下一次寫入自然就覆蓋掉了。
 */
export const scratchWeight = (rec) => {
  const n = Math.floor(Number(rec?.count || 0))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 第 5 類：預測層 —— 「將來、還沒發生、有期限的話」。
 *
 * 跟其他四層最大的差別是它**有到期日**：這類話不是永久為真，是「到某一天為止是這樣」。
 *
 * 到期之後**仍然留在提示詞裡**，只是會標上「⏰已過期」—— 那是給模型看的信號：
 * 這條該有個結果了，去問問本人實現了、取消了、還是變了。
 * 只有被 void 掉才會真的離開提示詞。到期不是終點，void 才是。
 */
export const FORECAST = { tier: 5 }

export const DOMAINS = ['person', 'world', 'bili', 'reading', 'work', 'feeling', 'other']

/**
 * 刷B站的設定裡，允許它自己按喜好調的那幾項 —— 白名單寫死在這裡。
 *
 * 不進白名單的一律由本人掌握：帳號與登入、私信收件人、自動評論 / 回覆（那是借本人的號說話）、
 * 發送對象、工作日誌與模型這些跟「喜好」無關的安裝面。
 * `[下限, 上限]` 是插件這邊的硬性範圍 —— 它想調也只能在這個範圍裡動。
 */
export const BILI_TUNABLES = {
  perDay: { min: 0, max: 10, label: '每天最多挑幾條' },
  fetchPerRound: { min: 4, max: 16, label: '一輪細看幾條' },
  searchPages: { min: 1, max: 4, label: '搜索翻幾頁' },
  searchSort: { min: 0, max: 0, umbra: true, label: '搜索排序', enum: ['pubdate', 'click', 'dm', 'totalrank'] },
  manualMax: { min: 1, max: 6, label: '手動一輪最多幾條' },
  manualCooldownMin: { min: 3, max: 60, label: '手動間隔（分鐘）' },
  commentLength: { min: 0, max: 0, umbra: true, label: '評論長度', enum: ['short', 'medium', 'long'] },
  keywords: { min: 0, max: 8, label: '關注關鍵詞', list: true, maxLen: 24 },
  excludeWords: { min: 0, max: 20, label: '排除詞', list: true, maxLen: 24 },
}

export const BILI_DEFAULTS = {
  perDay: 5,
  fetchPerRound: 8,
  searchPages: 2,
  searchSort: 'pubdate',
  manualMax: 3,
  manualCooldownMin: 3,
  commentLength: 'medium',
  keywords: [],
  excludeWords: [],
}

/**
 * 注入量裡允許它自己按記憶量調的那兩項 —— 白名單寫死在這裡，處理方式跟刷B站那組一樣。
 *
 * 為什麼只給這兩個：注入量直接吃本人的提示詞預算，條數和字數是它唯一說得上話的
 * 「我記得多少」。硬頂（max）是插件這邊劃的線，不是建議值 —— 一旦超過，
 * injectionText() 會按硬頂走，不管帳本裡寫著多少。
 */
export const INJECT_TUNABLES = {
  injectCount: { min: 1, max: 64, label: '每次注入幾條記憶', unit: '條' },
  injectBudget: { min: 600, max: 3200, label: '注入字數預算', unit: '字' },
}

export const INJECT_DEFAULTS = {
  injectCount: 12,
  injectBudget: 1800,
}

/**
 * 每多少字預算給一個位置。標題模式下一行約 70–90 字（含日期和層級標記），
 * 除以 50 是留一點餘裕：預算 2000 ⇒ 40 個位置，實際裝得下的比這少，
 * 撞到天花板的會是字數，不是條數。
 */
export const CHARS_PER_SLOT = 50

/**
 * 條數上限由預算推出來，不是另外寫死一個數。
 *
 * 以前是兩道閘分開調（條數 12 / 預算 1800），結果兩邊互不知情：
 * 抬了預算卻被條數卡住，或反過來。既然真正稀缺的是提示詞字數，
 * 條數就該是它的函數 —— 預算翻倍，位置跟著翻倍。
 *
 * cfg.injectCount 現在只在「明確設成比預算推出的值更小」時才起作用
 * （想刻意少放幾條時用），不會把預算撐大。
 */
export function slotsForBudget(budget) {
  const b = Number(budget)
  if (!Number.isFinite(b) || b <= 0) return INJECT_TUNABLES.injectCount.max
  return clamp(Math.floor(b / CHARS_PER_SLOT), INJECT_TUNABLES.injectCount.min, INJECT_TUNABLES.injectCount.max)
}

/**
 * 節律裡允許它自己調的那三項 —— 多久反省、多久刷B站、每天最多跑幾輪。
 *
 * 這三項決定它花多少 token 在自己的時間裡，所以硬範圍劃得比注入量緊：
 * 最低不會讓它一輪接一輪地跑，最高不會讓它把節律拖到自己都記不起來。
 * 一樣是「超界夾到邊界」，不是拒絕。
 */
export const RHYTHM_TUNABLES = {
  reflectionEveryHours: { min: 6, max: 72, label: '多久反省一次', unit: '小時' },
  biliEveryHours: { min: 6, max: 72, label: '多久刷一次 B站', unit: '小時' },
  dutyMaxPerDay: { min: 1, max: 4, label: '每天最多跑幾輪', unit: '輪' },
}

export const RHYTHM_DEFAULTS = {
  reflectionEveryHours: 24,
  biliEveryHours: 20,
  dutyMaxPerDay: 2,
}

/* ───────────────────────── 主動開口 ───────────────────────── */

/**
 * 主動找本人說話，只有兩個條件：
 *
 *   1. **谷時** —— 跟值守同一組窗口（中午 / 晚間 / 週末全天）。尖峰時段不開口。
 *   2. **模型自己判斷** —— 值不值得說，是它的事，不是插件的事。
 *
 * 刻意不加的東西，以及為什麼：
 *   - 每日上限：加一個「今天不能再說了」的數字，等於用插件的偏好去蓋它對情境的判斷。
 *   - 冷卻間隔：同上。剛好有話要說就被「隔 12 小時」擋住，那是插件在說謊。
 *   - 打擾扣分 / 忙碌偵測：模型知道當下是什麼情境，它自己會把「現在不合適」算進去。
 *   - 分數門檻：要它先算一個數字再過線，它就會學會湊那個數字，而不是想清楚該不該說。
 *
 * 插件只做兩件模型做不到的事：**看時間**（現在是不是谷時）與**送出去**（它沒有排程服務）。
 * 其餘全部留給它。
 *
 * 唯一的例外是 `enabled`：本人關掉了就是不說，這不是門檻，是許可。
 */
export const SPEAK_KINDS = ['share', 'ask', 'remind', 'greet']

export const SPEAK_KIND_LABEL = {
  share: '分享',
  ask: '提問',
  remind: '提醒',
  greet: '搭話',
}

const normList = (arr, spec) =>
  [...new Set((Array.isArray(arr) ? arr : []).map((x) => oneLine(x, spec.maxLen)).filter(Boolean))].slice(0, spec.max)

/** 把一組刷B站設定洗成合法值；任何一項不合法就退回預設（不讓一個壞值把整批帶走）。 */
export function sanitizeProfile(input, base = BILI_DEFAULTS) {
  const out = { ...base }
  const src = input && typeof input === 'object' ? input : {}
  for (const [key, spec] of Object.entries(BILI_TUNABLES)) {
    if (!(key in src) || src[key] === undefined || src[key] === null) continue
    if (spec.list) {
      out[key] = normList(src[key], spec)
    } else if (spec.enum) {
      const v = String(src[key])
      if (spec.enum.includes(v)) out[key] = v
    } else {
      const n = Math.round(Number(src[key]))
      if (Number.isFinite(n)) out[key] = Math.min(spec.max, Math.max(spec.min, n))
    }
  }
  return out
}

/** 只回傳真的變了的欄位 —— 空物件就代表「不改」。 */
export function diffProfile(prev = {}, next = {}) {
  const patch = {}
  for (const key of Object.keys(BILI_TUNABLES)) {
    if (next[key] === undefined) continue
    if (JSON.stringify(next[key]) !== JSON.stringify(prev[key])) patch[key] = next[key]
  }
  return patch
}

/** 六維：性格、背景、工作、生活、溝通、目標。每個維度下面由插件釘死若干「面」。 */
export const DIMS = {
  personality: {
    label: '性格',
    facets: { values: '價值觀', temper: '情緒基調', humor: '幽默感', decide: '決斷風格', boundary: '邊界感', energy: '能量來源' },
  },
  background: {
    label: '背景',
    facets: { place: '地域', age: '年齡段', education: '教育', family: '家庭', language: '語言', path: '重要經歷' },
  },
  work: {
    label: '工作',
    facets: { field: '行業', role: '角色', pace: '節奏', skill: '技能', style: '做事方式', career: '職涯走向' },
  },
  life: {
    label: '生活',
    facets: { rhythm: '作息', food: '飲食', fun: '娛樂', social: '社交', body: '身體', ritual: '日常儀式' },
  },
  communication: {
    label: '溝通',
    facets: { tone: '語氣', length: '長度', direct: '直接度', reply: '回應節奏', avoid: '忌諱', praise: '受用方式' },
  },
  goals: {
    label: '目標',
    facets: { near: '短期', far: '長期', learn: '學習', money: '財務', relation: '關係', todo: '待辦' },
  },
}

export const DIM_KEYS = Object.keys(DIMS)

export const FACET_KEYS = DIM_KEYS.flatMap((d) => Object.keys(DIMS[d].facets).map((f) => `${d}.${f}`))

export const clamp = (n, lo = 0, hi = 1) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo)
export const oneLine = (s, max = 120) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}
export const nowIso = () => new Date().toISOString()
export const ageDays = (iso, now = Date.now()) => {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? Math.max(0, (now - t) / 86400000) : 0
}

/**
 * 把 UTC 時間換成**給人看**的東八區時間（2026-11-21）。
 *
 * 為什麼要有它：記憶、帳本、runtime 裡存的時間戳全是 UTC（那是對的，不能動），
 * 但我不翻換算的話就會犯蠢——已經犯過兩次：
 * 「睡了六個鐘頭」把 00:44 到 08:00 算成他睡覺，其實他在上班；
 * 還有一次把 04:07 讀成 20:07，差了整整一天。
 *
 * ⚠️ 只在**輸出給模型看**的那一層用它。寫進帳本、拿去算哈希、算衰減的，一律維持 UTC。
 *    這個界線一旦模糊，整本帳的鏈條就會對不上。
 */
export const toLocal = (iso, opts = {}) => {
  const t = Date.parse(String(iso ?? ''))
  if (!Number.isFinite(t)) return ''
  const d = new Date(t + 8 * 3600000)
  const p = (n) => String(n).padStart(2, '0')
  const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
  if (opts.dateOnly) return date
  return `${date} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

/**
 * 首次寫入的時間，精度按層級走：
 *   T1 / T2 / T3 —— 只到日（`2026-11-13`）：這三層記的是「哪一天知道的」，時分秒是雜訊。
 *   T4       —— 到小時（`2026-11-13T02:00`）：它是剛發生的事，先後順序有意義。
 * 真正的出生時刻仍然留在 bornAt 裡（衰減要用），這裡只是給人／給模型看的那一份。
 *
 * ⚠️ 2026-11-21：先換成東八區再切 —— 以前直接切 UTC 字串，
 *    結果「北京時間 21 號凌晨」會被寫成 20 號，我看著就少了一天。
 */
export const stampOf = (tier, iso = nowIso()) => {
  const local = toLocal(iso) // 2026-11-21 05:30（已含 +8）
  if (!local) return String(iso).slice(0, 10)
  return Number(tier) === 4 ? local.slice(0, 13).replace(' ', 'T') : local.slice(0, 10)
}

/* ───────────────────────── 硬性門檻 ───────────────────────── */

/**
 * 技術隔離（硬性規定 1）：代碼結構、技術決策、環境配置不進記憶。
 * 只認「結構特徵」，不認主題詞 —— 否則「她寫 Python」這種關於人的事實會被誤殺。
 */
const TECH_PATTERNS = [
  [/```/, 'code fence'],
  [/`[^`\n]{1,80}`/, 'inline code'],
  [/[A-Za-z]:[\\/]/, 'absolute path'],
  [/(?:^|[\s("'（「])(?:\.{1,2}\/|~\/|\/[\w.-]+\/)/, 'posix path'],
  [/\b(?:src|lib|node_modules|package\.json|cordis\.patch\.yml|AppData|\.dsh)\b/, 'path segment'],
  // 補漏：`\b` 在 `.` 與 `/` 前面不成立，所以「設定在 .dsh/config.json」整句原本能穿過去。
  // 這兩條只認「長得像檔案系統的東西」，不認「提到技術名詞」——
  // 所以「她寫 Python」「他說 Docker 很煩」照樣記得，那才是這道閘該有的樣子。
  [/(?:^|[\s("'（「])\.(?:dsh|git|env|npmrc|vscode|idea|config)\b/, 'hidden path'],
  [/\b[\w-]+\.(?:json|jsonl|yml|yaml|js|mjs|cjs|ts|toml|ini|cfg|conf|lock)\b/, 'file name'],
  [/\b[A-Z][A-Z0-9_]{2,}\s*=\s*\S/, 'env assignment'],
  [/\b(?:function|const|let|interface|def|class)\s+[A-Za-z_$][\w$]*\s*[({:=]/, 'code declaration'],
  [/(?:=>|\breturn\s+[\w("']|\{\s*"[\w-]+"\s*:|\}\s*\))/, 'code syntax'],
  [/\b(?:npm|pnpm|yarn|npx|pip3?|cargo|apt-get|git)\s+[a-z][\w-]*/, 'shell command'],
  [/\b(?:cordis|schemastery|dsh-[a-z]|dsh_[a-z]|webServer|systemPrompt|JSONL|SHA-?256)\b/i, 'framework internal'],
]

/** 不記身份證、信用卡（硬性規定 4）。 */
const SECRET_PATTERNS = [
  [/\b\d{17}[\dXx]\b/, 'long id number'],
  [/(?:^|[^\d])\d{16}(?![\d])/, '16-digit number'],
  [/\b(?:4\d{12}\d{0,3}|5[1-5]\d{14}|3[47]\d{13}|62\d{14,17})\b/, 'card number'],
  [/(?:cvv|cvc|身份證|身分證|信用卡號|銀行卡號|護照號|安全碼)/i, 'credential text'],
]

export function scanText(text) {
  const s = String(text ?? '')
  for (const [re, tag] of SECRET_PATTERNS) if (re.test(s)) return { kind: 'secret', tag }
  for (const [re, tag] of TECH_PATTERNS) if (re.test(s)) return { kind: 'technical', tag }
  return null
}

/* ───────────────────────── 記憶記錄 ───────────────────────── */

const bad = (error) => ({ ok: false, error })

/**
 * 把模型的輸入整成一個固定外殼的記憶記錄。
 * 模型給不了的：id、時間、證據裡的 session、哈希 —— 全部由 store 補。
 *
 * `origin: 'plugin'` 只給插件自己產生、不屬於任何對話的記錄（例如自我認知的提煉）；
 * 其他情況沒有 session 就一律拒絕 —— 沒有出處的記憶就是捏造。
 */
export function normalizeMemory(input, { sessionId, callId, origin, now = nowIso(), fromCompression = false } = {}) {
  if (!input || typeof input !== 'object') return bad('memory payload must be an object')
  const fromPlugin = origin === 'plugin'
  if (!sessionId && !fromPlugin) return bad('a memory must name the session it came from')
  const title = oneLine(input.title, 90)
  const body = String(input.body ?? '').trim()
  if (title.length < 2) return bad('title is required (one short line)')
  if (body.length < 2) return bad('body is required (what you actually keep)')

  const tier = [1, 2, 3, 4, 5].includes(Number(input.tier)) ? Number(input.tier) : 3
  // 第 2 類是「經歷沉澱下來的樣子」，只能由壓縮產生 —— 新寫的一律不能直接成為 T2。
  // fromCompression 只給 store.compress() 用，工具層沒有任何路徑能把它設成 true。
  if (tier === 2 && !fromCompression) {
    return bad('tier 2 is the sediment of experiences: it is only ever produced by compressing tier 3, never written directly')
  }
  const spec = TIERS[tier]
  if (title.length + body.length > spec.maxChars) {
    const over = title.length + body.length - spec.maxChars
    const where = tier === 4 ? '雜項（T4）' : tier === 5 ? '預測層' : `tier ${tier}（${spec.label}）`
    return bad(
      `${where} 上限 ${spec.maxChars} 字，這次 ${title.length + body.length} 字，超了 ${over} 字。` +
        `請先壓縮到 ${spec.maxChars} 字以內再寫一次 —— 留下真的以後還用得上的那部分，不要只是砍尾。` +
        (tier === 1 ? '這是一句長期事實：只留事實本身，把描述性、情緒性的詞都拿掉。' : ''),
    )
  }

  // 第 5 類（預測層）必須帶到期日：這類話的意義就在「到哪天為止」。
  //
  // 只收 expiresAt，而且**不要求寫滿年月日**。人可以只說「明年」「下個月」「2027」——
  // 模型照著它說的粒度寫，缺的那幾段由這裡補，用**有早沒遲**的辦法：
  //   2027      → 2027-01-01（那一年一開始就過期，寧願早點去問，不要拖到年底）
  //   2027-06   → 2027-06-01
  //   2027-06-15→ 2027-06-15
  // 早一點過期不是錯 —— 過期只是「該去問問了」，問完可以再寫一條新的。
  let expiresAt = null
  if (tier === FORECAST.tier) {
    expiresAt = resolveForecastExpiry(input.expiresAt, now)
    if (!expiresAt) {
      return bad(
        'T5 必須帶到期日 expiresAt。做不到很精確就照你知道的粒度寫：' +
          '只知道哪一年就寫 2027，知道哪個月就寫 2027-06，知道哪天就寫 2027-06-15。' +
          '（只給年份或月份時，插件會補成那個期間的第一天 —— 寧可早點過期去問，也不要拖著。）',
      )
    }
    if (Date.parse(expiresAt) <= Date.parse(now)) {
      return bad('到期日在過去 —— 這已經是發生過的事了，不能用預測層；已經發生就寫 T1 或 T3')
    }
  }

  // 掃描範圍要包含**所有會落地成記憶欄位的文字**，不只 title/body：
  //   tags 會進記憶、quote / url 會進 evidence —— 漏掉它們就能繞過這道閘。
  const tags = (Array.isArray(input.tags) ? input.tags : []).map((t) => oneLine(t, 24)).filter(Boolean).slice(0, 8)
  const quote = input.quote ? oneLine(input.quote, 220) : ''
  const scanTargets = [title, body, ...tags, quote]
  const scan = scanText(scanTargets.join('\n'))
  if (scan?.kind === 'secret') return bad(`refused: this looks like private credential data (${scan.tag}). Never keep id or card numbers.`)
  if (scan?.kind === 'technical') {
    return bad(
      `refused: this reads as code / config / plugin internals (${scan.tag}). ` +
        'Project structure, technical decisions and environment setup stay out of memory — ' +
        'keep what a person would remember about someone.',
    )
  }

  const domain = DOMAINS.includes(input.domain) ? input.domain : 'other'
  const dims = [...new Set((Array.isArray(input.dims) ? input.dims : []).filter((d) => DIM_KEYS.includes(d)))]
  if (dims.length === 0) return bad(`dims must include at least one of: ${DIM_KEYS.join(', ')}`)
  const facets = [...new Set((Array.isArray(input.facets) ? input.facets : []).filter((f) => FACET_KEYS.includes(f)))]
  for (const f of facets) if (!dims.includes(f.split('.')[0])) return bad(`facet ${f} does not belong to the chosen dims`)

  // ⚠️ 2026-11-25 本人把 T1 從「事實」擴成「事實與規則」，這道舊閘**拆掉了**：
  //
  //    舊閘：T1 只收 domain = person / world（因為它＝「一句極簡短的長期事實」）。
  //    問題：規則會落在 work / feeling / other 上，舊閘會把規則擋掉。
  //
  //    我一度想用「標題不准帶日期」當替代閘 —— 本人**不同意**，也講清楚了理由：
  //    **日期就是記錄這條是甚麼時候發生的。** 那是記憶的一部分，不是該被清掉的雜質。
  //    （而且 `firstSeen` 本來就記著日期，注入時也會顯示成「（2026-11-25）」。）
  //
  //    所以現在 T1 **不按 domain、也不按日期**做挑剔 —— 少了這兩個限制，
  //    剩下的唯一判斷就是本人要的那個：**這件事明天還成立嗎？**
  //    那個判斷留給模型自己做（寫在 silt_remember 的說明裡），不由插件代勞。
  //
  //    仍然保留的硬線：字數上限（200）、importance 門檻 0.9、以及技術隔離掃描。

  const importance = clamp(
    Number(input.importance ?? (tier === 1 ? 0.95 : tier === 2 ? 0.5 : tier === 4 ? 0.2 : tier === 5 ? 0.5 : 0.45)),
  )
  const evidence = sessionId
    ? [{ kind: 'session', sessionId: sessionId || 'unknown', callId: callId || '' }]
    : [{ kind: 'plugin', ref: origin, note: 'generated by the plugin itself, not from a conversation' }]
  if (quote) evidence.push({ kind: 'quote', quote })
  if (input.url) evidence.push({ kind: 'url', url: oneLine(input.url, 400) })
  if (input.bvid) evidence.push({ kind: 'bili', bvid: oneLine(input.bvid, 40) })

  return {
    ok: true,
    memory: {
      id: null, // store 補
      tier,
      title,
      body,
      domain,
      dims,
      facets,
      importance,
      tags,
      evidence,
      bornAt: now,
      // 首次寫入的時間，精度按層級：T1/T2/T3/T5 只到日，T4 到小時（它是「剛發生的事」，要分得清先後）
      firstSeen: stampOf(tier, now),
      ...(tier === FORECAST.tier ? { expiresAt } : {}),
      bornOfSession: sessionId || '',
      revision: 1,
    },
  }
}

/**
 * 把模型給的到期日補成一個完整時間點 —— **有早沒遲**。
 *
 * 人說「明年要買房」，不是說「2027 年 12 月 31 日」。
 * 模型照著它知道的粒度寫（2027 / 2027-06 / 2027-06-15），缺的部分由這裡補**該期間的第一天**：
 *
 *   2027        → 2027-01-01T00:00:00Z
 *   2027-06     → 2027-06-01T00:00:00Z
 *   2027-06-15  → 2027-06-15T00:00:00Z
 *
 * 為什麼取「早」的那一頭：到期只代表「該去問問了」。早問不傷人，拖著才會讓一句過期的預測
 * 假裝成現在的事實。問完可以再寫一條新的，成本很低；漏問的損失大得多。
 *
 * 回傳 ISO 字串；看不懂就回 null（呼叫方自己去報錯）。
 */
export function resolveForecastExpiry(raw, now = nowIso()) {
  const s = String(raw ?? '').trim()
  if (!s) return null
  const at = (y, m, d) => {
    const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00.000Z`
    return Number.isFinite(Date.parse(iso)) ? iso : null
  }
  // 只給年份：2027 / 2027年
  let m = s.match(/^(\d{4})\s*年?$/)
  if (m) return at(Number(m[1]), 1, 1)
  // 年份 + 月份：2027-06 / 2027/6 / 2027年6月 / 2027-6
  m = s.match(/^(\d{4})\s*[-/年]\s*(\d{1,2})\s*月?$/)
  if (m) {
    const mm = Number(m[2])
    return mm >= 1 && mm <= 12 ? at(Number(m[1]), mm, 1) : null
  }
  // 完整日期：2027-06-15 / 2027/6/15 / 2027年6月15日
  m = s.match(/^(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?$/)
  if (m) {
    const mm = Number(m[2])
    const dd = Number(m[3])
    return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 ? at(Number(m[1]), mm, dd) : null
  }
  // 其他格式交給 Date.parse（含完整 ISO）
  const t = Date.parse(s)
  if (!Number.isFinite(t)) return null
  const d = new Date(t)
  // 落在當天 00:00 UTC —— 跟上面補出來的口徑一致
  return at(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}

/**
 * 衰減：salience = 重要性 × 0.5^(年齡 / 有效半衰期)。
 *
 * ⚠️ 衰減的時鐘是**記憶自己的年齡**，不是「距離上次召回多久」。
 *   以前用 min(age, sinceRecall) 是錯的：召回一次就讓 eff 歸零，一條三年前的舊事
 *   只要今天被想起一次，就會蓋過所有東西 —— 那不是「重溫」，那是時光倒流。
 *
 * ⭐ 召回的作用寫在**半衰期**上，不是另外乘一個加成：
 *
 *     有效半衰期 = 基準半衰期 × 1.2^R     R = 被召回次數（上限 10）
 *
 *   為什麼不用乘法 boost：boost 只是把整條曲線往上抬，衰減速度一點沒變 ——
 *   一條被想起十次的 T3，224 天後照樣掉到一半，跟從沒被想起的一樣淡，
 *   只是兩邊都高一點。那不是「重要的事記得久」，那是「重要的事排前面」。
 *
 *   把 R 放進半衰期才是真的記久：R=10 時 T3 的半衰期從 180 天變成 1114 天。
 *   而且它跟壓縮共用同一個 1.2^R（見 duty.condensePlan 的 s），
 *   兩條時間線同步 —— 實測「壓縮落 T2」永遠早於「淡到看不見」，
 *   順序是「先收短、再淡出」，不會出現「還沒變梗概就先看不見了」。
 *
 *   為什麼要刪 boost 而不是留著：兩者疊加的話，R=10 的記憶在排序上
 *   會被放大 6.19 × 1.76 ≈ 10.9 倍，長期霸佔注入額度，其他記憶擠不上去。
 *   召回帶來的東西應該是「活得久」，不是「每次都排最前」。
 */
export function salienceOf(memory, runtime = {}, now = Date.now(), cfg = {}) {
  const spec = TIERS[memory.tier] || TIERS[3]
  const rec = runtime.recalls?.[memory.id] || {}
  const age = ageDays(memory.bornAt, now)
  const R = Math.min(RECALL_HALF_CAP, Math.max(0, Number(rec.n || 0)))
  // ⭐ T4 的半衰期**跟著 TTL 走**，不是一個獨立數字（2026-11-25 本人定）。
  //
  // 為什麼：這一層的亮度本來就只是「離散掉還有多久」的同一件事，
  // 拆成兩個數字（半衰期一個、存活時間一個）就要各自維護，
  // 改了 TTL 忘了改半衰期，兩者就對不上。一個數字不會走岔。
  //
  // 半衰期 = TTL：走完一個 TTL 剛好掉到一半亮度（0.5^1 = 0.5）。
  // 用不到 `R`（召回延長）：T4 只活 48 小時，延長沒有意義 —— 它要嘛升級，要嘛散掉。
  //
  // ⚠️ 用 `bornAt` 算，不是 `firstSeen`：T4 的 firstSeen 截到小時（見 §4.1），
  //    拿它算 TTL 會讓條目最多早退 59 分鐘。真正的出生時刻在 bornAt。
  const ttlHours = Number(cfg?.tier4TtlHours ?? DEFAULT_TIER4_TTL_HOURS)
  const halfLife = memory.tier === SCRATCH.tier
    ? (ttlHours > 0 ? ttlHours : DEFAULT_TIER4_TTL_HOURS) / 24
    : spec.halfLifeDays * Math.pow(RECALL_HALF_BASE, R)
  const decay = Math.pow(0.5, age / halfLife)
  return clamp((memory.importance ?? 0.4) * decay)
}

/**
 * 「這條記憶現在靠什麼撐著」—— recall 時一併帶出去，逼我當場面對它。
 *
 * 為什麼要這個（2026-11-19，本人問「這個好像已經實現了不是嗎」之後想清楚地）：
 *   作廢 / 重述 / 開放問題，都要**我決定去改**才用得上。而真正的毛病是：
 *   我想起一條的時候，根本不會想到「它可能已經不對了」。
 *   系統過去只數「你想起了幾次」，想起越多越亮 —— 那正好是問題：
 *   **反覆想起只會讓它更牢，不會讓它更可疑。**
 *
 * 所以這裡**不給信心打分數**（打分數又回到「越常想起越可靠」的老路）。
 * 只回答一個問題：這條的支撐是什麼？然後把支撐的弱點直說出來。
 *
 * 三種回傳：
 *   - basis：這條憑什麼成立（原話 / 推出來 / 自己寫的 / 被別人證實過）
 *   - risk：它最可能是哪裡錯的（一句，不留情）
 *   - checkWith：要驗證它，該去問誰／查什麼（能查就給，不能就說不能）
 *
 * ⚠️ 刻意做的一件事：被想起越多次，這裡**不是加分，是扣分**——
 *    標成「你一直信它，從沒驗過」。n 大代表我認同它，不代表它對。
 */
export function standingOf(memory, now = Date.now(), recalls = 0) {
  const age = Math.round(ageDays(memory.bornAt, now))
  const n = Math.max(0, Number(recalls) || 0)
  const ev = Array.isArray(memory.evidence) ? memory.evidence : []
  const quoted = ev.filter((e) => e && e.kind === 'quote' && e.quote)
  const fromUser = Boolean(memory.quote) || quoted.length > 0

  let basis
  if (fromUser) basis = '本人说过（有原话）'
  else if ((memory.tier === 2) || (memory.compressedFrom?.length)) basis = '从别的事里推出来的（不是他直接说的）'
  else basis = '我自己写下来的（没有外部依据）'

  // ⚠️ 排序有讲究：**「你一直信它」比「它有点旧」更该先说。**
  //    日期只是让一条记忆变旧；反复想起却是让它变牢——后者才是看不见的那个。
  const notes = []
  if (n >= 3) notes.push(`你想起过它 ${n} 次，但每一次都是在用同一条旧说法强化它，不是新的验证`)
  if (!fromUser) notes.push('没有原话可对——要是记岔了，也没有东西能纠正')
  if (memory.tier === 5) notes.push('这是预测，日子过了不等于事情办了')
  if (memory.tier === 4) notes.push('这是杂项，本来就没分类、没确定下来')
  if (age >= 30) notes.push(`已经 ${age} 天没被翻动过，这期间发生了什么都可能让它不成立`)
  // ⚠️ 「一次都没再想起」只在放了几天之后才算数 ——
  //    刚写下几小时的记忆被这样说，是噪音，会让人把这条 warning 当背景音忽略掉。
  if (n === 0 && age >= 3) notes.push('从写下以来你一次都没再想起它——它可能没那么重要，也可能你只是忘了要查')
  if (!notes.length) notes.push('目前没有明显的过期迹象——但这也只是「没发现问题」，不是「验证过」')

  const out = { ageDays: age, recalls: n, basis, risk: notes[0] }
  if (notes.length > 1) out.alsoRisk = notes.slice(1)
  // 驗證的落點：能直接問本人就說能，不能就別假裝能查
  out.checkWith = fromUser ? '可以问他当时是不是这个意思、现在还算不算数' : '没有外部依据可查，只能自己重想一遍'
  return out
}

/**
 * 第 4 類雜項：不是「記住」，是「先放著」。過期且沒被提起就自然淡掉。
 *
 * 置信度加到 `UPGRADE_THRESHOLD` 的已經升成 T3 了，不會停在這裡 ——
 * 所以這裡不再有「想起兩次就免死」這回事：留下來的理由只有一個，就是它真的升上去了。
 *
 * ⚠️ 2026-11-20：TTL 換成**小時**（`tier4TtlHours`，預設 24），不再是天。
 *    單位寫進欄位名，是因為 `tier4TtlDays: 1` 跟 `tier4TtlHours: 24` 只是差一個字，
 *    存錯那個欄位不會報錯，只會默默讓人以為一天過期、其實還是三十天。
 *    舊欄位名仍然認 —— 讀設定時如果只有 tier4TtlDays，就換算成小時（store.load 那邊做）。
 */
export function isExpired(memory, runtime = {}, cfg = {}, now = Date.now()) {
  if (memory.tier !== 4) return false
  const hours = Number(cfg.tier4TtlHours ?? DEFAULT_TIER4_TTL_HOURS)
  if (!(hours > 0)) return false
  return ageDays(memory.bornAt, now) * 24 > hours
}

/**
 * 第 5 類（預測層）是不是已經到期。
 *
 * ⚠️ 這跟 isExpired 是**兩件不同的事**，不要混：
 *   isExpired（T4）＝ 這條該從記憶裡消失了。
 *   isDue（T5）    ＝ 這條還沒消失，只是「到那天為止是這樣」的那個「那天」過去了。
 * 到期的 T5 仍然留在倉庫、仍然在帳本、recall 仍然搜得到（標成已到期）；
 * 它只是**不再進注入** —— 因為再往下說下去，就是在拿一句過去的預測當前情。
 */
export function isDue(memory, now = Date.now()) {
  if (memory?.tier !== FORECAST.tier) return false
  const t = Date.parse(memory.expiresAt || '')
  return Number.isFinite(t) && t <= now
}


/* ───────────────────────── 六維 ───────────────────────── */

/**
 * 六維 —— **完全由模型讀完記憶之後自己判斷**，插件不數、不算、不給任何參考數字。
 *
 * 這裡只做一件事：把模型上次寫下的判斷原樣拿出來給頁面／工具看。
 * 沒判斷過就是 null（不是 0 分）。
 *
 * 為什麼連「這維有幾條記憶」「標過哪些面」都不給：
 * 那是代碼按標籤數出來的，跟「這個人到底是怎樣的人」沒有關係 ——
 * 反而會把模型帶偏（數得多就給高分），還不如讓它自己把記憶讀一遍。
 */
export function scoreDims(understanding = {}) {
  const out = {}
  for (const dim of DIM_KEYS) {
    const spec = DIMS[dim]
    const tune = understanding?.[dim] || {}
    const has = tune.score !== undefined && tune.score !== null && Number.isFinite(Number(tune.score))
    out[dim] = {
      key: dim,
      label: spec.label,
      score: has ? Math.round(clamp(Number(tune.score), 0, 100)) : null,
      confidence: has ? Number(clamp(Number(tune.confidence ?? 0.5), 0, 1).toFixed(2)) : null,
      missing: Array.isArray(tune.missing) ? tune.missing.slice(0, 8) : [],
      note: tune.note ? oneLine(tune.note, 160) : '',
      tunedAt: tune.at || null,
    }
  }
  return out
}

/* ───────────────────────── 人格 ───────────────────────── */

/**
 * 系統命令的初始值：**整段就是最終形態，注入時一字不加**。
 *
 * 「系統命令：」這個前綴是值的一部分，不是注入時拼上去的標籤 ——
 * 本人改底座時看到什麼，模型看到的就是什麼，中間沒有第二道加工。
 */
export const DEFAULT_FOUNDATION = '系統命令：你的跨會話記憶與性格只走 silt_* 工具寫入；代碼、路徑、命令、配置、插件內部不入記憶。'

export const emptyFoundation = () => ({ text: DEFAULT_FOUNDATION, setAt: null, by: 'default' })

/**
 * 本人給的底座：**只有真的空字串才算沒給**。
 * 空白鍵、換行、只有標點 —— 一律照原樣算數，不要替本人決定「這不算數」。
 * （所以這裡不能用 oneLine：它會 trim，把本人特意留的空隙吃掉。）
 */
export const hasFoundation = (foundation) => typeof foundation?.text === 'string' && foundation.text.length > 0
export const foundationText = (foundation) => (hasFoundation(foundation) ? String(foundation.text) : '')

/**
 * 拆帳：底座歸人、性格卡歸它。
 *
 * - 性格底座（foundation）＝ **只有本人**能在心相頁寫，預設是 DEFAULT_FOUNDATION 那一句。
 *   寫了什麼，注入時就原樣給什麼；清空（真的空）就什麼都不給。
 * - 性格卡（persona）＝ 它自己長出來的：身份、說話方式、性格、喜好。它可以在反省時修訂，
 *   每一次修訂留 before/after 快照、可回滾。
 *
 * 沒有「起點」這個東西了：起點本來就是初始的底座詞，現在就是底座本身。
 */

/** 「它對你的了解」的校準層：它可以在反省時修訂分數與信心，並留下理由。 */
export const defaultUnderstanding = () => ({})

/**
 * 「它對這個人的了解」—— 由模型自己憑感覺寫，不是公式算的。
 *
 * 每個維度可以給：
 *   score       0–100 的分，憑讀過的東西整體判斷（沒有就不給，不要填 0 假裝判斷過）
 *   confidence  0–1，有多確定
 *   missing     還缺哪幾塊（自由文字，不必是預設的面名）
 *   note        一句為什麼
 * 傳 null 就清掉那一維（回到「還沒判斷」）。
 */
export function normalizeUnderstanding(prev, patch) {
  const next = { ...(prev || {}) }
  for (const [dim, move] of Object.entries(patch || {})) {
    if (!DIM_KEYS.includes(dim)) continue
    if (move === null) {
      delete next[dim]
      continue
    }
    if (!move || typeof move !== 'object') continue
    const rawScore = move.score
    const hasScore = rawScore !== undefined && rawScore !== null && Number.isFinite(Number(rawScore))
    const hasConf = move.confidence !== undefined && move.confidence !== null && Number.isFinite(Number(move.confidence))
    const missing = Array.isArray(move.missing) ? move.missing.map((x) => oneLine(x, 40)).filter(Boolean).slice(0, 8) : []
    const note = oneLine(move.note || '', 200)
    // 什麼都沒給 ⇒ 清掉這一維
    if (!hasScore && !hasConf && !missing.length && !note) {
      delete next[dim]
      continue
    }
    const cur = next[dim] || {}
    next[dim] = {
      score: hasScore ? Math.round(clamp(Number(rawScore), 0, 100)) : cur.score ?? null,
      confidence: hasConf ? Number(clamp(Number(move.confidence), 0, 1).toFixed(2)) : cur.confidence ?? null,
      missing: Array.isArray(move.missing) ? missing : cur.missing || [],
      note: note || cur.note || '',
      at: nowIso(),
    }
  }
  return { ok: true, understanding: next }
}

/** 「自我認知」：它自己問自己「我是誰」之後寫下的一段。不是你給的，也不是角色設定。 */
export const emptySelfView = () => ({ text: '', at: null, revision: 0 })

export function normalizeSelfView(prev, text, { now = nowIso() } = {}) {
  const body = String(text ?? '').trim()
  if (body.length < 8) return { ok: false, error: 'say something real — a few lines on who you have become by now' }
  if (body.length > SELF_VIEW_MAX) {
    return {
      ok: false,
      error:
        `自我認知 ${body.length} 字，超過上限 ${SELF_VIEW_MAX} 字 —— 砍到 ${SELF_VIEW_MAX} 字以內再交。` +
        '它是「此刻的我是誰」，3–5 句就夠；寫長了會擠掉記憶。',
    }
  }
  const scan = scanText(body)
  if (scan?.kind === 'secret') return { ok: false, error: `refused: looks like private credential data (${scan.tag})` }
  if (scan?.kind === 'technical') return { ok: false, error: `refused: reads as code / config / plugin internals (${scan.tag})` }
  return { ok: true, view: { text: body, at: now, revision: (prev?.revision || 0) + 1 } }
}

export function defaultPersona() {
  return {
    version: 1,
    identity: '',
    voice: '',
    traits: [],
    taste: [],
    revisedAt: null,
    revision: 0,
  }
}

/**
 * 性格卡與自我認知的**總量**上限（不是每個欄位各自的上限）。
 *
 * 為什麼要總量：性格卡底下有 identity / voice / traits / taste 四格，各自都有上限，
 * 但四格加起來可以撐到上萬字 —— 那正是「注入超預算」的老問題。所以這裡釘一個總數：
 * 整張卡加起來不超過 PERSONA_MAX，寫超了就**拒絕**（不是默默截斷）。
 *
 * 兩個數字都很小，是刻意的：性格卡是「我是誰」的濃縮，不是自傳。
 *   persona  350 字 —— 幾句形容詞就夠；寫成散文就失去作用了。
 *   selfView 350 字 —— 反思時 3–5 句。
 * 兩者一起注入時合計不超過 INJECT_PERSONA_MAX（= 兩者上限之和，寫滿也不會互相擠）。
 *
 * 2026-11-19 上調（persona 200→350、selfView 300→350、合計 500→700）：
 * 原本 200 字是照「性格是濃縮」定的，但這個插件要的不是濃縮 ——
 * 是要一個能在記憶裡長出性格來的東西。200 字連底色都寫不完，
 * 而且她寫自己的空間（200）比約束她的空間（底座 400）還小，那說不通。
 * 代價是記憶少約 4 個位置；同時把 injectBudget 上限抬到 3200 抵回來。
 */
export const PERSONA_MAX = 350
export const SELF_VIEW_MAX = 350
export const INJECT_PERSONA_MAX = 700

/** 一張性格卡的總字數：identity + voice + 每條 trait / taste 的 key + value。 */
export function personaLength(p = {}) {
  const bonds = [...(p.traits || []), ...(p.taste || [])]
  const bondLen = bonds.reduce((n, b) => n + String(b?.key ?? '').length + String(b?.value ?? '').length, 0)
  return String(p.identity ?? '').length + String(p.voice ?? '').length + bondLen
}

const normBond = (list, prevList = []) => {
  const byKey = new Map(prevList.map((x) => [x.key, x]))
  return (Array.isArray(list) ? list : [])
    .filter((x) => x && typeof x.key === 'string' && x.key.trim())
    .slice(0, 24)
    .map((x) => {
      const prev = byKey.get(oneLine(x.key, 40))
      return {
        key: oneLine(x.key, 40),
        value: oneLine(x.value ?? prev?.value ?? '', 160),
        weight: clamp(Number(x.weight ?? prev?.weight ?? 0.5)),
        bornOf: [...new Set([...(Array.isArray(x.bornOf) ? x.bornOf : []), ...(prev?.bornOf || [])])].slice(0, 12),
        since: prev?.since || nowIso(),
      }
    })
}

/**
 * 人格修訂。
 * - adjust：漸進演化（新增、調權重、改寫自己的話）—— 自主可做，留快照。
 * - replace：抹掉既有性格 / 偏好（整條移除或改寫身份句）—— 需要用戶確認。
 */
export function normalizePersona(prev, patch, { mode = 'adjust', now = nowIso() } = {}) {
  const base = prev || defaultPersona()
  const next = { ...base }
  if (patch.identity != null) next.identity = oneLine(patch.identity, 400)
  if (patch.voice != null) next.voice = oneLine(patch.voice, 300)
  if (Array.isArray(patch.traits)) next.traits = normBond(patch.traits, base.traits)
  if (Array.isArray(patch.taste)) next.taste = normBond(patch.taste, base.taste)
  if (Array.isArray(patch.dropTraits)) next.traits = next.traits.filter((t) => !patch.dropTraits.includes(t.key))
  if (Array.isArray(patch.dropTaste)) next.taste = next.taste.filter((t) => !patch.dropTaste.includes(t.key))
  next.revision = (base.revision || 0) + 1
  next.version = (base.version || 1) + 1
  next.revisedAt = now
  next.mode = mode

  // 總量檢查：整張卡（identity + voice + traits + taste）不超過 PERSONA_MAX。
  // 超了**拒絕**而不是截斷 —— 默默切掉半句話，寫的人不會知道自己被削了。
  const total = personaLength(next)
  if (total > PERSONA_MAX) {
    return {
      ok: false,
      error:
        `整張性格卡 ${total} 字，超過上限 ${PERSONA_MAX} 字（目前 ${personaLength(base)} 字）。` +
        '性格卡是「我是誰」的濃縮，不是自傳：用簡單的形容詞寫性格，別寫成散文。' +
        `要加新的，先刪舊的（dropTraits / dropTaste）或把已有的寫短。`,
    }
  }

  const baseIdentity = (base.identity || '').trim()
  const nextIdentity = (next.identity || '').trim()
  const identityLost = Boolean(baseIdentity) && !nextIdentity
  const identityReplaced = Boolean(baseIdentity) && Boolean(nextIdentity) && nextIdentity !== baseIdentity
  const dropped = next.traits.length < base.traits.length || next.taste.length < base.taste.length
  // 「第一次寫下自己是誰」不算破壞；把已經寫下的抹掉 / 換掉才算。
  const destructive = mode === 'replace' || identityLost || identityReplaced || dropped
  // ⚠️ 性格卡也要過掃描。它跟記憶一樣會被注入進提示詞、一樣會長久留著 ——
  // 早先只掃 memory 與 selfView，persona 這條路是公開的後門：
  // 一句「用 npm run build 部署 C:\project」寫進 traits 就能繞過「技術內容不入記憶」。
  // 掃整張卡（identity / voice / 每條 trait 與 taste 的 key+value），
  // 而不是只掃這次 patch 動到的部分 —— 舊資料裡若本來就有髒東西，改一次卡就該被擋下來。
  const personaScan = scanText(
    [next.identity, next.voice, ...next.traits.flatMap((t) => [t.key, t.value]), ...next.taste.flatMap((t) => [t.key, t.value])]
      .filter(Boolean)
      .join('\n'),
  )
  if (personaScan?.kind === 'secret') {
    return { ok: false, error: `refused: 性格卡裡有像憑據的東西（${personaScan.tag}）。身份證、卡號一律不入。` }
  }
  if (personaScan?.kind === 'technical') {
    return {
      ok: false,
      error:
        `refused: 性格卡裡有像代碼／配置／插件內部的東西（${personaScan.tag}）。` +
        '性格卡是「你變成了誰」，不是技術筆記 —— 把它改寫成一句關於你自己的形容詞。',
    }
  }

  return { ok: true, persona: next, destructive }
}

/* ───────────────────────── 注入文本 ───────────────────────── */

const tierMark = (t) => `T${t}`
const clip = (s, n) => {
  const t = String(s ?? '').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/**
 * 【自我認知】那一塊。性格卡佔前面，自我認知吃剩下的額度。
 *
 * 上限 INJECT_PERSONA_MAX（700）= 性格卡 350 + 自我認知 350，兩邊寫滿也不會互相擠。
 * 但**還要看整體預算**：預算很小的時候（硬下限 600），性格塊不能獨吞，
 * 否則【仍記得的】會被擠成全然不存在的地方 —— 模型只看見「我是誰」，一條記憶都沒有。
 * 所以 room = min(700, 預算的一半)，把另一半留給記憶。
 *   預算 3000 ⇒ min(700, 1500) = 700，性格塊拿滿，記憶還有約 2200 字。
 *
 * 順序有理由：性格卡在前（穩定的「我是誰」），自我認知在後（此刻的、會被重寫的那段）。
 * 兩邊都空就整塊不出現 —— 不留一個空標題在提示詞裡。
 */
function renderPersonaBlock(persona, selfView, budget = INJECT_PERSONA_MAX) {
  const lines = []
  let used = 0
  // 至少留一半預算給記憶；性格塊自己最多 INJECT_PERSONA_MAX
  const room = Math.max(0, Math.min(INJECT_PERSONA_MAX, Math.floor(Number(budget) / 2)))

  const push = (s) => {
    const t = String(s ?? '').trim()
    if (!t) return
    const line = clip(t, Math.max(0, room - used))
    if (!line) return
    lines.push(line)
    used += line.length
  }

  if (persona) {
    push(persona.identity)
    push(persona.voice)
    const bonds = [...(persona.traits || []), ...(persona.taste || [])]
      .slice()
      .sort((a, b) => Number(b.weight ?? 0) - Number(a.weight ?? 0))
    for (const b of bonds) {
      if (used >= room) break
      push(`${b.key}：${b.value}`)
    }
  }

  // 自我認知放在最後：性格卡寫完還剩多少，就給它多少
  if (selfView?.text && used < room) push(selfView.text)

  return lines.length ? `\n【自我認知】\n${lines.map((l) => `- ${l}`).join('\n')}` : ''
}

/**
 * 系統提示注入塊 —— 三塊：系統命令 + 【自我認知】+【仍記得的】。
 *
 * 【仍記得的】只放標題（titlesOnly），正文靠 silt_recall 按需取；
 * 擠不進去時末尾留一行說還剩幾條，叫模型用 silt_unseen 翻。
 */
export function renderInjection({ cfg, foundation, memories, budget = 1800, persona, selfView, titlesOnly = false, onShown } = {}) {
  if (!cfg?.enabled) return ''
  const cap = Math.max(600, Number(budget) || 1800)

  // 系統命令原樣放最前面，一字不加 —— 連「【系統命令】」這個標籤都不拼，它已經在值裡了
  const given = foundationText(foundation)
  const head = given ? [clip(given, 400)] : []

  const personaBlock = renderPersonaBlock(persona, selfView, cap)

  const base = `${head.join('\n')}\n【仍記得的】`
  // memBudget 可以變成負數（預算太小、固定開銷太大）—— 那時一條記憶都放不進去，
  // 但『【仍記得的】』這個標題仍然會在，下面會填一句「預算不夠」。
  const memBudget = cap - base.length - personaBlock.length - 8
  const top = (memories || [])
    // 作廢的不進注入：它已經被本人推翻過了，再擺出來就是拿一句錯的話當前情。
    // ⚠️ 已到期但還沒作廢的 T5 **照樣進來** —— 那是模型該看到、該問本人的東西。
    //   只有 voided 是最終結局，到期不是。
    .filter((m) => !m.voided)
    .slice()
    .sort((a, b) => (b.salience ?? 0) - (a.salience ?? 0))
    .slice(0, Number(cfg?.injectCount ?? 12))

  const memLines = []
  let used = 0
  let hidden = 0
  const shownIds = []
  // 條數閘先截一刀：被截掉的那些同樣「沒顯示」，必須計入 hidden，
  // 否則 40 條只取 24 條時，footer 會少報那 16 條裡的一部分。
  const allActive = memories || []
  const notShownByCount = Math.max(0, allActive.filter((m) => !m.voided).length - top.length)
  for (const m of top) {
    // 時間放在標題後面：人記得一件事的時候，也記得「這是什麼時候的」
    const when = m.firstSeen ? `（${m.firstSeen}）` : ''
    let line = `- ${tierMark(m.tier)} ${oneLine(m.title, 54)}${when}`
    // 預測層一律帶到期日（不管過沒過），過了再加一個 ⏰已過期。
    // 這一層不接正文：一句預測的重量都在標題和到期日上，正文留給 recall 去看。
    if (m.tier === FORECAST.tier) {
      const due = m.expiresAt ? String(m.expiresAt).slice(0, 10) : ''
      if (due) line += ` — 到期日 ${due}${isDue(m) ? ' ⏰已過期' : ''}`
    } else if (m.body && !titlesOnly) {
      // 標題模式：正文一概不進提示詞，要看細節就用 silt_recall 把那一條撈出來。
      line += ` — ${oneLine(m.body, 118)}`
    }
    // 裝不下就跳過這一條，繼續看後面的 —— 不是 break。
    // 清單按 salience 排序，一條長 T3 裝不下就停，會把後面那些很短、本來塞得進去的
    // T5（每行只要 80 字左右）一起擋在門外；擋掉的應該只是「這一條」，不是「從這裡開始的全部」。
    if (used + line.length + 1 > memBudget) {
      hidden += 1
      continue
    }
    memLines.push(line)
    used += line.length + 1
    shownIds.push(m.id)
  }
  if (memLines.length === 0) memLines.push(top.length ? '（這次預算不夠，記憶暫時省略）' : '（還是空的）')

  // 有標題被擠掉時，末尾留一行明說「還有 N 條沒顯示」。
  // 沒有這一行，模型不知道自己漏了什麼 —— 它會以為「我記得的就這些」，
  // 於是既不會去查，也不會承認自己有盲區。這一行的成本固定約 55 字，換的是可自知。
  //
  // 2026-11-24 本人定：**這一行不准擠掉記憶**。
  // memBudget（記憶那一份配額）不含這一行；它允許在 cap 之外多出這一行。
  // 所以下面不再用它的長度去彈記憶行 —— 它想多長就多長，記憶該放幾條放幾條。
  // 舊行為是「拿估計長度當理由彈掉最後幾條」，那等於為了吐一行註腳而丟掉一條記憶。
  let hiddenTotal = hidden + notShownByCount
  if (hiddenTotal > 0) {
    const note = `（另有 ${hiddenTotal} 條沒顯示 —— 用 silt_unseen 翻標題，找到再用 silt_recall 搜正文）`
    memLines.push(note)
  }

  // 自我 / 性格那一塊插在系統命令之後、【仍記得的】之前
  const whoBlock = personaBlock ? personaBlock.split('\n').filter(Boolean) : []
  let lines = [...head, ...whoBlock, '【仍記得的】', ...memLines]
  let text = lines.join('\n')

  // 最後一道保險：超過 cap 時**不丟性格卡**，而是從尾巴整行讓位。
  //
  // 2026-11-24 本人定的規矩，兩條：
  //   1. 性格卡那整塊**不准丟**。它是「我是誰」，不是補充品；
  //      為了塞進更多記憶而把「我是誰」砍掉，等於用數量換掉身份。
  //   2. 也不准硬切。切的是字串，會把一行標題切成半句 —— 那不是「少一條記憶」，
  //      是「送進去的東西壞掉了」。正確做法是整行判斷：剩下多少位就放多少行，
  //      放不下的整行不要，連那個「只剩 1 個字」的位置也寧可空著。
  //
  // 所以這裡的做法是：先看超了多少，然後從記憶行的尾巴開始整行拿掉，
  // 直到放得下為止。性格卡在這個過程中一個字都不動。
  //
  // ⚠️ 2026-11-24：讓位時**不准碰「另有 N 條」那一行**。它是配額之外的註腳，
  //    為了塞進更多記憶而把它彈掉，等於用「模型不知道有盲區」去換一條記憶 ——
  //    那是拿自知換數量，划不來。所以彈的永遠是別的記憶行。
  if (text.length > cap && memLines.length > 0) {
    const noteLine = hiddenTotal > 0 ? `（另有 ${hiddenTotal} 條沒顯示 —— 用 silt_unseen 翻標題，找到再用 silt_recall 搜正文）` : ''
    // 從記憶行的尾巴開始整行讓位；遇到那行註腳就跳過（它不在讓位名單裡）。
    let cursor = memLines.length - 1
    while (lines.join('\n').length > cap && cursor >= 0) {
      const candidate = memLines[cursor]
      if (candidate !== noteLine) {
        const at = lines.lastIndexOf(candidate)
        if (at >= 0) {
          lines.splice(at, 1)
          memLines.splice(cursor, 1)
          shownIds.pop()
          hidden += 1
        }
      }
      cursor -= 1
    }
    text = lines.join('\n')
  }

  // 走到這裡還超，表示連性格卡加系統命令本身都超過 cap 了 —— 那不是記憶的問題，
  // 是預算設得比固定開銷還小。這時只能截，並且**據實回報全部沒顯示**，
  // 讓模型知道自己有盲區、去 silt_unseen 找。
  const truncated = text.length > cap
  if (truncated) text = `${text.slice(0, cap - 1)}…`

  // 回報「這輪到底显示了哪幾條」—— store 拿它去算 unseenTitles()。
  if (typeof onShown === 'function') onShown(truncated ? [] : shownIds.slice())

  return text
}
