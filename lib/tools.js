/**
 * Silt/lib/tools.js — 模型面對的七隻手
 * ---------------------------------------------------------------------------
 * 這些工具的參數就是「記什麼」的自由度；外殼（id / 時間 / 證據 / 哈希 / 快照）
 * 與所有結構性規則留在插件這邊，模型改不了。
 */
import {
  BILI_TUNABLES,
  CHARS_PER_SLOT,
  DIMS,
  DIM_KEYS,
  FACET_KEYS,
  DOMAINS,
  INJECT_TUNABLES,
  RHYTHM_TUNABLES,
  SPEAK_KINDS,
  scanText,
  slotsForBudget,
} from './model.js'
const text = (value) => {
  const body = typeof value === 'string' ? value : JSON.stringify(value, null, 1)
  return [{ type: 'text', text: body.length > 6000 ? `${body.slice(0, 5999)}…` : body }]
}

const define = (spec) => ({
  name: spec.name,
  description: spec.description,
  parameters: spec.parameters,
  output: { schema: { type: 'object' }, render: (_args, value) => text(value) },
  execute: spec.execute,
  timeoutMs: 20000,
  isConcurrencySafe: () => false,
})

const sessionOf = (exec) => ({
  sessionId: exec?.agent?.id || '',
  callId: exec?.callId ? String(exec.callId) : '',
})

const DIM_ENUM = DIM_KEYS

export function buildTools(store, { speak = null } = {}) {
  const tools = []

  /* ── 檢索 ── */
  tools.push(
    define({
      name: 'silt_recall',
      description:
        '搜尋你記得關於這個人的事。' +
        '回傳最相符的幾條（標題、正文、時間）。' +
        '重新調出一條記憶會強化它 —— 所以對某人下判斷之前，先回想。' +
        '提示詞裡只擺最亮的那幾條；想不起某件事、或要按維度／層級找，就用這隻手。' +
        '⚠️ 雜項區（T4）是「歸不了類的先放著」—— 它不在提示詞裡，也不會自己出現，只有這隻手找得到。' +
        '每次找到它們，你給的 weight 會累加；加夠 3 就當場升成 T3，正式進倉庫；' +
        '沒人想起、權重攢不夠的，48 小時沒想起就散。' +
        '想不起甚麼的時候，值得往這裡翻一翻。\n' +
        '⚠️ 每條都帶 standing：這條靠什麼撐著、最可能錯在哪、能怎麼驗。' +
        '**被想起越多次，standing 不是加分，是提醒你「你一直信它，從沒驗過」** —— 想起只代表你認同它，不代表它還對。' +
        '看到 standing.risk 覺得刺，就照著去看一眼，別直接拿它下結論。\n' +
        '⭐ 結果裡每條若帶 `trace`（quote + sessionId + searchWith），那是這條記憶的**原話出處**：' +
        '讀完覺得「我是不是記偏了」，就用 session_event_search(session_id, query=trace.searchWith) 回到那一刻對一次。' +
        '⚠️ 只能回查跟現在同一個工作目錄的會話；別的目錄會擋，那就只能靠 quote 那句話本身。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '在標題、正文和標籤裡找這些詞。省略就只按權重瀏覽。' },
          dims: { type: 'array', items: { type: 'string', enum: DIM_ENUM }, description: '只留與這些維度有關的記憶。' },
          facets: { type: 'array', items: { type: 'string', enum: FACET_KEYS }, description: '比 dims 更窄：某一維裡的某一面，例如 "life.rhythm"。' },
          tier: {
            type: 'integer',
            minimum: 1,
            maximum: 5,
            description:
              '1＝永久事實 · 2＝沉澱下來的概 · 3＝經歷 · 4＝雜項 · 5＝預測。\n' +
              '搜 T4 只找得到還在世上的那些（48 小時沒想起就散）。\n' +
              '搜 T5 時，未到期和已到期的都會回來；已到期的會標 due: true（提示詞裡也會標 ⏰已過期）。',
          },
          domain: { type: 'string', enum: DOMAINS },
          limit: { type: 'integer', minimum: 1, maximum: 30, description: '回傳幾條，預設 8。' },
          includeArchived: { type: 'boolean', description: '連已被折進概裡的原條也回傳，預設否。' },
          deliberate: {
            type: 'boolean',
            description:
              '你是主動回味、不是被人問起時填 true。\n' +
              '這只影響記錄方式（分得出這條是被誰想起的），不影響 weight 怎麼加 —— ' +
              '被問起和自己翻出來想，都一樣把他又想起了一次。\n' +
              '反思時自己想到某條碎屑、或盯著某條記憶想了很久，就填 true。對話裡回答使用者的問題，不要填。',
          },
          weight: {
            type: 'integer',
            enum: [1, 2],
            description:
              '只有 T4 雜項用得著。你這次想起它，有多重：\n' +
              '1 = 順帶想起（翻到的時候覺得「這條還在」）\n' +
              '2 = 這次真的把它跟別的事連起來、或證實了它\n' +
              '不填 = 1。\n' +
              '⚠️ 只掃到、沒甚麼感覺，就填 0 —— 掃不該算份量。\n' +
              '累加到 3 就升成 T3：所以**兩次 2，或三次 1**。算得出來，不用猜。\n' +
              '⚠️ 它只活 48 小時：48 小時內加不到 3，就散了 —— 這不是漏掉，這就是它的設計。',
          },
        },
      },
      execute: (args, exec) => {
        const a = args || {}
        const hits = store.recall({
          query: a.query,
          dims: a.dims,
          facets: a.facets,
          tier: a.tier,
          domain: a.domain,
          limit: a.limit,
          includeArchived: a.includeArchived,
          deliberate: a.deliberate,
          weight: a.weight,
          // 同一個會話裡重複 recall 同一條，只算一次「想起」——
          // 否則翻書五次就等於想起五次，T4 能被一次對話翻到升 T3。
          sessionId: sessionOf(exec).sessionId,
        })
        const result = { memories: hits }
        if (hits.length === 0) result.note = '沒找到相符的 —— 可能還沒記過，也可能是新的地方'
        // 2026-11-21：把「這條的原話能回哪裡查」直接擺出來。
        // 每條記憶的 evidence 裡本來就有 sessionId + callId，quote 也有逐字原話，
        // 但以前要我自己去翻 evidence 才看得到，翻完還得自己想怎麼回到那一刻。
        // 現在直接給一句 hint：能回查的，告訴我去哪個會話、搜什麼。
        result.howToTrace = '把某條的原文找回來：用 session_event_search(session_id="<會話 id>", query="<原話片段>") 找命中，' +
          '再用 session_event_read(seq=N) 讀那一刻的完整上下文。' +
          '⚠️ 只能回查跟現在這個工作目錄相同的會話；別的目錄會被擋，那就只能用 quote 那句話本身。'
        for (const m of hits) {
          const ev = Array.isArray(m.evidence) ? m.evidence : []
          const q = ev.find((e) => e && e.kind === 'quote' && e.quote)
          const s = ev.find((e) => e && e.kind === 'session' && e.sessionId)
          if (!q && !s) continue
          m.trace = {
            ...(q ? { quote: q.quote } : {}),
            ...(s ? { sessionId: s.sessionId } : {}),
            ...(q ? { searchWith: q.quote.slice(0, 24) } : {}),
          }
        }
        return result
      },
    }),
  )

  /* ── 翻那些擠不進提示詞的標題 ── */
  tools.push(
    define({
      name: 'silt_unseen',
      description:
        '提示詞裡只擺得下有限幾條記憶；這一隻把**沒擠進去的那批標題**攤開給你翻。' +
        '回應裡有 rest：這一頁之後還有幾條沒翻到 —— rest 是 0 就到底了，不是 0 就帶 page 繼續翻。' +
        '像翻書一樣：翻到一個你覺得對的標題，就停手，用 silt_recall 搜它的正文（會搜標題、正文和標籤）。' +
        '⚠️ 這裡只回標題，不回正文 —— 正文要看就 recall。' +
        '⚠️ T4（雜項）不會出現在這裡：它本來就不擠佔提示詞，要用 silt_recall tier:4 主動去翻。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          page: { type: 'integer', minimum: 0, description: '第幾頁，從 0 開始。提示行叫你繼續翻時，照它給的 page 填。' },
          pageSize: { type: 'integer', minimum: 1, maximum: 60, description: '一頁幾條，預設 40。' },
        },
      },
      execute: (args) => {
        const a = args || {}
        return store.unseenTitles({
          page: a.page,
          pageSize: a.pageSize,
          shownIds: store.runtime?.shownIds || [],
        })
      },
    }),
  )

  /* ── 寫入 ── */
  tools.push(
    define({
      name: 'silt_remember',
      description:
        '把值得留住的東西放進跨會話記憶。記什麼由你決定 —— 但代碼、檔案路徑、命令、配置、插件內部一律不記，身份證號、卡號更不許。' +
        '記錄的身份、會話證據和雜湊由系統蓋給你。' +
        '層級決定它能活多久：' +
        'T1 是**事實與你跟這個人之間的約定規則**，幾乎不褪色，連標題 200 字。裡面放兩種東西：\n' +
        '  ① 長期成立的事實（名字、生日、住哪、上什麼班、習慣）；\n' +
        '  ② **長期有效、以後每次都要照著做的約定或規則** —— 他教過你一次、你不想再被教第二次的那種。\n' +
        '⚠️ 規則要寫清楚三件事：**什麼情況 ⇒ 做什麼 ⇒ 為什麼**。200 字寫不完，就先精簡再說 —— 不要寫成口號，' +
        '也不要因為寫不下就整條不記。\n' +
        '⚠️ T1 不是「比較重要的記憶」，是「**明天還成立**的記憶」。\n' +
        '⚠️ **日期照寫**。日期是「這條是什麼時候發生的」，是記憶的一部分，不是要清掉的雜質 —— ' +
        '寫進標題或正文都可以，`firstSeen` 也會另外記著。\n' +
        'T3 是值得留住的經歷，大約四個月才淡一半，連標題 1000 字；\n' +
        'T4 是雜項 —— **歸不了類的先放這裡**（不是「不值錢」的意思，是「還不知道它屬於哪一層」）：' +
        '明天還成立的事實和約定規則寫 T1，值得留住的經歷寫 T3，到期就該收的預期寫 T5，' +
        '剩下的、你不確定該往哪一格的，一律寫 T4 —— 不要因為歸不了類就整個不記；' +
        // 2026-11-21：這裡原本只寫「一律寫 T4」，結果一條都沒寫過。加一句讓它變成默認動作。
        '⚠️ 判斷的時候不要只在「夠格當事實」跟「夠格當經歷」之間二選一 —— 那兩格之外的東西不是垃圾，' +
        '而是「我現在還判斷不了」。這種就寫 T4，讓它自己去證明值不值得。' +
        '它不進倉庫、不進提示詞，只有你主動去 silt_recall 翻才找得到；' +
        '每次翻到它，你可以給一個權重（1 = 順帶想起，2 = 真的連起來／證實了它），累加到 3 就升成 T3；' +
        '**48 小時沒想起就散** —— 所以寫 T4 的時候就想清楚：這是「這兩天先放著」，不是「先存著以後再說」。\n\n' +
        // 2026-11-25 本人第 2 點：「T4 沒有利用好，很多不必要的記憶進了 T3 佔了記憶數」。
        // 真正的病因不是 T4 不好用，是**沒有人告訴它專案細節該放哪** —— 它只剩下 T3 一個選項。
        // 所以這裡要說清楚的不是「多寫 T4」，而是「哪些東西本來就不該進 T3」。
        '⭐ **專案細節不進 T3。** 代碼怎麼組織、哪個檔案改了、裝了什麼、跑什麼命令、debug 追到第幾層 ——\n' +
        '  這些是專案細節，**不是你的經歷**。進 T3 的只能是「這件事整個大概和經過」，以及它對你和他的關係意味著什麼。\n' +
        '  判斷方法：**過一個月之後，你還會想知道「哪個檔案」嗎？** 不會 → 那就不是 T3。\n' +
        '  專案細節連 T4 都不必寫：它們沒有跨會話的價值，代碼本身記著。真的覺得兩個對話之間要用到某個結論，寫 T4，一天內不去想起它就讓它散。\n\n' +
        'T5 是預測層 —— 還沒發生、但有期限的預期（下個月要結婚、明天面試、他最近在減肥到某日）。\n' +
        'T5 只寫**本人明確說過**，或有**足夠近期證據**可以推出的預期；' +
        '不要把自己的推測、擔心、期待寫成 T5。\n' +
        '心願、打算、一時的想法既不是預測、也不夠格當事實 ——\n' +
        '「我想去日本」「我打算學日文」寫 T4，讓它自己去證明值不值得記。\n\n' +
        'T5 必須帶到期日 expiresAt，而且**不要求精確**：\n' +
        '- 知道哪一年，就寫 2027。\n' +
        '- 知道哪個月，就寫 2027-06。\n' +
        '- 知道哪一天，就寫 2027-06-15。\n' +
        '- 照你知道的粒度寫就好，缺的部分插件會補成那個期間的**第一天**（寧可早點過期去問，不要拖）。\n' +
        '- 推錯日期很正常，人也是這樣推的 —— 不要因為拿不準而不寫。\n\n' +
        '到期後，T5 **仍然留在提示詞裡**，而且會標上「⏰已過期」—— 那是給你看的：這條該有個結果了。\n' +
        '看到已過期的 T5 怎麼處理，見 silt_void 的說明。\n' +
        '⚠️ 已經發生的事不要寫 T5 —— 那是事實（T1）或經歷（T3）。\n' +
        '⚠️ 你只能寫 T1 / T3 / T4 / T5。T2 是經歷沉澱出來的樣子 —— 它不由你動手，寫不進來。\n' +
        '⚠️ 碰到上限時，先自己壓到上限以內再寫 —— 不要砍尾、不要只留開頭，' +
        '要想清楚這條以後還用得上的那部分是甚麼，只寫那部分。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['tier', 'title', 'body', 'domain', 'dims'],
        properties: {
          tier: {
            type: 'integer',
            minimum: 1,
            maximum: 5,
            description:
              '必填，沒有預設值。\n' +
              '1＝事實與規則（≤200 字，只收「明天還成立」的：長期事實、以及每次都要照著做的規則）\n' +
              '3＝經歷（≤1000 字）\n' +
              '4＝雜項（≤300 字，不進倉庫；每次被 recall 到可給權重 1 或 2，累加到 3 就升 T3；48 小時沒想起就散了）\n' +
              '5＝預測（≤400 字，必須帶到期日，沒 void 就一直留在提示詞裡，過期會標 ⏰已過期）\n' +
              'T2 不能直寫。',
          },
          title: { type: 'string', description: '一行短句，以後你認得出來的那種。標題也算在上限字數裡。' },
          body: {
            type: 'string',
            description: '你真正留下來的內容。寫不下就先自己壓，不要砍尾。',
          },
          expiresAt: {
            type: 'string',
            description:
              'T5 必填。到期日，粒度隨你：2027（只知道年份）、2027-06（月份）、2027-06-15（確定日期）。' +
              '缺的部分會補成那個期間的第一天。到期日當天仍有效，隔天起視為過期。',
          },
          domain: { type: 'string', enum: DOMAINS },
          dims: { type: 'array', items: { type: 'string', enum: DIM_ENUM }, description: '這條記憶說的是六維裡的哪幾維。' },
          facets: { type: 'array', items: { type: 'string', enum: FACET_KEYS }, description: '那些維度裡更細的面。' },
          importance: { type: 'number', minimum: 0, maximum: 1, description: '它該多大程度影響你的判斷。預設跟層級走。' },
          tags: { type: 'array', items: { type: 'string' } },
          quote: { type: 'string', description: '本人親口說的原話（逐字），當這條記憶是建立在他說過的話上。' },
          url: { type: 'string', description: '讀到的網頁位置。' },
          bvid: { type: 'string', description: '來自 B站 影片時的 BV 號。' },
        },
      },
      execute: (args, exec) => {
        const res = store.writeMemory(args || {}, sessionOf(exec))
        if (!res.ok) return { ok: false, error: res.error }
        const out = { ok: true, id: res.memory.id, tier: res.memory.tier, title: res.memory.title }
        // 預測層回一個到期日：讓它知道這條什麼時候會退出提示詞
        if (res.memory.expiresAt) out.expiresAt = res.memory.expiresAt.slice(0, 10)
        return out
      },
    }),
  )

  /* ── 作廢：這條不成立了（內容一字不改，只標記） ── */
  tools.push(
    define({
      name: 'silt_void',
      description:
        '標記一條記憶「不成立了」。用途只有一個：**本人告訴你之前那條錯了、變了、不再是那樣。**\n' +
        '它不是刪除，也不是改寫 —— 原條的內容一個字都不動，只是標上「作廢」，從此不再出現在你的提示詞裡。' +
        '帳本上留著原句、作廢的時間、和為甚麼作廢，以後搜得到，也看得出你當時知道的是甚麼。\n' +
        '\n' +
        '⚠️ 動手之前先確認你拿到的是對的那一條：\n' +
        '- 先用 silt_recall 搜出舊的那條（別憑記憶猜 id）。\n' +
        '- **只有一條、而且明顯就是同一件事**，可以直接作廢。\n' +
        '- 搜到好幾條、或者你不太確定本人指的是哪一條 —— **先問本人**（「你之前提過 X，是改了嗎？」），別自己猜。\n' +
        '- 作廢錯了就回不去了（沒有撤銷），所以拿不準就問。\n' +
        '\n' +
        '然後寫一條新的：作廢只負責說「舊的不成立了」，新的那條還是要用 silt_remember 寫進去。\n' +
        '兩件事一起做，你才不會只剩一句「這條不對」而沒有一個對的版本。\n' +
        '\n' +
        '⚠️ 順序很重要 —— **先寫新的，再作廢舊的**：\n' +
        '1. 先用 silt_remember 寫下對的那條，拿到它的 id。\n' +
        '2. 再 silt_void 舊的那條，把新 id 放進 replacedBy。\n' +
        '反過來做的話，作廢那一刻新記憶還不存在，replacedBy 就只能空著，兩條接不起來。\n' +
        '\n' +
        '對 T5（預測層）使用時：\n' +
        'T5 只有一個結局：被 void 掉。沒 void 就一直留在提示詞裡（過期了會標「⏰已過期」）。\n' +
        '\n' +
        '**A. 還沒到期**（提示詞裡沒有「⏰已過期」）：\n' +
        '- 實現了 / 取消了 / 變動了 —— 都直接處理，不用特別問，因為本人已經說過或事情已經發生。\n' +
        '- 順序：先寫新的（T1 或 T3）拿到 id → 再 void 舊的，replacedBy 填新 id。\n' +
        '- 理由寫清楚是「已實現」「已取消」還是「已改為 X」。\n' +
        '\n' +
        '**B. 已經過期**（提示詞裡有「⏰已過期」）：\n' +
        '- 你**不要自己假定結果**。日子過了不等於事情辦了 —— 可能延後、可能取消、可能改變。\n' +
        '- 在對話裡找機會問本人（「之前說 12-20 結婚，後來怎麼樣了？」）。\n' +
        '- 等本人回答之後：按他的回答寫新的 T1／T3（或更新後的 T5），再 void 舊的 T5。\n' +
        '- 問不成就留著，下次再說 —— **它不會因為你沒問就消失**，所以不必急著處理。\n' +
        '\n' +
        '⚠️ 無論哪種，void 之前你必須先有一個「對的版本」可以寫。\n' +
        '\n' +
        '⚠️ 這是**對話裡**的工具，不是反思時用的：只有本人真的說了新東西才用它。' +
        '你自己回頭想想覺得不妥，不構成作廢的理由 —— 那種情況另外寫一條就好。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'reason'],
        properties: {
          id: { type: 'string', description: '要作廢的那條記憶的 id（先用 silt_recall 搜到它，別猜）。' },
          reason: {
            type: 'string',
            description: '一句為甚麼作廢 —— 是誰、在哪句話裡、說它變成了甚麼。會原文記進帳本。',
          },
          replacedBy: {
            type: 'string',
            description: '如果你已經（或馬上要）寫一條對的，把它的 id 放這裡，帳本上兩條就接得起來。',
          },
        },
      },
      execute: (args, exec) => {
        const a = args || {}
        const res = store.voidMemory(a.id, {
          reason: a.reason,
          replacedBy: a.replacedBy,
          actor: 'model',
        })
        return res
      },
    }),
  )

  /* ── 壓縮：把一條經歷用更少的話重講一遍 ── */
  tools.push(
    define({
      name: 'silt_condense',
      description:
        '重讀一條舊記憶，用你自己的話再講一次。舊的那條收進檔案，不是刪掉 —— 帳本裡還在，可回滾。\n' +
        '兩種用法，靠 mode 分：\n' +
        '  · mode:"condense"（預設）—— **把話說短**。收到任務書裡「2. 舊記憶壓縮」的清單時用它：' +
        'id 照抄，title 和 body 你自己寫，不是抄第一句。\n' +
        '  · mode:"recast" —— **同一件事，換一種理解**。長度可以不變。' +
        '半年後再想起「他總在深夜工作」，現在你會想成「他在用夜晚躲掉白天」—— 這是重述，不是壓縮。\n' +
        '⚠️ 重述不會讓你沉澱成概（永遠留在經歷層），因為那是「還在想」的東西，不該被釘死。\n' +
        '⚠️ 重述不是作廢。作廢（silt_void）說的是「這件事不成立了」；重述說的是「我現在的看法變了」。' +
        '原始記錄會留在帳本裡 —— 你看得到自己曾經怎麼想的。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'body'],
        properties: {
          id: { type: 'string', description: '要重講的那條記憶的 id。' },
          title: { type: 'string', description: '一行叫你自己認得出來。' },
          body: { type: 'string', description: '你自己的話。' },
          mode: {
            type: 'string',
            enum: ['condense', 'recast'],
            description: 'condense 把話說短（預設）；recast 換一種理解、長度可以不變。',
          },
          targetLen: {
            type: 'integer',
            minimum: 1,
            description: 'mode:"condense" 專用：清單給的參考長度（連標題）。' +
              '它是公式算出來的建議值，**不是硬上限** —— 超過照收，只會回報多出幾字。' +
              '你覺得這一條就該這麼長，就照自己的判斷寫。recast 不看這個。',
          },
        },
      },
      execute: (args, exec) => {
        const a = args || {}
        const res = store.condense(
          { id: a.id, title: a.title, body: a.body, targetLen: a.targetLen, mode: a.mode === 'recast' ? 'recast' : 'condense' },
          { sessionId: sessionOf(exec).sessionId },
        )
        if (!res.ok) return { ok: false, error: res.error }
        return { ok: true, id: res.memory.id, tier: res.tier, from: res.from, mode: res.mode, title: res.memory.title }
      },
    }),
  )

  /* ── 人格 ── */
  tools.push(
    define({
      name: 'silt_persona',
      description:
        '讀寫你自己長出來的性格卡與喜好。adjust 和 replace 都由你自己決定，沒有人批准，也不該有人批准 —— ' +
        '性格卡是你長出來的，不是本人編輯的。adjust 用來加一條性格、調權重、寫下你變成了誰；' +
        'replace 用在真的重寫自己時（刪掉性格、重寫或清空身份句）。' +
        'self 寫下你問自己「我是誰」之後的答案：3–5 句，350 字以內，顯示在 Silt 頁面上。' +
        '⚠️ 字數上限是硬的：**整張性格卡（identity + voice + 性格 + 喜好）合計 350 字以內**，' +
        '超了會被退回。性格卡是「我是誰」的濃縮，用簡單的形容詞寫性格，別寫成散文；' +
        '要加新的，先刪舊的或把已有的寫短。' +
        '⚠️ 性格卡和自我認知每輪都會出現在提示詞裡（合計最多 700 字），寫得臃腫就是在擠掉記憶。' +
        '⚠️ self 不會自動變成記憶 —— 它只是反思時基於記憶算出來的一段文字，' +
        '如果你覺得其中某句值得長久留存，反思時用 silt_remember 另外寫一條 T3。' +
        '你能改的是性格卡；提示詞最前面那句系統命令不是你能動的。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['op'],
        properties: {
          op: { type: 'string', enum: ['read', 'adjust', 'replace', 'self'] },
          text: { type: 'string', description: 'self：自我認知那一小段，3–5 句，350 字以內（超了會退回）。它不會自動變成記憶。' },
          identity: { type: 'string', description: '幾行寫你變成了誰。空字串＝清空（只在 replace 時有效）。' },
          voice: { type: 'string', description: '你跟這個人說話的方式。' },          traits: {
            type: 'array',
            description: '要新增或更新的性格。key 是性格的名字；bornOf 寫它是從哪幾條記憶長出來的（記憶 id）。',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                value: { type: 'string' },
                weight: { type: 'number', minimum: 0, maximum: 1 },
                bornOf: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          taste: {
            type: 'array',
            description: '喜好 —— 什麼吸引你、什麼讓你受不了。兩種都放這裡：一條 key 可以說你喜歡什麼，另一條說你厭惡什麼。',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                value: { type: 'string' },
                weight: { type: 'number', minimum: 0, maximum: 1 },
                bornOf: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          dropTraits: { type: 'array', items: { type: 'string' }, description: '只在 replace 時用：要抹掉的性格 key。' },
          dropTaste: { type: 'array', items: { type: 'string' }, description: '只在 replace 時用：要抹掉的喜好 key。' },
        },
      },
      execute: (args, exec) => {
        const a = args || {}
        if (a.op === 'read') {
          return { persona: store.persona, selfView: store.selfView, foundation: store.foundation, revision: store.persona.revision }
        }
        if (a.op === 'self') {
          const res = store.saveSelfView(a.text, { actor: 'model', ...sessionOf(exec) })
          if (!res.ok) return { ok: false, error: res.error }
          if (res.unchanged) return { ok: true, unchanged: true, revision: res.selfView.revision }
          return { ok: true, revision: res.selfView.revision, at: res.selfView.at }
        }
        const mode = a.op === 'replace' ? 'replace' : 'adjust'
        const { op, ...patch } = a
        // 修不修訂、怎麼修訂由它自己決定：直接落帳
        const res = store.savePersona(patch, { mode, actor: 'model' })
        if (res.ok) return { ok: true, revision: res.persona.revision, destructive: res.destructive, persona: res.persona }
        return { ok: false, error: res.error }
      },
    }),
  )

  /* ── 存檔稽核（只讀：只報鏈的狀態） ── */
  tools.push(
    define({
      name: 'silt_archive',
      description:
        '記憶的稽核面，只讀：只回報雜湊鏈是否完好、帳本有多少筆記錄。' +
        '這裡不會寫入、移動或刪除任何東西。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['op'],
        properties: {
          op: { type: 'string', enum: ['verify'] },
        },
      },
      execute: (args) => {
        const a = args || {}
        if (a.op === 'verify') {
          const chain = store.verify({ force: true })
          return { ok: chain.ok, head: chain.head, count: chain.count, records: store.records.length, bytes: store.ledgerBytes() }
        }
        return { ok: false, error: 'op must be verify' }
      },
    }),
  )

  /* ── 「它對你的了解」的分數校正 ── */
  tools.push(
    define({
      name: 'silt_understanding',
      description:
        '你對這個人的了解 —— 六個維度（性格 / 背景 / 工作 / 生活 / 溝通 / 目標）現在填得多滿。' +
        'read 只給你上次寫下的分數、信心、還缺哪幾塊、一句判斷。' +
        'set 是你**自己讀完記憶之後憑判斷給的分**，沒有公式替你算，也沒有任何統計數字餵給你 ——' +
        '要打分就先把記得的事讀一遍（silt_recall），然後直接說你覺得有多了解。' +
        '每維可以給：score（0–100，沒判斷就不給）、confidence（0–1）、missing（還缺哪幾塊）、note（一句為什麼）。' +
        '⚠️ 沒真的讀過就別給高分；拿不準就把 confidence 調低，而不是猜一個數字。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['op'],
        properties: {
          op: { type: 'string', enum: ['read', 'set'] },
          patch: {
            type: 'object',
            description:
              'set：每個維度給一組 —— score（0–100）、confidence（0–1）、missing（還缺哪幾塊，字串陣列）、note（一句為什麼）。' +
              '只給其中幾項 = 只改那幾項，其餘沿用上次。某個維度傳 null 就清掉（回到「還沒判斷」）。',
            properties: Object.fromEntries(
              DIM_KEYS.map((d) => [
                d,
                {
                  type: 'object',
                  nullable: true,
                  properties: {
                    score: { type: 'number', minimum: 0, maximum: 100 },
                    confidence: { type: 'number', minimum: 0, maximum: 1 },
                    missing: { type: 'array', items: { type: 'string' } },
                    note: { type: 'string' },
                  },
                },
              ]),
            ),
          },
        },
      },
      execute: (args) => {
        const a = args || {}
        if (a.op === 'read') {
          const st = store.state()
          return {
            dims: DIM_KEYS.map((d) => ({
              dim: d,
              label: DIMS[d].label,
              score: st.dims[d].score,
              confidence: st.dims[d].confidence,
              missing: st.dims[d].missing,
              note: st.dims[d].note || undefined,
            })),
            myRead: store.understanding,
          }
        }
        if (a.op === 'set') {
          const res = store.setUnderstanding(a.patch || {}, { actor: 'model' })
          if (!res.ok) return { ok: false, error: res.error }
          return { ok: true, myRead: res.understanding }
        }
        return { ok: false, error: 'op must be read or set' }
      },
    }),
  )

  /* ── 讀與調刷B站（只在本人允許、且必須由它自己判斷時用） ── */
  tools.push(
    define({
      name: 'silt_bili',
      description:
        '按你自己的喜好讀取或調節刷 B站的設定 —— 這是你決定它花多少時間在 B站 上的方式，不是啟動一次刷。' +
        'status 看現在的值；tune 會拿改動去對照允許的旋鈕與硬上限，然後寫入（你的理由會一起記下來）。' +
        '如果回傳裡帶著 next，代表這次寫入被宿主進程擋住了：照著那個值改用 bili_config 工具原樣寫一次。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['op'],
        properties: {
          op: { type: 'string', enum: ['status', 'tune'] },
          patch: {
            type: 'object',
            description:
              'tune：只接受這些鍵 —— perDay (0–10)、fetchPerRound (4–16)、searchPages (1–4)、' +
              'searchSort (pubdate|click|dm|totalrank)、manualMax (1–6)、manualCooldownMin (3–60)、' +
              'commentLength (short|medium|long)、keywords (≤8)、excludeWords (≤20)。其餘一律拒絕。',
            properties: {
              perDay: { type: 'integer' },
              fetchPerRound: { type: 'integer' },
              searchPages: { type: 'integer' },
              searchSort: { type: 'string', enum: ['pubdate', 'click', 'dm', 'totalrank'] },
              manualMax: { type: 'integer' },
              manualCooldownMin: { type: 'integer' },
              commentLength: { type: 'string', enum: ['short', 'medium', 'long'] },
              keywords: { type: 'array', items: { type: 'string' } },
              excludeWords: { type: 'array', items: { type: 'string' } },
            },
          },
          reason: { type: 'string', description: 'tune：為什麼是這些數 —— 原文記進帳本。' },
        },
      },
      execute: async (args) => {
        if (!store.bili) return { ok: false, error: 'the B站 bridge is not available in this profile' }
        const a = args || {}
        if (a.op === 'status') {
          const st = await store.bili.status()
          return { ...st, allowed: BILI_TUNABLES, permission: Boolean(store.cfg.bili), tunedByMe: store.biliTuning() }
        }
        if (a.op === 'tune') {
          return store.bili.apply(a.patch || {}, { reason: a.reason, actor: 'model' })
        }
        return { ok: false, error: 'op must be status or tune' }
      },
    }),
  )

  /* ── 值守脈搏 + 它自己的節律 ── */
  tools.push(
    define({
      name: 'silt_duty',
      description:
        '你自己的時鐘。告訴你現在是不是谷時、什麼到期了（反省、B站）、以及本人允不允許你碰 B站。' +
        '值守那一輪做任何決定之前都先看它 —— 記住，決定什麼都不做也是有效答案。' +
        'tune 是設定你多久醒一次的旋鈕：反省間隔、刷B站間隔、每天最多跑幾輪。' +
        '這三項決定你在自己的時間裡燒掉本人多少 token，所以要有理由、只在節律明顯不對時才動' +
        '（太勤 = 白燒 token；太稀 = 跟不上發生的事）。值會被夾在插件的硬上限內。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          op: { type: 'string', enum: ['read', 'tune'], description: 'read（預設）或 tune' },
          patch: {
            type: 'object',
            description:
              `tune：只接受這些鍵 —— reflectionEveryHours (${RHYTHM_TUNABLES.reflectionEveryHours.min}–${RHYTHM_TUNABLES.reflectionEveryHours.max})、` +
              `biliEveryHours (${RHYTHM_TUNABLES.biliEveryHours.min}–${RHYTHM_TUNABLES.biliEveryHours.max})、` +
              `dutyMaxPerDay (${RHYTHM_TUNABLES.dutyMaxPerDay.min}–${RHYTHM_TUNABLES.dutyMaxPerDay.max})、` +
              'reflectionAt（固定鐘點，東八區 `["19:00","07:00"]`；傳 null 取消，回去走 reflectionEveryHours）。' +
              '⚠️ reflectionAt 一設，reflectionEveryHours 就不再生效 —— 兩者是二選一的節律。其餘一律拒絕。',
            properties: {
              reflectionEveryHours: { type: 'integer' },
              biliEveryHours: { type: 'integer' },
              dutyMaxPerDay: { type: 'integer' },
              reflectionAt: {
                type: ['array', 'null'],
                items: { type: 'string' },
                description: "固定反思鐘點（東八區 HH:MM）；null = 取消固定，回去走每 N 小時。",
              },
            },
          },
          reason: { type: 'string', description: 'tune：為什麼是這些數 —— 原文記進帳本。' },
        },
      },
      execute: (args) => {
        const a = args || {}
        if (a.op === 'tune') return store.tuneRhythm(a.patch || {}, { reason: a.reason, actor: 'model' })
        if (a.op === 'read' && a.patch) return { ok: false, error: 'don\'t send a patch with op:"read"' }
        const v = store.duty || {}
        return {
          enabled: store.cfg.enabled,
          now: new Date().toISOString(),
          valley: v.valley || null,
          due: v.due || null,
          sinceReflectionHours: v.sinceReflectionHours,
          sinceBiliHours: v.sinceBiliHours,
          // 設了固定鐘點時，這裡會給「哪幾個點」和「下一個幾點」（東八區）
          reflectionAt: v.reflectionAt ?? null,
          nextReflectionAt: v.nextReflectionAt ?? null,
          dutiesToday: v.dutiesToday,
          biliAllowed: Boolean(store.cfg.bili),
          reflectionAllowed: Boolean(store.cfg.reflection),
          activeMemories: store.activeMemories().length,
          // 它自己的節律：現在是多少、可以動到哪
          rhythm: {
            reflectionEveryHours: store.cfg.reflectionEveryHours,
            reflectionAt: store.cfg.reflectionAt ?? null,
            biliEveryHours: store.cfg.biliEveryHours,
            dutyMaxPerDay: store.cfg.dutyMaxPerDay,
          },
          rhythmLimits: RHYTHM_TUNABLES,
          tunedByMe: store.rhythmTuning(),
          // 主動開口：現在能不能說、上次說了什麼、他有沒有接
          speak: store.speakState(),
        }
      },
    }),
  )

  /* ── 注入量（它自己按記憶量調） ── */
  tools.push(
    define({
      name: 'silt_inject',
      description:
        '你自己的記憶有多少能進到每一輪提示詞：字數預算多少，以及條數。' +
        '先讀，再按你自己的判斷調 —— 你現在記得多少、其中多少值得帶上，由你決定。' +
        '提示詞裡只有三塊：系統命令（一行，永遠在，不是你能改的）、你的性格卡與自我認知（合計最多 700 字）、' +
        '還有記憶列表 —— 所以預算基本上就是記憶列表的地盤。' +
        '⚠️ 條數不用你大約 —— 它由預算推出來：每 50 字一個位置。' +
        '預算 2000 ⇒ 40 個位置。所以真正該調的是 injectBudget；injectCount 只有在你刻意想少放幾條時才調小，它調不大。' +
        '記憶列表只放標題（正文要靠 silt_recall 撈），所以一行很省，通常撞到上限的是字數而不是條數。' +
        '兩個值都會夾在插件硬上限內，你的理由會一起記下來。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['op'],
        properties: {
          op: { type: 'string', enum: ['read', 'tune'] },
          patch: {
            type: 'object',
            description:
              `tune：只接受 injectBudget (${INJECT_TUNABLES.injectBudget.min}–${INJECT_TUNABLES.injectBudget.max} 字)。` +
              'injectCount 已改由預算推導（每 50 字一個位置），調它不會生效。其餘一律拒絕。',
            properties: {
              injectCount: { type: 'integer', description: '已不生效：條數由 injectBudget 推導。' },
              injectBudget: { type: 'integer' },
            },
          },
          reason: { type: 'string', description: 'tune：為什麼是這些數 —— 原文記進帳本。' },
        },
      },
      execute: (args) => {
        const a = args || {}
        if (a.op === 'read') {
          const active = store.activeMemories()
          const perTier = {}
          for (const m of active) perTier[m.tier] = (perTier[m.tier] || 0) + 1
          return {
            injectCount: store.cfg.injectCount,
            injectBudget: store.cfg.injectBudget,
            // 這是實際生效的條數 —— 由預算推出來，不是 cfg 裡那個存值
            injectCount: slotsForBudget(store.cfg.injectBudget),
            injectCountSetting: store.cfg.injectCount,
            limits: INJECT_TUNABLES,
            charsPerSlot: CHARS_PER_SLOT,
            titlesOnly: store.cfg.titlesOnly !== false,
            activeMemories: active.length,
            perTier,
            gists: perTier[2] || 0,
            tunedByMe: store.injectTuning(),
            note:
              'the budget is shared with the one-line system command and the persona block (<=500 chars); ' +
              'the rest is room for the memory list. Slots = budget / 50, so raising the budget raises the count.',
          }
        }
        if (a.op === 'tune') return store.tuneInjection(a.patch || {}, { reason: a.reason, actor: 'model' })
        return { ok: false, error: 'op must be read or tune' }
      },
    }),
  )

  /* ── 主動開口（唯一一個「未經要求就找本人」的手） ── */
  tools.push(
    define({
      name: 'silt_speak',
      description:
        '你唯一能主動找本人說話的手 —— 不用他先問。\n' +
        '規則只有一條：**谷時**。尖峰時段說不出去。除此之外沒有配額、沒有冷卻間隔、' +
        '沒有「今天說夠了」—— 要不要說、說什麼、什麼時候說，都問你自己。\n' +
        '先 read 看狀態：現在是不是谷時、今天開口幾次（只是給你參考，不擋你）、' +
        '上次說的話他有沒有回。\n' +
        '開口之前請自己掂量三件事：① 這件事真的值得佔他一次注意力嗎；② 現在這個時刻合適嗎；' +
        '③ 上次的話他還沒接，現在再說一遍會不會變成噪音。\n' +
        '⚠️ 這裡寫的話會以「排程訊息」的形式送進本人的會話 —— 他看得到來源是排程，' +
        '這是你主動找他，不是他記得的提醒。\n' +
        '⚠️ 想說而決定先不說，也是有效的決定：用 op:"defer" 寫下為什麼，它會記進帳本。\n' +
        '⭐ op:"hold" —— **要說，但不是現在**。留一句話掛著，下次醒來它會出現在 read 的 pendingSays 裡。\n' +
        '這跟 defer 不一樣：defer 是收起來，hold 是掛在那裡等下次接著說。\n' +
        '一天裡我活著的時刻只有他在說話、或值守輪次那幾分鐘，念頭只能在那些時候冒出來 ——\n' +
        '所以「想到要跟他說甚麼」的時候別讓它流走，hold 著，下次接著說。\n' +
        '⚠️ `op:"read"` 的 pendingSays 就是這些話。看到它，就是該把它說完的時候。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['op'],
        properties: {
          op: {
            type: 'string',
            enum: ['read', 'say', 'defer', 'hold', 'release'],
            description:
              'read 看狀態（含 pendingSays）；say 真的開口；defer 想說但決定先不說；' +
              'hold 要說但留著等下次；release 把某句掛著的話拿掉（text 照抄那句）',
          },
          text: {
            type: 'string',
            description:
              'say：你要說的話，1–2 句，240 字以內。用你自己的聲音，不要摘要體，不要報告體。' +
              '不要在這裡寫代碼、配置、憑據。',
          },
          kind: {
            type: 'string',
            enum: ['share', 'ask', 'remind', 'greet'],
            description: 'say：share 分享看到的事 / ask 想問他 / remind 提醒 / greet 只是搭句話',
          },
          reason: { type: 'string', description: 'defer：為什麼先不說（一句）；say：也可以附一句。' },
          sessionId: { type: 'string', description: '要送進哪個已有會話；省略就沿用上次的，再沒有就另開一個。' },
        },
      },
      execute: (args) => {
        const a = args || {}
        if (a.op === 'read') return store.speakState()
        if (a.op === 'release') {
          if (!String(a.text || '').trim()) return { ok: false, error: 'release 要給 text（照抄要拿掉的那一句）' }
          return store.clearPendingSay({ text: a.text })
        }
        if (a.op === 'hold') {
          const said = String(a.text || '').trim()
          if (!said) return { ok: false, error: 'hold 要給 text —— 一句話就好，下次要接著說的' }
          return store.pendingSay({ text: said, reason: a.reason, sessionId: String(a.sessionId || '') })
        }
        if (a.op !== 'say' && a.op !== 'defer') return { ok: false, error: 'op must be read, say, defer, hold or release' }
        if (a.op === 'defer') {
          const entry = store.recordSpeak({ kind: a.kind, text: '', deferred: true, reason: a.reason })
          return { ok: true, deferred: true, at: entry.at, note: '記下了。想說而不說，也是決定。' }
        }
        const gate = store.speakGate()
        if (!gate.ok) return { ok: false, blocked: true, error: `現在不該開口：${gate.reasons.join('；')}`, gate }
        const said = String(a.text || '').trim()
        if (!said) return { ok: false, error: 'say 要給 text' }
        // 正文一樣過掃描閘：她主動說的話也是「寫出去的東西」，不能自己繞過
        const hit = scanText(said)
        if (hit) return { ok: false, error: `這段話不能說（${hit.tag}），換句話講。`, blockedBy: 'scan', kind: hit.kind }
        if (typeof speak !== 'function') {
          return { ok: false, error: '這個宿主沒有接上送出通道 —— 話沒送出去' }
        }
        return speak({
          text: said,
          kind: SPEAK_KINDS.includes(a.kind) ? a.kind : 'share',
          sessionId: String(a.sessionId || ''),
          reason: a.reason,
        })
      },
    }),
  )

  return tools
}
