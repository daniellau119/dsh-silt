/**
 * 提示詞分層：系統提示裡每一塊各佔多少字。
 *
 * 只讀。它不改變注入的任何一個字。
 *
 * ⚠️ 2026-11-24 的教訓：前幾版都是「照著 renderInjection 的邏輯再寫一遍」，
 *    結果每一組都差 1～300 字。差在哪不重要，重要的是那個做法本身錯：
 *    兩份算法各自演化，遲早會分岔。**圖上的數字要對的，是同一份產物。**
 *
 * 所以現在的做法是：**真的跑一次 renderInjection**（用跟 store 一模一樣的參數），
 * 拿到那段真實的字串，然後在它上面「量」每一塊的位置與長度。
 *
 * 拿位置的方式不是正則亂猜，而是按 renderInjection 的組裝順序一路掃過去：
 *   系統命令 → 自我認知塊（可缺） → 【仍記得的】 → 記憶行… → 「另有 N 條」
 * 每一塊掃完就往前推，掃不到就停在原地並記下一個 note —— 不假裝成功。
 *
 * 這樣長度必然相等：因為加總的就是那串字本身。
 *
 * @module dsh-silt/lib/injection-breakdown
 */
import { renderInjection, foundationText, oneLine, slotsForBudget, INJECT_PERSONA_MAX } from './model.js'

/**
 * 自我認知那塊的硬頂，**直接引用 model.js 的常數**。
 *
 * ⚠️ 2026-11-25（本人）：這裡原本寫死 `const PERSONA_MAX = 700`。
 *    這個檔案的整個前提就是「不要有第二份數字」—— 寫死一份就是第二份。
 */
const PERSONA_MAX = INJECT_PERSONA_MAX

const DIGEST_TITLE = '【仍記得的】'
const PERSONA_TITLE = '【自我認知】'

/** 那句註腳的前綴；用來在字串裡認出它。 */
const NOTE_PREFIX = '（另有 '

/**
 * 把一段注入文本拆成「哪幾塊、各幾字」。
 *
 * **回傳的 used 就是那段字串的長度**，不是估算 —— 因為它就是在量那段字串。
 */
export function injectionBreakdown({ cfg, foundation, persona, selfView, memories, budget }) {
  const cap = Math.max(600, Number(budget) || 1800)

  // 第一步：跑一次真實渲染。參數跟 store.injectionText() 傳的一模一樣。
  //
  // ⚠️ 2026-11-25（本人）：`titlesOnly` **不收外部參數，跟 store 同一個來源讀**。
  //    舊版簽名就收 titlesOnly，而呼叫端沒傳 ⇒ undefined ⇒ renderInjection 的
  //    預設 false ⇒ 正文模式。但真正注入走的是 `cfg.titlesOnly !== false` ⇒ true ⇒ 標題模式。
  //    於是量到的字串跟真正送出去的不是同一串 —— 這個檔案開頭那段
  //    「兩份算法各自演化，遲早會分岔」的教訓，從參數這一層又發生了一次。
  const titlesOnly = cfg?.titlesOnly !== false
  // 條數也一樣：store 傳的是 slotsForBudget(budget)，這裡照字面用同一個函式。
  //（2026-11-25 之後 renderInjection 自己也算 slots，所以這一步其實已經多餘 ——
  //  留著只是為了讓「這個函式傳的東西」跟 store 一眼對得上。）
  const slots = slotsForBudget(cap)

  let text = ''
  const shownIds = []
  let truncated = false
  try {
    text = renderInjection({
      cfg,
      foundation,
      persona,
      selfView,
      memories,
      budget: cap,
      titlesOnly,
      onShown: (ids) => {
        // ⚠️ renderInjection 硬切時會回空陣列 —— 那是「這一輪什麼都沒完整顯示」的訊號，
        //    不能當成「顯示了 0 條、其餘都 hidden」若無其事地報出去（本人 2026-11-25 指出）。
        if (!Array.isArray(ids) || ids.length === 0) {
          truncated = text.length >= cap
          return
        }
        shownIds.push(...ids)
      },
    }) || ''
  } catch (error) {
    return { budget: cap, used: 0, free: cap, parts: [], error: String(error?.message || error), slots: 0, shown: 0, hidden: 0, rows: [], truncated: false }
  }
  void slots

  // 第二步：在真實字串上量每一塊。
  // ── 量法：從尾巴往前切 ──
  //
  // 2026-11-24 之前我一直在「從頭往後推算每一塊幾個換行」，結果每組都差一兩個字。
  // 換成從尾往前之後就不必猜了：那三段在字串裡是固定順序的尾巴
  //   …【自我認知】\n- 行…\n【仍記得的】\n- 記憶行…\n（另有 N 條…）
  // 所以先認出尾巴那幾塊，剩下開頭那截就是系統命令。
  const parts = []
  let end = text.length

  // 1) 「另有 N 條」：只在字串尾巴出現，而且一定是整段最後一行。
  const noteStart = text.lastIndexOf(`\n${NOTE_PREFIX}`)
  if (noteStart >= 0) {
    const note = text.slice(noteStart + 1)
    parts.push({ key: 'hidden_note', title: '「另有 N 條」註腳', chars: note.length, at: noteStart + 1 })
    end = noteStart + 1
  }

  // 2) 記憶行：從「【仍記得的】\n」之後，到上面切剩的尾巴為止。
  const digestAt = text.lastIndexOf(DIGEST_TITLE, end)
  let memStart = -1
  if (digestAt >= 0) {
    // 標題本身 + 它前面那個換行（若有）算在「標題」這一塊。
    const lead = digestAt > 0 && text[digestAt - 1] === '\n' ? 1 : 0
    parts.push({ key: 'digest_title', title: '【仍記得的】標題', chars: lead + DIGEST_TITLE.length, at: digestAt - lead })
    memStart = digestAt + DIGEST_TITLE.length
    // 標題後面那個換行屬於下一塊（第一條記憶的開頭），不算在標題裡。
    const memChars = end - memStart
    if (memChars > 0) {
      const block = text.slice(memStart, end)
      const lines = block.split('\n').filter((l) => l !== '')
      parts.push({ key: 'memory', title: `記憶標題（${lines.filter((l) => l.startsWith('- T')).length} 行）`, chars: memChars, at: memStart })
      for (const line of lines) {
        if (!line.startsWith('- T')) continue
        parts.push({ key: 'memory_line', title: line.slice(0, 28), chars: line.length })
      }
    }
    end = digestAt - lead
  }

  // 3) 自我認知塊：在記憶之前那一截裡，從「【自我認知】」到塊結束。
  const whoAt = text.lastIndexOf(PERSONA_TITLE, end)
  if (whoAt >= 0) {
    const lead = whoAt > 0 && text[whoAt - 1] === '\n' ? 1 : 0
    const block = text.slice(whoAt, end)
    const rows = block.split('\n').filter((l) => l.startsWith('- '))
    const firstLine = block.indexOf('- ')
    // ⚠️ 2026-11-25（本人）：舊版寫 `lead + PERSONA_TITLE.length + frame`，而
    //    **frame 已經包含標題長度和那個換行**（frame = - 在 block 裡的索引，block 從標題開始）。
    //    再加一次標題長度就是多算 6 字。
    //    同時行與行之間的換行沒被算進去（frame 只吃到「標題 → 第一條」那一個換行），
    //    n 條時淨差 6 - (n-1)。
    //
    //    現在照記憶那塊的方式：**整段量**，逐條明細只當子項（不重複計入加總）。
    const frame = firstLine >= 0 ? firstLine : block.length
    const personaSpan = end - (whoAt - lead)   // 整塊（含前導換行）的真實長度
    parts.push({ key: 'persona_title', title: '【自我認知】標題', chars: lead + frame, at: whoAt - lead })
    // 逐條明細：每條 = 行內容 + 它自己的換行（最後一條不加）。
    // 這些是子項，不進 covered 加總（見下面的 filter）。
    rows.forEach((line, i) => {
      const tail = i < rows.length - 1 ? 1 : 0
      parts.push({ key: 'persona_line', title: line.slice(2, 22) || '（空）', chars: line.length + tail })
    })
    // 用整段長度校正：標題那塊吃掉的 frame 之後，剩下的都算進「各行」的總帳。
    // 這裡不改逐條數字（它們是給人看的），只把**加總**用整段長度保證正確。
    parts.push({ key: 'persona_total', title: '（自我認知整塊）', chars: personaSpan, at: whoAt - lead, summary: true })
    end = whoAt - lead
  }

  // 4) 剩下開頭那截就是系統命令（沒有就是 0）。
  if (end > 0) {
    parts.push({ key: 'foundation', title: '系統命令', chars: end, at: 0 })
  }
  parts.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))

  // 「沒掃乾淨」只算**頂層塊**的加總。
  //
  // ⚠️ 2026-11-25：原本的 filter 只排除了 memory_line，卻**保留了 persona_line** ——
  //    逐條明細是那一塊的子項，跟它本身重疊，算進去會出現大負數。
  //    現在三種子項一起排除：memory_line / persona_line / persona_total。
  //
  // 頂層塊的組成（互不重疊、加起來就是整串）：
  //   系統命令 + 【自我認知】標題(frame) + 自我認知各行 + 【仍記得的】標題 + 記憶 + 註腳
  // 其中「自我認知各行」不逐條列（它們相加 = personaSpan - frame），用一行匯總表示。
  const covered = parts
    .filter((p) => p.key !== 'memory_line' && p.key !== 'persona_line' && p.key !== 'persona_total')
    .reduce((n, p) => n + p.chars, 0)
  // 自我認知各行那一截：整塊減掉標題吃掉的 frame。這是它在加總裡該佔的量。
  const personaBodyAt = parts.find((p) => p.key === 'persona_total')
  const personaTitleAt = parts.find((p) => p.key === 'persona_title')
  const personaBodyChars = personaBodyAt && personaTitleAt ? Math.max(0, personaBodyAt.chars - personaTitleAt.chars) : 0
  const residual = text.length - (covered + personaBodyChars)

  // 條數：從真實注入的 shownIds 拿，不用自己再推一遍。
  const count = shownIds.length

  return {
    budget: cap,
    used: text.length,
    free: cap - text.length,
    over: Math.max(0, text.length - cap),
    parts,
    residual,
    slots: count,
    shown: count,
    hidden: (memories || []).filter((m) => !m.voided).length - count,
    rows: (memories || []).filter((m) => !m.voided && shownIds.includes(m.id)).map((m) => ({
      id: m.id, title: m.title, tier: m.tier,
      chars: oneLine(m.title, 54).length,
    })),
    personaMax: PERSONA_MAX,
    // ⚠️ 2026-11-25（本人）：硬切發生時，最後一行是半句 —— 上面的行長度量到的
    //    那一行其實是殘的。要明說，不然圖上看不出這份數據不可信。
    truncated,
  }
}
